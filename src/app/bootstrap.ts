/**
 * 应用编排：把连接、会话、内容、配置、权限这些 store 与命令调用串起来。
 *
 * 这里是**唯一的业务动作入口**（发送、加载、新建、取消、切配置、权限应答）。
 * 组件只调用这里暴露的方法，不直接发 WebSocket 命令，也不直接改其他 store。
 */

import { watch } from 'vue';
import { useConnectionStore } from '../stores/connection.ts';
import { useConversationStore } from '../stores/conversation.ts';
import { usePermissionStore } from '../stores/permission.ts';
import { useConfigStore } from '../stores/config.ts';
import { useSessionStore } from '../stores/session.ts';
import { useUiStore } from '../stores/ui.ts';
import { TIMEOUT_NO_LIMIT, TIMEOUT_PERMISSION_MS } from '../composables/useCommandClient.ts';
import type {
  ConfigOption,
  EventMessage,
  GovernanceEvent,
  ServerEvent,
  SessionInfoEvent,
  SessionSummary,
  UnknownUpdateEvent,
} from '../protocol/types.ts';

/**
 * 每次会话切换自增的令牌。
 * session.load 是长请求（最长 120 秒），期间用户可能已经切走 ——
 * 过期响应必须丢弃，否则会把上一个会话的历史写进当前会话。
 */
let loadToken = 0;

/** kind: 'unknown' 的模块级计数：每种 updateType 仅首次 console.warn，后续仅累计次数。 */
const unknownUpdateCounts = new Map<string, number>();

/**
 * 列表页兜底轮询的句柄（模块级持有）。
 * start 只应调用一次；重复调用（HMR 等）先 stop 再启动，避免定时器泄漏。
 */
const LIST_POLL_INTERVAL_MS = 15_000;
let listPollTimer: ReturnType<typeof setInterval> | null = null;
let listPollUnwatch: (() => void) | null = null;
let listPollVisibilityHandler: (() => void) | null = null;

/** governance 事件摘要：优先取已知字段（state/status/text），否则 JSON 截断 200 字符。 */
function governanceSummary(ev: GovernanceEvent): string {
  for (const key of ['state', 'status', 'text'] as const) {
    const v = ev[key];
    if (typeof v === 'string' && v) return v;
  }
  try {
    const s = JSON.stringify(ev);
    if (!s) return '';
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '（不可序列化的治理事件）';
  }
}

/** 事件是否带 replay 标记（mux-closed/governance 等种类没有该字段）。 */
function isReplayFrame(event: ServerEvent): boolean {
  return 'replay' in event && event.replay === true;
}

/** 未知 sessionUpdate：不进 UI；每种 updateType 仅首次告警并说明计数语义。 */
function noteUnknownUpdate(updateType: string): void {
  const n = (unknownUpdateCounts.get(updateType) ?? 0) + 1;
  unknownUpdateCounts.set(updateType, n);
  if (n === 1) {
    console.warn(
      `[kiro-lan-remote] 收到未识别的 sessionUpdate 类型 "${updateType}"（首次出现；同类后续出现仅计数，不再告警）`
    );
  }
}

