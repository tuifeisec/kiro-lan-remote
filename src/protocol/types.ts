/**
 * 浏览器端协议类型定义。
 *
 * 事实来源：server.mjs（服务端 → 浏览器 7 种消息、11 个命令）与
 * lib/muxClient.mjs 的 normalizeUpdate（事件归一化）。
 * 这里只描述 Vue 层认识到的稳定协议，不暴露 ACP 原始结构。
 */

// ---------- 服务端 → 浏览器 ----------

/** 连接与配置快照。 */
export interface StatusPayload {
  connected: boolean;
  endpoint: { port: number; pid: number } | null;
  permissionPolicy: string | null;
  lastError: string | null;
  agentInfo: unknown | null;
  browsers: number;
  /** 当前会话使用的模型 id（可能为 null）。 */
  modelId: string | null;
  modelName: string | null;
  /** Kiro 下发的全部配置项（原样）。这是「有哪些模型、各支持什么」的权威来源。 */
  configOptions: ConfigOption[];
  /** configOptions 归属的会话；null 表示无会话归属（全局兜底快照）。 */
  configSessionId: string | null;
}

/** 一条 Kiro 配置项。对服务端与页面都是不透明数据。 */
export interface ConfigOption {
  id: string;
  currentValue?: string;
  options?: ConfigOptionItem[];
  [key: string]: unknown;
}

