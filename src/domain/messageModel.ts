/**
 * 会话内容块模型。
 *
 * 这是对原实现（public/index.html 里的 DOM 结构）的数据化表达。
 * 原实现的「真状态」有一半存在 DOM 里（节点引用即状态槽位，如 assistantWrap /
 * procEl / curActions），这里把隐含状态显式化成数据，使 reducer 可以脱离浏览器运行。
 */

import { type ToolContent } from '../protocol/types.ts';

/** 文本块：既可能属于工作过程，也可能最终答案。身份由 reducer 决定。 */
export interface TextBlock {
  type: 'text';
  id: string;
  /** 原始 markdown 累积内容（等价于原实现的 assistantRaw / procRaw）。 */
  raw: string;
  /** 是否仍在流式写入。 */
  streaming: boolean;
  /**
   * 是否已被工具调用「封口」。
   * 对应原实现 addTool 里的 `procEl = null; procRaw = ''` —— 封口后
   * 后续文本另开新块，以保证过程叙述与工具行的事件顺序。
   */
  closed: boolean;
  /**
   * 本块是否在历史回放中创建。
   * 决定是否加流式淡入（等价于原实现建节点时调用 animateLive()）——
   * 回放是在重建历史，整屏历史同时淡入既无意义又拖慢打开速度。
   * 契约 v2：resume 补发帧创建的块同样视为回放块（无动画）。
   */
  replay: boolean;
}

/**
 * 思考流块：Kiro 的思考分片（agent_thought_chunk）。
 * 只存在于过程面板中，永不提升为答案（promoteProc 只挑 text 块）。
 */
export interface ThoughtBlock {
  type: 'thought';
  id: string;
  /** 思考文本累积内容。 */
  raw: string;
  /** 是否仍在流式写入。 */
  streaming: boolean;
  /** 是否已封口（被后续思考分片或回合收尾封口）。 */
  closed: boolean;
  /** 同 TextBlock.replay：回放/resume 创建的不播放淡入。 */
  replay: boolean;
  /** 实时首帧时间戳；回放/resume 帧创建为 null（耗时无意义）。 */
  startedAt: number | null;
  /** 封口时定格的时长（毫秒）；未定格为 null。 */
  frozenMs: number | null;
}

/** 工具调用行。 */
export interface ToolBlock {
  type: 'tool';
  id: string;
  toolCallId: string;
  title: string;
  toolKind?: string;
  status: string | undefined;
  /** 入参原文；undefined 表示本帧未携带（可能之后从缓存补齐）。 */
  rawInput: unknown;
  expandable: boolean;
  expanded: boolean;
  /** 同 TextBlock.replay：回放创建的行不播放淡入。 */
  replay: boolean;
  /** 实时首帧时间戳；回放/resume 帧创建为 null（耗时无意义）。 */
  startedAt: number | null;
  /** 完成/失败时定格的耗时（毫秒）；未结束或无计时基准为 null。 */
  finishedMs: number | null;
  /** 服务端带来的结构化输出片段（text/terminal/diff）。 */
  output: ToolContent[];
  /** 该工具是否正在等待权限确认。 */
  waiting: boolean;
}

/** 系统提示：不属于任何回合，直接展平在对话流里（等价于原实现 addSys）。 */
export interface SystemBlock {
  type: 'system';
  id: string;
  text: string;
  level: 'sys' | 'err';
  /** 同 TextBlock.replay：回放创建的不播放淡入。 */
  replay: boolean;
}

export type ConversationBlock = TextBlock | ToolBlock | ThoughtBlock;
export type ConversationItem = Turn | SystemBlock;

/** 用户消息（右对齐气泡）。 */
export interface UserMessageBlock {
  id: string;
  text: string;
  /** 归属的 Kiro messageId；undefined 表示协议未给（退化为相邻性合并）。 */
  messageId?: string;
}

/** 回合状态。 */
export type TurnStatus =
  | 'running'
  | 'waiting-permission'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'replaying';

/**
 * 一个 Agent 回合：用户消息 → 工作过程 → 最终答案 → 操作栏。
 *
 * 与原 DOM 结构的对应关系：
 *   userMessage   ↔ .user-row
 *   workVisible   ↔ .work-divider 是否存在
 *   panelVisible  ↔ .wr-panel 是否存在（只有出现过工具调用才创建）
 *   process       ↔ .wr-rows 里的子节点序列（叙述与工具行交错）
 *   answer        ↔ .assistant > .md
 *   actionsVisible↔ .action-bar
 */
export interface Turn {
  type: 'turn';
  id: string;
  sessionId: string;

  userMessage: UserMessageBlock | null;

  /** 工作过程序列：过程叙述与工具行按事件顺序交错。 */
  process: ConversationBlock[];

  /** 最终答案；null 表示本回合还没有结论。 */
  answer: TextBlock | null;

  /** 分割线是否出现。等价于原实现的 curWork !== null。 */
  workVisible: boolean;

  /**
   * 过程面板是否创建。等价于原实现的 curWork.rows !== null，
   * 也是「文本归属过程还是结论」的判据。
   */
  panelVisible: boolean;

  /** 面板展开状态。运行中自动展开，结束后默认收起。 */
  expanded: boolean;

  /** 操作条是否出现。等价于 ensureActions 是否被调用过。 */
  actionsVisible: boolean;
  /** 操作条时间戳；只有实时回合才有（回放不给）。 */
  actionTime: string | null;

  status: TurnStatus;
  /**
   * 回合是否已「定稿」。等价于原实现的 turnSettled。
   *
   * 不能由 status 推导：cancelling 期间仍是未定稿（迟到分片必须继续进结论区），
   * 而定稿是一个独立的一次性事件（prompt 响应或 turnEnd 到达）。
   */
  settled: boolean;

  /** 本页发起的回合才有可信时长；回放/电脑端发起的回合为 null。 */
  startedAt: number | null;
  /** 结束后定格的总时长（毫秒）。 */
  frozenMs: number | null;
  finishedAt: number | null;
  stopReason: string | null;

  /** 工具调用次数（只统计 tool-call 首帧）。 */
  toolCount: number;

  /** 思考块数量（只统计思考分片建块时计数）。 */
  thoughtCount: number;

  /** 是否来自 session/load 历史回放。回放回合不播放实时动画。 */
  replay: boolean;
}

/** 生成块 ID。仅在 reducer 内部使用，保证 Vue 列表 key 稳定。 */
let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

/** 仅供测试：重置 ID 计数器，让断言可复现。 */
export function __resetIdSeq(): void {
  seq = 0;
}

export function createTextBlock(id: string, replay = false): TextBlock {
  return { type: 'text', id, raw: '', streaming: true, closed: false, replay };
}

export function createSystemBlock(text: string, level: 'sys' | 'err' = 'sys', replay = false): SystemBlock {
  return { type: 'system', id: nextId('sys'), text, level, replay };
}