export function useApp() {
  const conn = useConnectionStore();
  const sessions = useSessionStore();
  const conversation = useConversationStore();
  const permission = usePermissionStore();
  const config = useConfigStore();
  const ui = useUiStore();

  const isChatView = (): boolean => ui.view === 'chat';

  /**
   * 把一份配置按归属会话归档进配置 store（权威来源仍是服务端推送）。
   * 归属取 status 的 configSessionId —— 不再无条件覆盖当前显示。
   */
  function absorbConfigOptions(options: ConfigOption[]): void {
    config.absorbFor(conn.configSessionId, options);
  }

  /**
   * 全会话元数据旁路：在 applyServerMessage（内含当前会话过滤）之前执行，
   * 把事件流里的会话活动投影进 session store，供列表页展示实时标题/状态。
   * 只做记录，不影响后续的当前会话过滤。
   */
  function handleEventBypass(msg: EventMessage): void {
    if (!msg.sessionId) return;
    const sid = msg.sessionId;
    const kind = msg.event.kind;
    if (kind === 'session-info') {
      const ev = msg.event as SessionInfoEvent;
      sessions.applyLiveMeta(sid, { title: ev.title, updatedAt: ev.updatedAt });
      // turnEnd 是「该会话回合已结束」的权威信号
      if (ev.turnEnd) sessions.markLive(sid, 'ended');
      return;
    }
    if (
      (kind === 'assistant-text' ||
        kind === 'user-text' ||
        kind === 'tool-call' ||
        kind === 'tool-call-update' ||
        kind === 'thought') &&
      // session/load 的历史回放不是真实活动；resume 补发帧是（它对应错过的实时内容）
      msg.event.replay !== true
    ) {
      sessions.markLive(sid, 'running');
    }
  }

  /**
   * status 变化驱动 UI 状态点与配置。
   * 只在这里做一次，避免多个入口重复同步。
   */
  function bindStatusToUi(): void {
    watch(
      () => [conn.muxConnected, conn.lastError, conn.configOptions, conn.modelId, conn.modelName] as const,
      () => {
        if (conn.muxConnected) {
          ui.setDot('on');
          ui.connError = null;
        } else {
          // 无 lastError 时是「未连接」而不是「异常」，文案层级不同
          ui.setDot(conn.lastError ? 'err' : 'off');
          if (conn.lastError && ui.view === 'sessions') ui.connError = conn.lastError;
        }
        config.absorbFor(conn.configSessionId, conn.configOptions);
        config.setModel(conn.modelId, conn.modelName);
      },
      { immediate: true }
    );

    // 被查看会话变化 → 配置显示切换到该会话自己的条目（无条目回退 status 值）
    watch(
      () => conversation.state.sessionId,
      (sid) => config.setViewed(sid),
      { immediate: true }
    );
  }

  // ---------- 列表页兜底轮询 ----------

  /** 清理轮询定时器与监听（模块级句柄，重复 start 前必须先清理防泄漏）。 */
  function stopListPolling(): void {
    if (listPollTimer != null) {
      clearInterval(listPollTimer);
      listPollTimer = null;
    }
    if (listPollUnwatch) {
      listPollUnwatch();
      listPollUnwatch = null;
    }
    if (listPollVisibilityHandler) {
      document.removeEventListener('visibilitychange', listPollVisibilityHandler);
      listPollVisibilityHandler = null;
    }
  }

  /**
   * 列表页兜底轮询：仅列表页可见时每 15s 静默刷新；切到会话页即清除。
   * 页面恢复可见时若在列表页，额外立即刷新一次。
   */
  function startListPolling(): void {
    stopListPolling();
    listPollUnwatch = watch(
      () => ui.view,
      (v) => {
        if (v === 'sessions' && listPollTimer == null) {
          listPollTimer = setInterval(() => {
            if (ui.view === 'sessions') void loadSessions(false);
          }, LIST_POLL_INTERVAL_MS);
        } else if (v !== 'sessions' && listPollTimer != null) {
          clearInterval(listPollTimer);
          listPollTimer = null;
        }
      },
      { immediate: true }
    );
    listPollVisibilityHandler = () => {
      if (document.visibilityState === 'visible' && ui.view === 'sessions') void loadSessions(false);
    };
    document.addEventListener('visibilitychange', listPollVisibilityHandler);
  }

  // ---------- 连接 ----------

  function start(key: string): void {
    bindStatusToUi();
    startListPolling();

    conn.subscribe((msg) => {
      if (msg.type === 'event') {
        // 旁路（governance 提示 / unknown 告警 / 会话元数据）在会话过滤之前执行。
        // 不属于本页的历史回放帧（别页的 session.load 重放）整体跳过：
        // 它的 turnEnd 是历史结论，不代表本页有回合刚刚结束。
        const foreignReplay = conversation.isForeignReplay(msg.sessionId, msg.event);
        if (msg.event.kind === 'governance') {
          conversation.sys('治理状态更新：' + governanceSummary(msg.event as GovernanceEvent));
        }
        if (msg.event.kind === 'unknown') {
          noteUnknownUpdate((msg.event as UnknownUpdateEvent).updateType);
        }
        if (!foreignReplay) handleEventBypass(msg);

        conversation.applyServerMessage(msg, {
          isChatView,
          absorbConfigOptions,
          onTitle: (title) => sessions.renameSession(conversation.state.sessionId ?? '', title),
          onMode: (modeId) => {
            if (modeId) config.setModeValue(modeId);
          },
          onCommands: (commands) => config.setCommands(conversation.state.sessionId ?? '', commands),
        });
        if (!isReplayFrame(msg.event) && msg.event.kind === 'session-info' && msg.event.turnEnd && msg.sessionId) {
          // turnEnd 是回合完成的权威信号；即使 prompt 响应尚未返回，
          // 发送按钮也不能继续显示取消态。
          // 历史回放帧例外：它的 turnEnd 描述的是过去某个回合，不代表本页
          // 正在执行的回合已结束（那会把按钮从「取消」误切回「发送」）。
          conversation.clearPromptInFlight(msg.sessionId);
        }
        if (msg.event.kind === 'mux-closed') {
          if (isChatView()) conversation.sys('与 Kiro 的连接已断开，正在重新发现…');
          ui.setDot('err');
        }
        return;
      }

      if (msg.type === 'permission-request') {
        const turnId = conversation.activeTurn?.sessionId === msg.sessionId
          ? conversation.activeTurn.id
          : null;
        const opened = permission.open({
          reqId: msg.reqId,
          sessionId: msg.sessionId,
          turnId,
          toolCall: msg.toolCall,
          options: msg.options,
          // 契约 v2：会话标题透传，供其他会话的权限弹层展示
          sessionTitle: msg.sessionTitle,
        });
        if (opened) {
          // 只有当前正在查看的同一会话才允许进入 waiting 状态；
          // 权限面板仍可提示其他会话，但不能改变当前会话的回合状态。
          if (turnId && conversation.state.sessionId === msg.sessionId) {
            conversation.markWaiting(msg.sessionId, turnId);
            conversation.sys('Kiro 正在请求权限确认。');
          }
        }
        // 契约 v2：工具行的权限等待标记（仅当前会话；行不存在时静默）
        if (msg.toolCall?.toolCallId && conversation.state.sessionId === msg.sessionId) {
          conversation.markToolWaiting(msg.toolCall.toolCallId, true);
        }
        return;
      }

      if (msg.type === 'permission-timeout') {
        const item = permission.handleTimeout(msg.reqId);
        if (item) {
          if (item.turnId) conversation.clearWaiting(item.sessionId, item.turnId);
          if (item.toolCallId) conversation.markToolWaiting(item.toolCallId, false);
          if (conversation.state.sessionId === item.sessionId) {
            conversation.sys('权限请求已超时，已交回电脑端处理。');
          }
        }
        return;
      }

      if (msg.type === 'permission-cleared') {
        // permission-cleared 是会话级信号，只能清理同 session 的请求和回合。
        const item = permission.handleCleared(msg.sessionId);
        if (item) {
          if (item.turnId) conversation.clearWaiting(item.sessionId, item.turnId);
          if (item.toolCallId) conversation.markToolWaiting(item.toolCallId, false);
          if (conversation.state.sessionId === item.sessionId) {
            conversation.sys('该轮已结束，权限弹层已收起。');
          }
        }
        return;
      }
    });

    // 断线重连后重新同步界面状态：会话页先尝试 events.resume 增量补发，
    // 失败或服务端要求重放时退回整段 session.load；列表页维持刷新。
    conn.onReconnect(() => {
      if (isChatView() && conversation.state.sessionId) void resumeCurrentSession();
      else void loadSessions(false);
    });

    conn.connect(key);
    void loadSessions(false);
  }

  // ---------- 会话列表 ----------

  async function loadSessions(manual: boolean): Promise<void> {
    // spinner 只在主动刷新或列表为空时出现，避免每次返回列表都闪一下
    if (manual || !sessions.sessions.length) sessions.loading = true;
    try {
      const r = (await conn.request('sessions.list', {})) as { sessions?: SessionSummary[] };
      sessions.setSessions(r.sessions ?? []);
      // 成功即清除上一次的失败标记，否则错误横幅会一直挂着
      sessions.error = null;
      if (manual) ui.showToast('已刷新');
    } catch (e) {
      const err = e as Error;
      // 已有数据时保留旧列表，但错误必须留存给列表页显示（不能只用 toast，
      // toast 两秒后消失，用户就以为看到的是最新数据了）
      sessions.error = err.message;
    } finally {
      sessions.loading = false;
    }
  }

  // ---------- 打开 / 新建会话 ----------

  async function openSession(s: SessionSummary): Promise<void> {
    const token = ++loadToken;
    sessions.setActive(s.sessionId);
    ui.setView('chat');
    conversation.openSession(s.sessionId);
    conversation.sys('正在载入 ' + s.sessionId + ' …');

    // 必须在发请求之前登记：回放帧先于 load 应答到达，迟了就会把自己的
    // 历史当成「不属于本页的回放」丢掉，页面空着。
    conversation.beginReplayLoad(s.sessionId);
    try {
      await conn.request('session.load', { sessionId: s.sessionId, cwd: s.cwd });
      if (token !== loadToken) return; // 已切走，丢弃过期结果
      // 历史末回合没有实时 turnEnd，必须显式收尾，否则一直显示运行中
      conversation.settle();
      conversation.sys('已载入，可以继续对话。');
    } catch (e) {
      if (token !== loadToken) return;
      conversation.sys('载入失败：' + (e as Error).message, 'err');
      conversation.finish('failed');
    } finally {
      conversation.endReplayLoad(s.sessionId);
    }
  }

  async function createSession(cwd: string): Promise<void> {
    ui.setView('chat');
    conversation.reset();
    conversation.sys('正在新建会话…');
    try {
      const r = (await conn.request('session.new', cwd ? { cwd } : {})) as {
        sessionId?: string;
        cwd?: string;
        configOptions?: ConfigOption[];
      };
      if (!r.sessionId) throw new Error('未返回 sessionId');
      sessions.setActive(r.sessionId);
      // 新建返回的 configOptions 是权威来源；不吸收会把上一个会话的档位显示过来。
      // 按 v2 语义精确归档到新会话，避免污染上一个会话的条目。
      if (r.configOptions) config.absorbFor(r.sessionId, r.configOptions);
      conversation.openSession(r.sessionId);
      conversation.sys('已创建，可以开始对话。');
    } catch (e) {
      // 失败必须退回列表页并清空当前会话，否则后续输入会发到旧会话
      sessions.setActive(null);
      conversation.reset();
      ui.setView('sessions');
      void loadSessions(false);
      ui.showToast('新建失败：' + (e as Error).message);
    }
  }

  async function resyncCurrentSession(): Promise<void> {
    const sid = conversation.state.sessionId;
    if (!sid) return;
    // cwd 兜底：新建会话要等下一次 sessions.list 才进列表（服务端重启后
    // 连服务端缓存的 cwd 也没了），缺 cwd 的 session.load 会被 Kiro 拒绝。
    // 先刷一次列表再取 cwd，两边的兜底就都齐了。
    if (!sessions.active?.cwd) await loadSessions(false);
    const token = ++loadToken;
    const cwd = sessions.active?.cwd;
    conversation.openSession(sid); // 清空投影后重放
    conversation.sys('连接已恢复，正在重新同步当前会话…');
    conversation.beginReplayLoad(sid); // 同 openSession：回放帧先于应答到达
    try {
      await conn.request('session.load', { sessionId: sid, cwd });
      if (token !== loadToken) return;
      conversation.settle();
      conversation.sys('已重新同步，可以继续对话。');
    } catch (e) {
      if (token !== loadToken) return;
      conversation.sys('重新同步失败：' + (e as Error).message, 'err');
    } finally {
      conversation.endReplayLoad(sid);
    }
  }

  /**
   * 断线重连后的当前会话恢复（契约 v2 events.resume）。
   *
   * 服务端可增量补发（requiresReplay=false）时只依赖补发帧 —— 它们以
   * resume:true 的普通 event 帧自动到达，本函数不做额外处理；
   * requiresReplay=true 或命令异常时退回既有的整段 session.load 重放。
   */
  async function resumeCurrentSession(): Promise<void> {
    const sid = conversation.state.sessionId;
    if (!sid) {
      void loadSessions(false);
      return;
    }
    try {
      const r = (await conn.request('events.resume', {
        sessionId: sid,
        afterSeq: conversation.state.lastSeq,
      })) as { delivered?: number; requiresReplay?: boolean; lastSeq?: number } | null;
      if (r?.requiresReplay) void resyncCurrentSession();
    } catch {
      void resyncCurrentSession();
    }
  }

  // ---------- 发送 / 取消 ----------

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      ui.showToast('请先输入内容');
      return;
    }
    const sid = conversation.state.sessionId;
    if (!sid) {
      ui.showToast('请先打开或新建会话');
      return;
    }

    // 本地先显示 + 记录待跳过的回显文本（否则同一句话会出现两次）
    const turnId = conversation.appendLocalUserMessage(sid, trimmed);
    if (!turnId) return;

    // 执行中标记：发送按钮据此切换为取消按钮。
    // 对应原实现 doSend 的 setBusy(true) / finally setBusy(false) ——
    // 必须按会话标记且退出路径放在 finally：异常时也要复位，
    // 否则按钮会永久停在取消态。
    conversation.setPromptInFlight(sid, true, turnId);
    try {
      // prompt 不使用前端超时：要等整个 agent 回合结束才应答
      await conn.request(
        'session.prompt',
        { sessionId: sid, text: trimmed },
        { timeoutMs: TIMEOUT_NO_LIMIT }
      );
    } catch (e) {
      if (conversation.state.sessionId === sid && conversation.state.activeTurnId === turnId) {
        conversation.sys('出错：' + (e as Error).message, 'err');
        conversation.finish('failed', sid, turnId);
      }
      return;
    } finally {
      conversation.setPromptInFlight(sid, false, turnId);
    }
    // finishTurn 幂等：若 turnEnd 已先收尾，这里不会重复搬运内容；
    // 若用户正在取消，则等待 turnEnd，不把 prompt response 当作完成信号。
    conversation.finish('completed', sid, turnId);
  }

  async function cancel(): Promise<void> {
    const sid = conversation.state.sessionId;
    if (!sid) return;
    const turnId = conversation.activeTurn?.sessionId === sid
      ? conversation.activeTurn.id
      : null;
    if (!turnId || !conversation.beginCancel(sid, turnId)) return;
    try {
      await conn.request('session.cancel', { sessionId: sid });
    } catch (e) {
      if (conversation.state.sessionId === sid && conversation.state.activeTurnId === turnId) {
        conversation.restoreCancel(sid, turnId);
        conversation.sys('取消失败：' + (e as Error).message, 'err');
      }
      return;
    }
    // session.cancel 是 notification。这里只确认停止请求已发出，
    // 最终状态必须由带 sessionId 的 turnEnd.stopReason 决定。
  }

  // ---------- 配置 ----------

  async function setConfigOption(configId: string, value: string, name?: string): Promise<void> {
    const sid = conversation.state.sessionId;
    if (!sid) {
      conversation.sys('请先打开一个会话再切换。');
      return;
    }

    try {
      await conn.request('session.setConfigOption', { sessionId: sid, configId, value });
      // 模型名做本地乐观更新：换模型会连带改变是否还有 effortLevel 可调，
      // 按钮需要立刻变字。其余配置以服务端 pushStatus 回来的值为准。
      if (configId === 'model') {
        const label = name || config.modelLabelOf(value) || value;
        config.setModel(value, label);
        conversation.sys('已切换到 ' + label);
      }
    } catch (e) {
      conversation.sys('切换失败：' + (e as Error).message, 'err');
    }
  }

  // ---------- 权限 ----------

  /**
   * 应答权限。
   *
   * optionId === null 表示「暂不处理（交由电脑端决定）」，在协议层等价于
   * 「无决策、保持静默」——**不是拒绝**。真正的拒绝必须点 reject_* 选项。
   */
  async function resolvePermission(optionId: string | null): Promise<void> {
    const cur = permission.current;
    if (!cur) return;
    const reqId = cur.reqId;
    const sessionId = cur.sessionId;
    const turnId = cur.turnId;
    const toolCallId = cur.toolCallId;
    if (!permission.markResolving(reqId)) return;

    try {
      const result = (await conn.request(
        'permission.resolve',
        { reqId, optionId },
        { timeoutMs: TIMEOUT_PERMISSION_MS }
      )) as { resolved?: boolean };

      if (result?.resolved === true) {
        permission.noteAnswered(reqId, optionId === null);
        if (permission.closeIf(reqId)) {
          conversation.clearWaiting(sessionId, turnId ?? undefined);
          if (toolCallId) conversation.markToolWaiting(toolCallId, false);
        }
        return;
      }

      // 服务端已找不到该 reqId，说明请求已经超时/被本轮清理；
      // 不能把这个结果记成用户的允许或拒绝，也不能关闭后来打开的新请求。
      if (permission.closeIf(reqId)) {
        conversation.clearWaiting(sessionId, turnId ?? undefined);
        if (toolCallId) conversation.markToolWaiting(toolCallId, false);
        if (conversation.state.sessionId === sessionId) {
          conversation.sys('权限请求已失效，已交回电脑端处理。');
        }
      }
    } catch (e) {
      // 网络失败不等于服务端已经处理：保留当前弹层并恢复按钮可操作状态。
      if (permission.restoreOpen(reqId) && conversation.state.sessionId === sessionId) {
        conversation.sys(
          (optionId === null ? '权限交回失败：' : '权限应答失败：') + (e as Error).message,
          'err'
        );
      }
    }
  }

  return {
    // 状态（组件只读）
    conn,
    sessions,
    conversation,
    permission,
    config,
    ui,
    // 动作
    start,
    loadSessions,
    openSession,
    createSession,
    resyncCurrentSession,
    send,
    cancel,
    setConfigOption,
    resolvePermission,
  };
}

export type AppApi = ReturnType<typeof useApp>;