export interface ConfigOptionItem {
  value: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface StatusMessage {
  type: 'status';
  status: StatusPayload;
}

export interface HelloMessage {
  type: 'hello';
  permissionPolicy: string;
}

export interface CommandResponseMessage {
  type: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventMessage {
  type: 'event';
  /** 全局递增事件序号（服务端 eventSeq）。第一阶段仅记录，不据此补发。 */
  seq: number;
  /** 会话归属；mux-closed 与 governance 两种事件没有该字段。 */
  sessionId?: string | null;
  event: ServerEvent;
}

export interface PermissionRequestMessage {
  type: 'permission-request';
  reqId: string;
  sessionId: string;
  toolCall: PermissionToolCall | null;
  options: PermissionOption[];
  /** 该权限请求归属会话的标题；缺失为 null。供其他会话的弹层提示使用。 */
  sessionTitle?: string | null;
}

export interface PermissionTimeoutMessage {
  type: 'permission-timeout';
  reqId: string;
}

export interface PermissionClearedMessage {
  type: 'permission-cleared';
  sessionId: string;
}

export type ServerMessage =
  | StatusMessage
  | HelloMessage
  | CommandResponseMessage
  | EventMessage
  | PermissionRequestMessage
  | PermissionTimeoutMessage
  | PermissionClearedMessage;

// ---------- 事件（event.event） ----------

export type EventKind =
  | 'assistant-text'
  | 'user-text'
  | 'tool-call'
  | 'tool-call-update'
  | 'thought'
  | 'turn-completion'
  | 'unknown'
  | 'session-info'
  | 'config-options'
  | 'mode'
  | 'commands'
  | 'mux-closed'
  | 'governance';

/**
 * 工具调用的结构化输出片段。
 * 服务端原样透传 Kiro 的 tool_call.content；这里只声明前端认识的三类。
 */
export interface ToolContent {
  type: 'text' | 'terminal' | 'diff';
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
}

export interface AssistantTextEvent {
  kind: 'assistant-text';
  text: string;
  messageId?: string;
  replay: boolean;
  /** 服务端断线补发标记：补发帧按回放块处理，但不触发回放状态机。 */
  resume?: boolean;
}

export interface UserTextEvent {
  kind: 'user-text';
  text: string;
  messageId?: string;
  replay: boolean;
  resume?: boolean;
}

export interface ToolCallEvent {
  kind: 'tool-call';
  toolCallId: string;
  title?: string;
  status?: string;
  toolKind?: string;
  rawInput?: unknown;
  /** 结构化输出片段（契约 v2）。缺失表示本帧未携带。 */
  content?: ToolContent[];
  /** 服务端原始输出；前端不解析，仅透传留存。 */
  rawOutput?: unknown;
  /** Kiro 帧级时间戳（ISO）。重放历史里用「update 帧 − 首帧」还原真实工具耗时。 */
  timestamp?: string;
  replay: boolean;
  resume?: boolean;
}

export interface ToolCallUpdateEvent {
  kind: 'tool-call-update';
  toolCallId: string;
  title?: string;
  status?: string;
  /** 结构化输出片段（契约 v2）。非空时覆盖既有 output。 */
  content?: ToolContent[];
  rawOutput?: unknown;
  timestamp?: string;
  replay: boolean;
  resume?: boolean;
}

/** 思考流分片（agent_thought_chunk）。 */
export interface ThoughtEvent {
  kind: 'thought';
  text: string;
  messageId?: string;
  replay: boolean;
  resume?: boolean;
}

/**
 * 回合完成统计（session_info_update + _meta.kiro.kind='turn_completion'）。
 * elapsedTime 是 Kiro 记录的**真实耗时毫秒**——重放历史里唯一可靠的
 * 「已工作 N」数据源；紧随其后的 turn_end 仍负责收尾。
 */
export interface TurnCompletionEvent {
  kind: 'turn-completion';
  elapsedTimeMs: number | null;
  status: string | null;
  replay: boolean;
  resume?: boolean;
}

/** 服务端未识别的 sessionUpdate（无原始载荷，只有 updateType）。 */
export interface UnknownUpdateEvent {
  kind: 'unknown';
  updateType: string;
  replay: boolean;
  resume?: boolean;
}

export interface SessionInfoEvent {
  kind: 'session-info';
  title?: string;
  updatedAt?: string;
  replay: boolean;
  resume?: boolean;
  /** 回合结束信号。手机端判断「电脑端发起的回合已结束」的唯一依据。 */
  turnEnd: { stopReason: string | null; messageId: string | null } | null;
}

export interface ConfigOptionsEvent {
  kind: 'config-options';
  options: ConfigOption[];
  replay: boolean;
  resume?: boolean;
}

export interface ModeEvent {
  kind: 'mode';
  modeId?: string;
  replay: boolean;
  resume?: boolean;
}

export interface CommandsEvent {
  kind: 'commands';
  commands: unknown[];
  replay: boolean;
  resume?: boolean;
}

export interface MuxClosedEvent {
  kind: 'mux-closed';
  code?: number;
  reason?: string;
  resume?: boolean;
}

export interface GovernanceEvent {
  kind: 'governance';
  resume?: boolean;
  [key: string]: unknown;
}

export interface UnknownEvent {
  kind: null;
  raw?: unknown;
  resume?: boolean;
}

export type ServerEvent =
  | AssistantTextEvent
  | UserTextEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | ThoughtEvent
  | TurnCompletionEvent
  | UnknownUpdateEvent
  | SessionInfoEvent
  | ConfigOptionsEvent
  | ModeEvent
  | CommandsEvent
  | MuxClosedEvent
  | GovernanceEvent
  | UnknownEvent;

// ---------- 权限 ----------

export interface PermissionToolCall {
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  rawInput?: unknown;
  [key: string]: unknown;
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
  [key: string]: unknown;
}

// ---------- 会话列表 ----------

export interface SessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  agentMode?: string;
  status?: string;
  executionTarget?: string;
  description?: string;
}

// ---------- 工具状态 ----------

/** 工具行视觉状态类：run=进行中 / done=完成 / fail=失败。 */
export type ToolVisualState = 'run' | 'done' | 'fail';

/** ACP tool_call.status → 视觉状态。未知状态按进行中处理。 */
export const TOOL_CLS: Record<string, ToolVisualState> = {
  pending: 'run',
  in_progress: 'run',
  completed: 'done',
  failed: 'fail',
};

export function toolCls(status: string | undefined): ToolVisualState {
  return (status && TOOL_CLS[status]) || 'run';
}

/**
 * 协议 kind → 中文兜底名。
 * 正常情况下 Kiro 会给 title（如「终端」「读取」），title 缺失时才用这里。
 */
export const TOOL_KIND: Record<string, string> = {
  read: '读取',
  edit: '编辑',
  delete: '删除',
  move: '移动',
  search: '搜索',
  execute: '执行',
  think: '思考',
  fetch: '获取',
  switch_mode: '切换模式',
  other: '工具调用',
};
