/**
 * 事件路由 reducer。
 *
 * 严格保持原 public/index.html `handleEvent` 的执行顺序 —— 这是硬契约：
 *
 *   1. mux-closed：在**会话过滤之前**处理（该事件没有 sessionId）。
 *      mux 断开与当前看的是哪个会话无关。
 *   2. governance：本 reducer 不渲染；呈现（系统提示）由 bootstrap 层
 *      在进入本函数之前处理。
 *   3. 会话过滤：只渲染当前会话的事件。mux 会把所有会话的 session/update
 *      广播下来，这行是防串台的唯一屏障。
 *   4. 回放判定：只对 REPLAYABLE 的 kind 生效（assistant-text / user-text /
 *      tool-call / tool-call-update / thought）。**resume 补发帧整体绕过
 *      该判定**：既不进入也不退出 replaying，也不会清空已有内容；
 *      分派层以 `animateLive(state) && !event.resume` 创建无动画块。
 *   5. 分派到具体 reducer。
 *
 * 本文件不依赖 Vue / DOM：依赖通过 deps 注入，因此可用 node:test 覆盖。
 */

import type { ConfigOption, ServerEvent } from '../protocol/types.ts';
import { REPLAYABLE_KINDS } from '../protocol/guards.ts';
import {
  addToolCall,
  appendAssistantText,
  appendThought,
  appendUserText,
  applySessionInfo,
  applyTurnCompletion,
  clearMessages,
  finishTurn,
  updateToolCall,
  type ConversationState,
} from './turnReducer.ts';

/** 路由过程中需要的外部协作。由 store 层注入。 */
export interface EventRouterDeps {
  /** 当前是否处于会话页。 */
  isChatView: () => boolean;
  /** 该 sessionId 是否属于当前正在查看的会话。 */
  isActiveSession: (sessionId: string | null | undefined) => boolean;
  /** mux 连接断开。 */
  onMuxClosed: () => void;
  /** 会话标题更新。 */
  onTitle: (title: string) => void;
  /**
   * 吸收一份完整配置。
   * 配置变更在页面上是通过 status 的 configOptions 生效的（服务端收到
   * config-option 事件后会 absorb + pushStatus），所以这里只做记录，
   * 不驱动 UI。
   */
  absorbConfigOptions?: (options: ConfigOption[]) => void;
  /** 模式切换（kind: 'mode'）。由 config store 做本地权威回写。 */
  onMode?: (modeId?: string) => void;
  /** 斜杠命令列表更新（kind: 'commands'）。按会话归档由调用方处理。 */
  onCommands?: (commands: unknown[]) => void;
}

/** 一次事件处理的结果，便于调用方做副作用（滚动等）。 */
export interface EventOutcome {
  /** 事件是否被本会话消费。 */
  handled: boolean;
  /** 是否有可见内容变化，调用方据此决定是否滚动。 */
  contentChanged: boolean;
}

const NOT_HANDLED: EventOutcome = { handled: false, contentChanged: false };
const HANDLED: EventOutcome = { handled: true, contentChanged: false };
const CHANGED: EventOutcome = { handled: true, contentChanged: true };

/**
 * 处理一条 event 消息。
 *
 * @param state 会话投影状态（就地修改）
 * @param sessionId 事件信封上的会话归属
 * @param event 归一化后的事件
 */
export function applyEvent(
  state: ConversationState,
  sessionId: string | null | undefined,
  event: ServerEvent,
  deps: EventRouterDeps
): EventOutcome {
  if (!event) return NOT_HANDLED;

  // 1. mux 断开：与当前会话无关，必须在过滤之前处理
  if (event.kind === 'mux-closed') {
    deps.onMuxClosed();
    return HANDLED;
  }

  // 2. governance：本 reducer 不渲染；bootstrap 层在调用前已转为系统提示
  if (event.kind === 'governance') return NOT_HANDLED;

  // 3. 会话过滤（防串台的唯一屏障）
  if (!deps.isChatView() || !deps.isActiveSession(sessionId)) return NOT_HANDLED;

  // 4. 回放阶段判定：只对会被 session/load 重放的类型生效。
  //    resume 补发帧整体绕过：不进入也不退出 replaying、不清空内容；
  //    「无动画」由分派层依据 event.resume 在 reducer 内判定。
  if (event.resume !== true && event.kind && REPLAYABLE_KINDS.has(event.kind)) {
    if (event.replay === true) {
      if (!state.replaying) {
        // 顺序关键：先置 replaying 再清空。清空本身不动 replaying，
        // 但后续节点创建会读 animateLive() 决定是否加淡入。
        state.replaying = true;
        clearMessages(state);
      }
    } else if (state.replaying) {
      state.replaying = false;
    }
  }

  // 5. 分派
  switch (event.kind) {
    case 'assistant-text':
      appendAssistantText(state, event);
      return CHANGED;

    case 'user-text':
      appendUserText(state, event);
      return CHANGED;

    case 'tool-call':
      addToolCall(state, event);
      return CHANGED;

    case 'tool-call-update':
      updateToolCall(state, event);
      return CHANGED;

    case 'thought':
      appendThought(state, event);
      return CHANGED;

    case 'turn-completion':
      // 回合完成统计：写入真实耗时（重放历史里「已工作 N」的来源）
      applyTurnCompletion(state, event);
      return CHANGED;

    case 'session-info':
      applySessionInfo(state, event, deps.onTitle);
      // turnEnd 会改变可见状态（面板收起、结论提升）
      return event.turnEnd ? CHANGED : HANDLED;

    case 'config-options':
      deps.absorbConfigOptions?.(event.options);
      return HANDLED;

    case 'mode':
      // 模式切换：交由注入侧做本地权威回写（等待服务端 pushStatus 校正）
      deps.onMode?.(event.modeId);
      return HANDLED;

    case 'commands':
      // 斜杠命令列表：按会话归档由注入侧处理
      deps.onCommands?.(event.commands);
      return HANDLED;

    case 'unknown':
      // 服务端未识别的 sessionUpdate：本 reducer 只确认消费；
      // 去重告警（console.warn）由 bootstrap 层负责，不进 UI。
      return HANDLED;

    default:
      // kind: null —— Kiro 下发了前端暂不渲染的 sessionUpdate
      return NOT_HANDLED;
  }
}

/**
 * 收尾当前回合（供 UI 动作调用）。
 * 单独导出以便取消、错误路径复用同一入口。
 */
export { finishTurn };
