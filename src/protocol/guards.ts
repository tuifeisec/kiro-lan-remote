/**
 * 协议守卫：把 WebSocket 收到的 unknown 收窄为 ServerMessage。
 *
 * 策略：只校验「分流所需的判别字段」（type / id / event.kind），
 * 不逐字段做 schema 校验 —— 服务端与前端同仓演进，过度校验会在
 * Kiro 新增事件字段时变成噪音。
 *
 * 未知 type 返回 null 由调用方忽略：这是**前向兼容**，不是吞错 ——
 * 服务端可能新增消息类型，前端不认识时应安静跳过而不是崩溃或弹错误。
 * 已知 type 但结构非法（如 res 缺 id）同样返回 null，因为无法安全路由。
 */

import type {
  CommandResponseMessage,
  ConfigOption,
  EventMessage,
  PermissionOption,
  PermissionRequestMessage,
  ServerEvent,
  ServerMessage,
  StatusPayload,
  ToolContent,
} from './types';

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null;
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 事件 kind 是否属于会被 session/load 回放的类型。 */
export const REPLAYABLE_KINDS = new Set<string>([
  'assistant-text',
  'user-text',
  'tool-call',
  'tool-call-update',
  'thought',
  'turn-completion',
]);

/** ToolContent 防御性透传：每项只保留 string 类型的已知字段，畸形项丢弃。 */
function normalizeToolContent(v: unknown): ToolContent[] {
  if (!Array.isArray(v)) return [];
  const out: ToolContent[] = [];
  for (const item of v) {
    if (!isObject(item) || !isString(item.type)) continue;
    const c: ToolContent = { type: item.type as ToolContent['type'] };
    if (isString(item.text)) c.text = item.text;
    if (isString(item.path)) c.path = item.path;
    if (isString(item.oldText)) c.oldText = item.oldText;
    if (isString(item.newText)) c.newText = item.newText;
    out.push(c);
  }
  return out;
}

function normalizeEvent(raw: unknown): ServerEvent | null {
  if (!isObject(raw)) return null;
  const kind = raw.kind;

  switch (kind) {
    case 'assistant-text':
      return isString(raw.text)
        ? {
            kind: 'assistant-text',
            text: raw.text,
            messageId: isString(raw.messageId) ? raw.messageId : undefined,
            replay: raw.replay === true,
            resume: raw.resume === true,
          }
        : null;

    case 'user-text':
      return isString(raw.text)
        ? {
            kind: 'user-text',
            text: raw.text,
            messageId: isString(raw.messageId) ? raw.messageId : undefined,
            replay: raw.replay === true,
            resume: raw.resume === true,
          }
        : null;

    case 'tool-call': {
      if (!isString(raw.toolCallId)) return null;
      const content = normalizeToolContent(raw.content);
      return {
        kind: 'tool-call',
        toolCallId: raw.toolCallId,
        title: isString(raw.title) ? raw.title : undefined,
        status: isString(raw.status) ? raw.status : undefined,
        toolKind: isString(raw.toolKind) ? raw.toolKind : undefined,
        rawInput: raw.rawInput,
        rawOutput: raw.rawOutput,
        timestamp: isString(raw.timestamp) ? raw.timestamp : undefined,
        ...(content.length ? { content } : {}),
        replay: raw.replay === true,
        resume: raw.resume === true,
      };
    }

    case 'tool-call-update': {
      if (!isString(raw.toolCallId)) return null;
      const content = normalizeToolContent(raw.content);
      return {
        kind: 'tool-call-update',
        toolCallId: raw.toolCallId,
        title: isString(raw.title) ? raw.title : undefined,
        status: isString(raw.status) ? raw.status : undefined,
        rawOutput: raw.rawOutput,
        timestamp: isString(raw.timestamp) ? raw.timestamp : undefined,
        ...(content.length ? { content } : {}),
        replay: raw.replay === true,
        resume: raw.resume === true,
      };
    }

    case 'thought':
      // 思考流分片：text 必须为 string，与文本事件同等校验
      return isString(raw.text)
        ? {
            kind: 'thought',
            text: raw.text,
            messageId: isString(raw.messageId) ? raw.messageId : undefined,
            replay: raw.replay === true,
            resume: raw.resume === true,
          }
        : null;

    case 'turn-completion':
      // 回合完成统计（重放历史里「已工作 N」的真实数据源）
      return {
        kind: 'turn-completion',
        elapsedTimeMs: isNumber(raw.elapsedTimeMs) ? raw.elapsedTimeMs : null,
        status: isString(raw.status) ? raw.status : null,
        replay: raw.replay === true,
        resume: raw.resume === true,
      };

    case 'unknown':
      // 服务端未识别的 sessionUpdate：只带 updateType，无原始载荷
      return {
        kind: 'unknown',
        updateType: isString(raw.updateType) ? raw.updateType : '',
        replay: raw.replay === true,
        resume: raw.resume === true,
      };

    case 'session-info': {
      const te = isObject(raw.turnEnd) ? raw.turnEnd : null;
      return {
        kind: 'session-info',
        title: isString(raw.title) ? raw.title : undefined,
        updatedAt: isString(raw.updatedAt) ? raw.updatedAt : undefined,
        replay: raw.replay === true,
        resume: raw.resume === true,
        turnEnd: te
          ? {
              stopReason: isString(te.stopReason) ? te.stopReason : null,
              messageId: isString(te.messageId) ? te.messageId : null,
            }
          : null,
      };
    }

    case 'config-options':
      return {
        kind: 'config-options',
        options: asArray<ConfigOption>(raw.options),
        replay: raw.replay === true,
        resume: raw.resume === true,
      };

    case 'mode':
      return {
        kind: 'mode',
        modeId: isString(raw.modeId) ? raw.modeId : undefined,
        replay: raw.replay === true,
        resume: raw.resume === true,
      };

    case 'commands':
      return {
        kind: 'commands',
        commands: asArray(raw.commands),
        replay: raw.replay === true,
        resume: raw.resume === true,
      };

    case 'mux-closed':
      return {
        kind: 'mux-closed',
        code: isNumber(raw.code) ? raw.code : undefined,
        reason: isString(raw.reason) ? raw.reason : undefined,
        resume: raw.resume === true,
      };

    case 'governance':
      // 展开原样字段；resume 若存在也一并带入
      return { kind: 'governance', resume: raw.resume === true, ...raw };

    default:
      // 含 kind: null（Kiro 下发了前端暂不渲染的 sessionUpdate）
      return { kind: null, raw };
  }
}

