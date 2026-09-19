/**
 * 会话内容 store。
 * 对应开发文档 5.3 与 6.x。
 *
 * 设计要点：
 *   - 状态用 reactive 包裹 ConversationState，让 Vue 做**细粒度**更新：
 *     只有变化的 block 会重渲染，不是整棵消息树。
 *   - 所有事件经 eventReducer.applyEvent 路由，组件永不直接消费服务端事件。
 *   - 流式文本的 markdown 渲染在 MarkdownBlock 组件内用 rAF 节流；
 *     这里只做轻量的 raw 字符串累积。工具状态/权限/回合完成**不节流**。
 */

import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import {
  clearMessages,
  clearWaitingPermission,
  createConversationState,
  finishTurn as finishTurnReducer,
  markCancelling,
  markWaitingPermission,
  restoreCancelling,
  newTurn,
  settleReplayed,
  setToolWaiting,
  startTurnTimer,
  addSystem,
  markLocalEcho,
  type ConversationState,
  type Turn,
} from '../domain/turnReducer.ts';
import { applyEvent } from '../domain/eventReducer.ts';
import { parseServerMessage } from '../protocol/guards.ts';
import type { ConfigOption, ServerMessage } from '../protocol/types';

export const useConversationStore = defineStore('conversation', () => {
  const state = reactive<ConversationState>(createConversationState());

  /**
   * 本页有 prompt 在飞的**会话集合** —— 发送/取消按钮的判据。
   *
   * 等价于原实现的模块级 busy（doSend 开头置 true、finally 置 false），
   * 但必须按会话记录而不是用一个全局布尔：prompt 可能被「暂不处理」交回
   * 电脑端后长期悬挂，若用全局标志，切到另一个会话时那个会话会误显示为
   * 「取消」，而且 cancel 取的是当前会话 id —— 会把取消发到错误的会话上。
   *
   * 也不能用「当前回合是否 running」代替：会话初始化等非本页发起的事件也会
   * 建出回合，一旦它长期停在 running，一进会话按钮就会是取消态，首次点击
   * 会误发 session/cancel（新会话上该命令返回 Internal error）。
   */
  const inFlightTurns = ref(new Map<string, string>());

  /** 当前会话是否处于「执行中」态（发送按钮据此切换为取消按钮）。 */
  const running = computed(
    () => state.sessionId != null && inFlightTurns.value.has(state.sessionId)
  );

  /** 标记/清除某个会话的 prompt 在飞状态，并用 turnId 防止旧请求清掉新回合。 */
  function setPromptInFlight(sessionId: string, inFlight: boolean, turnId?: string): void {
    if (inFlight) {
      if (!turnId) return;
      inFlightTurns.value.set(sessionId, turnId);
      return;
    }
    if (!turnId || inFlightTurns.value.get(sessionId) === turnId) {
      inFlightTurns.value.delete(sessionId);
    }
  }

  /** turnEnd 没有回传前端 turnId，只能清除该会话当前 prompt；旧 finally 仍受 turnId 守卫。 */
  function clearPromptInFlight(sessionId: string): void {
    inFlightTurns.value.delete(sessionId);
  }

  /**
   * 本页**正在发起**的 session.load 计数（按会话）。
   *
   * 回放帧（replay:true）是 session.load 的历史重放结果，属于发起该命令的
   * 那个连接，不是会话的实时活动。只有本页自己正在加载该会话时到达的回放帧
   * 才属于本页投影；其他来源（其他设备的 load、越界的迟到帧）必须整帧忽略 ——
   * 它们既带整段历史（会清空已显示内容、把页面按在回放态），也带历史 turnEnd
   * （会把本页正在运行的回合误判为已结束）。
   *
   * 按会话判而不是按「当前查看的会话」判：回放帧可能在列表页到达（那时没有
   * 当前会话），也可能是别页 load 带来的其他会话历史。
   *
   * 用计数而不是布尔：重连重同步与用户手动载入可能重叠，先结束的那个
   * 不应摘掉仍在飞的那次归属。
   */
  const replayLoads = new Map<string, number>();

  /** 开始发起 session.load。必须在发请求之前调用：回放帧先于应答到达。 */
  function beginReplayLoad(sessionId: string): void {
    replayLoads.set(sessionId, (replayLoads.get(sessionId) ?? 0) + 1);
  }

  /** session.load 已结束（应答或异常）。计数归零即不再接受该会话的回放帧。 */
  function endReplayLoad(sessionId: string): void {
    const n = replayLoads.get(sessionId) ?? 0;
    if (n <= 1) replayLoads.delete(sessionId);
    else replayLoads.set(sessionId, n - 1);
  }

  /**
   * 这条事件是否是**不属于本页**的历史回放帧。
   *
   * 判据同时要求「是回放帧」「不是 resume 补发帧」「该会话没有本页正在发起的
   * load」—— 缺一都不成立：resume 补发帧虽复用回放块语义，但它是实时增量的
   * 补偿，必须照常落地。
   *
   * 形参用宽松结构（replay/resume 为 unknown）：调用方手里是 ServerEvent 联合
   * 类型，其中 governance 带索引签名，窄类型会让它无法传入。
   */
  function isForeignReplay(
    sessionId: string | null | undefined,
    event: { replay?: unknown; resume?: unknown } | null | undefined
  ): boolean {
    if (!event || event.replay !== true || event.resume === true) return false;
    if (!sessionId) return true;
    return (replayLoads.get(sessionId) ?? 0) === 0;
  }

  /** 是否已有可见内容（用于空状态提示）。 */
  const isEmpty = computed(() => state.items.length === 0);

  const turns = computed(() => state.items.filter((i): i is Turn => i.type === 'turn'));

  /** 当前进行中的回合（等价于原实现的 curTurn）。 */
  const activeTurn = computed<Turn | null>(() => {
    const id = state.activeTurnId;
    if (!id) return null;
    for (let i = state.items.length - 1; i >= 0; i--) {
      const it = state.items[i];
      if (it.type === 'turn' && it.id === id) return it;
    }
    return null;
  });

  /** 取消中的回合（用于发送按钮切换为停止态）。 */
  const cancelling = computed(() => activeTurn.value?.status === 'cancelling');

  /** 是否正在等待权限确认（回合与工具行附近需要明确视觉状态）。 */
  const waitingPermission = computed(() => activeTurn.value?.status === 'waiting-permission');

  /** 打开一个会话：重置换投影。调用方随后发 session.load。 */
  function openSession(sessionId: string): void {
    clearMessages(state);
    state.sessionId = sessionId;
    state.replaying = false;
  }

  /** 关闭会话投影（返回列表页时保留内容，仅在切换会话时清空）。 */
  function reset(): void {
    clearMessages(state);
    state.sessionId = null;
    state.replaying = false;
  }

  /** 追加回合外的系统提示。 */
  function sys(text: string, level: 'sys' | 'err' = 'sys'): void {
    addSystem(state, text, level);
  }

  /** 本页发送一条消息：开新回合、写用户气泡、记录待跳过的回显文本。 */
  function appendLocalUserMessage(sessionId: string, text: string): string | null {
    state.sessionId = sessionId;
    const turn = newTurn(state);
    turn.userMessage = { id: 'local_' + turn.id, text };
    markLocalEcho(state, text);
    startTurnTimer(state);
    return turn.id;
  }

  /**
   * 路由一条服务端消息。
   *
   * deps 全部可选透传：onTitle（session-info 标题）、onMode/onCommands
   * （模式与斜杠命令，由 bootstrap 注入到 config store）。
   *
   * @returns 是否有可见内容变化（调用方据此决定滚动策略）
   */
  function applyServerMessage(
    msg: ServerMessage,
    deps: {
      isChatView: () => boolean;
      absorbConfigOptions?: (o: ConfigOption[]) => void;
      onTitle?: (title: string) => void;
      onMode?: (modeId?: string) => void;
      onCommands?: (commands: unknown[]) => void;
    }
  ): boolean {
    // 契约 v2：resume 补发帧按 seq 防重复 —— 已见过的序号直接跳过；live 帧不判断。
    if (msg.type === 'event' && msg.event.resume && msg.seq && msg.seq <= state.lastSeq) {
      return false;
    }
    if (msg.type !== 'event') return false;
    // 不属于本页的历史回放帧整帧丢弃（见 replayLoads 注释）：不清空投影、
    // 不置回放态，也不让历史 turnEnd 收尾本页正在运行的回合。
    if (isForeignReplay(msg.sessionId, msg.event)) return false;
    const outcome = applyEvent(state, msg.sessionId, msg.event, {
      isChatView: deps.isChatView,
      isActiveSession: (sid) => !!sid && sid === state.sessionId,
      onMuxClosed: () => {
        // mux 断开与当前会话无关；提示由 UI 层通过订阅 status/event 得到
      },
      onTitle: (title) => {
        // 标题更新由 session store 持有：注入则转发，未注入保持空操作
        deps.onTitle?.(title);
      },
      onMode: deps.onMode,
      onCommands: deps.onCommands,
      absorbConfigOptions: deps.absorbConfigOptions,
    });
    if (msg.seq) state.lastSeq = msg.seq;
    return outcome.contentChanged;
  }

  /** 回合收尾。只允许收尾指定会话和回合，避免旧异步请求误收尾新回合。 */
  function finish(
    reason?: 'completed' | 'cancelled' | 'failed',
    sessionId?: string,
    turnId?: string,
    authoritative = false
  ): boolean {
    if (sessionId !== undefined && state.sessionId !== sessionId) return false;
    if (turnId !== undefined && state.activeTurnId !== turnId) return false;
    finishTurnReducer(state, reason, authoritative);
    return true;
  }

  /** session.load 完成后显式收尾（历史末回合没有实时 turnEnd）。 */
  function settle(): void {
    settleReplayed(state);
  }

  /** 用户点击停止：进入 cancelling，等 turnEnd.stopReason 确认。 */
  function beginCancel(sessionId?: string, turnId?: string): boolean {
    if (sessionId !== undefined && state.sessionId !== sessionId) return false;
    if (turnId !== undefined && state.activeTurnId !== turnId) return false;
    markCancelling(state);
    return true;
  }

  /** 取消命令发送失败：恢复指定回合的可运行状态。 */
  function restoreCancel(sessionId?: string, turnId?: string): boolean {
    if (sessionId !== undefined && state.sessionId !== sessionId) return false;
    if (turnId !== undefined && state.activeTurnId !== turnId) return false;
    restoreCancelling(state);
    return true;
  }

  /** 权限请求到达：只修改指定会话/回合，避免其他会话的权限请求串台。 */
  function markWaiting(sessionId?: string, turnId?: string): boolean {
    if (sessionId !== undefined && state.sessionId !== sessionId) return false;
    if (turnId !== undefined && state.activeTurnId !== turnId) return false;
    markWaitingPermission(state);
    return true;
  }

  /** 权限请求结束：只清理指定会话/回合。 */
  function clearWaiting(sessionId?: string, turnId?: string): boolean {
    if (sessionId !== undefined && state.sessionId !== sessionId) return false;
    if (turnId !== undefined && state.activeTurnId !== turnId) return false;
    clearWaitingPermission(state);
    return true;
  }

  /**
   * 设置某个工具行的权限等待标记（仅当前活动回合范围）。
   * 找不到对应工具行时静默返回 —— 权限可能属于其他会话或已过期的回合。
   */
  function markToolWaiting(toolCallId: string, waiting: boolean): void {
    setToolWaiting(state, toolCallId, waiting);
  }

  /** 解析原始帧（供统一入口使用）。 */
  function ingest(raw: unknown, isChatView: () => boolean, absorb?: (o: ConfigOption[]) => void): boolean {
    const msg = parseServerMessage(raw);
    if (!msg) return false;
    return applyServerMessage(msg, { isChatView, absorbConfigOptions: absorb });
  }

  return {
    state,
    isEmpty,
    turns,
    activeTurn,
    running,
    cancelling,
    waitingPermission,
    openSession,
    reset,
    sys,
    appendLocalUserMessage,
    applyServerMessage,
    ingest,
    beginReplayLoad,
    endReplayLoad,
    isForeignReplay,
    finish,
    settle,
    beginCancel,
    restoreCancel,
    setPromptInFlight,
    clearPromptInFlight,
    markWaiting,
    clearWaiting,
    markToolWaiting,
  };
});