function normalizeStatus(raw: unknown): StatusPayload | null {
  if (!isObject(raw)) return null;
  const endpoint = isObject(raw.endpoint) ? raw.endpoint : null;
  return {
    connected: raw.connected === true,
    endpoint:
      endpoint && isNumber(endpoint.port) && isNumber(endpoint.pid)
        ? { port: endpoint.port, pid: endpoint.pid }
        : null,
    permissionPolicy: isString(raw.permissionPolicy) ? raw.permissionPolicy : null,
    lastError: isString(raw.lastError) ? raw.lastError : null,
    agentInfo: raw.agentInfo ?? null,
    browsers: isNumber(raw.browsers) ? raw.browsers : 0,
    modelId: isString(raw.modelId) ? raw.modelId : null,
    modelName: isString(raw.modelName) ? raw.modelName : null,
    configOptions: asArray<ConfigOption>(raw.configOptions),
    configSessionId: isString(raw.configSessionId) ? raw.configSessionId : null,
  };
}

function normalizePermissionOptions(raw: unknown): PermissionOption[] {
  return asArray<Raw>(raw)
    .filter((o) => isString(o?.optionId))
    .map((o) => o as unknown as PermissionOption);
}

/** 收窄一条下行消息；无法安全路由时返回 null。 */
export function parseServerMessage(msg: unknown): ServerMessage | null {
  if (!isObject(msg)) return null;

  switch (msg.type) {
    case 'status': {
      const status = normalizeStatus(msg.status);
      return status ? { type: 'status', status } : null;
    }

    case 'hello':
      return { type: 'hello', permissionPolicy: isString(msg.permissionPolicy) ? msg.permissionPolicy : '' };

    case 'res': {
      // id 是唯一的路由键，缺失即无法唤醒在飞请求
      if (!isNumber(msg.id)) return null;
      const res: CommandResponseMessage = { type: 'res', id: msg.id, ok: msg.ok === true };
      if (msg.result !== undefined) res.result = msg.result;
      if (isString(msg.error)) res.error = msg.error;
      return res;
    }

    case 'event': {
      const event = normalizeEvent(msg.event);
      if (!event) return null;
      const out: EventMessage = {
        type: 'event',
        seq: isNumber(msg.seq) ? msg.seq : 0,
        event,
      };
      // mux-closed / governance 两种事件没有 sessionId 字段
      if (msg.sessionId === null) out.sessionId = null;
      else if (isString(msg.sessionId)) out.sessionId = msg.sessionId;
      return out;
    }

    case 'permission-request': {
      if (!isString(msg.reqId)) return null;
      const req: PermissionRequestMessage = {
        type: 'permission-request',
        reqId: msg.reqId,
        sessionId: isString(msg.sessionId) ? msg.sessionId : '',
        toolCall: isObject(msg.toolCall) ? (msg.toolCall as PermissionRequestMessage['toolCall']) : null,
        options: normalizePermissionOptions(msg.options),
        sessionTitle: isString(msg.sessionTitle) ? msg.sessionTitle : null,
      };
      return req;
    }

    case 'permission-timeout':
      // 只有 reqId，没有 sessionId、没有原因字段
      return isString(msg.reqId) ? { type: 'permission-timeout', reqId: msg.reqId } : null;

    case 'permission-cleared':
      // 只有 sessionId，语义是「该会话这一轮已结束，残留弹层作废」
      return isString(msg.sessionId)
        ? { type: 'permission-cleared', sessionId: msg.sessionId }
        : null;

    default:
      return null;
  }
}
