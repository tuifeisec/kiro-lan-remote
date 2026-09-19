// 与 Kiro agent mux 的 ACP 客户端实现（JSON-RPC 2.0 over WebSocket）
//
// 协议要点（均来自对本机 kiro.kiro-agent 扩展的实测）：
//   连接：ws://127.0.0.1:<port>/?token=<uuid>[&role=primary|observer]
//
//   role=observer（默认，安全）：
//     - 从协议层收不到 agent 的 terminal/* 与 fs/* 请求，因此不可能干扰桌面端 IDE 的工具执行
//     - 仍可发送 session/new、session/load、session/prompt、session/cancel 驱动会话
//     - 审批权限须用扩展方法 _kiro/permission/respond（JSON-RPC 响应会被 mux 丢弃）
//
//   role=primary（不安全）：会收到 agent 全部工具请求；若客户端无法满足却回了错误响应，
//     该错误会被转发给 agent，导致桌面端 IDE 的工具调用失败。仅用于无桌面端竞争的场景。
//
//   客户端 → 服务端（请求）：initialize / session/new / session/load / session/list
//                            session/prompt / session/cancel / session/set_mode
//                            _kiro/permission/respond（observer 审批权限）
//   服务端 → 客户端（通知）：session/update
//          params.sessionUpdate ∈ {agent_message_chunk, user_message_chunk,
//                                 agent_thought_message_chunk, tool_call,
//                                 tool_call_update, session_info_update,
//                                 available_commands_update, config_option_update,
//                                 current_mode_update, ...}
//          未识别的种类一律归一化为 {kind:'unknown', updateType:<原种类名>}，
//          不丢弃也不透传原始大对象（Kiro 新增种类时前端仍可感知到"有事发生"）。
//   服务端 → 客户端（请求）：session/request_permission、_kiro/userInput

import { EventEmitter } from 'node:events';

const PROMPT_TIMEOUT_MS = 60 * 60 * 1000; // 长任务：1 小时
const REQUEST_TIMEOUT_MS = 30_000;

export class MuxClient extends EventEmitter {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #permissionPolicy = 'ask';
  #permissionHandler = null;
  #userInputHandler = null;
  #configOptions = new Map();

  constructor({ port, token, role = 'observer', clientInfo } = {}) {
    super();
    this.port = port;
    this.token = token;
    this.role = role;
    this.clientInfo = clientInfo ?? { name: 'kiro-lan-remote', version: '0.1.0' };
    this.agentCapabilities = null;
    this.agentInfo = null;
  }

  get isOpen() {
    return !this.#closed && this.#ws?.readyState === 1;
  }

  /**
   * 设置权限请求处理策略。
   * policy: 'allow-once' | 'allow-always' | 'reject' | 'ask'
   * 当 policy === 'ask' 时，必须提供 handler(permissionRequest) => Promise<optionId>
   */
  setPermissionPolicy(policy, handler = null) {
    this.#permissionPolicy = policy;
    this.#permissionHandler = handler;
  }

  /** 设置 _kiro/userInput 处理器；未设置时该请求保持静默。 */
  setUserInputHandler(handler) {
    this.#userInputHandler = handler;
  }

  async connect() {
    const url = `ws://127.0.0.1:${this.port}/?token=${this.token}&role=${this.role}`;
    this.#ws = new WebSocket(url);

    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error(`无法连接 mux（ws://127.0.0.1:${this.port}）：token 或端口可能已失效`)); };
      const onClose = e => { cleanup(); reject(new Error(`连接被拒绝：close ${e.code} ${e.reason || ''}`)); };
      const cleanup = () => {
        this.#ws.removeEventListener('open', onOpen);
        this.#ws.removeEventListener('error', onErr);
        this.#ws.removeEventListener('close', onClose);
      };
      this.#ws.addEventListener('open', onOpen);
      this.#ws.addEventListener('error', onErr);
      this.#ws.addEventListener('close', onClose);
    });

    this.#ws.addEventListener('message', ev => this.#onMessage(ev));
    this.#ws.addEventListener('close', e => {
      this.#closed = true;
      this.emit('closed', { code: e.code, reason: e.reason });
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`连接已关闭（${e.code}）`));
      }
      this.#pending.clear();
    });
    return this;
  }

  #send(obj) {
    if (!this.isOpen) throw new Error('mux 连接未就绪');
    this.#ws.send(JSON.stringify(obj));
  }

  #request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e);
      }
    });
  }

  #respond(id, result) {
    this.#send({ jsonrpc: '2.0', id, result });
  }

  async #onMessage(ev) {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
      return;
    }

    // 通知
    if (msg.method && msg.id === undefined) {
      this.emit('notification', msg);
      if (msg.method === 'session/update') this.emit('session-update', msg.params);
      else if (msg.method === '_kiro/governance/state') this.emit('governance', msg.params);
      else this.emit('other-notification', msg);
      return;
    }

    // 服务端发来的请求，必须应答
    if (msg.method && msg.id !== undefined) {
      this.emit('server-request', msg);
      await this.#handleServerRequest(msg);
    }
  }

  async #handleServerRequest(msg) {
    const { id, method, params } = msg;

    // 关键：mux 会把 agent 的请求广播给所有已连接客户端
    // （见 kiro.kiro-agent 的 MultiplexStream.routeOutbound），而客户端对这些请求的
    // 响应会被原样转发回 agent。因此：
    //
    //   - 若我们对无法处理的方法回一个错误，agent 会认为该工具调用失败，
    //     从而破坏桌面端 IDE 自身正在进行的会话（实测会导致 IDE 终端工具全部失效）。
    //   - 正确做法是对这些请求**完全不响应**，让持有真实能力的桌面端客户端去应答。
    //
    // 唯一需要（也适合）由本客户端应答的是权限请求：它的语义就是"由客户端决定"，
    // 且 mux 只允许 role=primary 的响应被转发给 agent。
    if (method !== 'session/request_permission' && method !== '_kiro/userInput') {
      this.emit('ignored-server-request', { id, method, params });
      return;
    }

    try {
      if (method === 'session/request_permission') {
        const decision = await this.#decidePermission(params);
        if (decision == null) {
          // 无决策时保持静默，交由桌面端 IDE 自行处理
          this.emit('permission-unanswered', params);
          return;
        }

        if (this.role === 'observer') {
          // observer 的 JSON-RPC 响应会被 mux 直接丢弃
          // （routeInbound: "discarded observer permission response ... waiting for _kiro/permission/respond"），
          // 必须改用扩展方法 _kiro/permission/respond。
          const toolCallId = params?.toolCall?.toolCallId ?? params?.toolCallId;
          if (!toolCallId) {
            this.emit('permission-unanswered', params);
            return;
          }
          try {
            await this.#request('_kiro/permission/respond', { toolCallId, optionId: decision });
          } catch (e) {
            // 该请求被拒通常意味着桌面端已先应答了这个权限。先向上层发出
            // 'permission-respond-failed'（server 据此收起手机上的弹层），
            // 再按既有 handler-error 路径吞掉 —— 不得向 mux 回错误，
            // 否则会污染桌面端会话。
            this.emit('permission-respond-failed', {
              toolCallId,
              optionId: decision,
              error: e?.message ?? String(e),
            });
            throw e;
          }
        } else {
          this.#respond(id, { outcome: { outcome: 'selected', optionId: decision } });
        }
        return;
      }

      // _kiro/userInput：仅在显式配置了处理器时应答
      if (this.#userInputHandler) {
        const result = await this.#userInputHandler(params);
        if (result != null) {
          this.#respond(id, result);
          return;
        }
      }
      this.emit('ignored-server-request', { id, method, params });
    } catch (e) {
      // 处理异常时也不向 agent 回错误，避免污染桌面端会话
      this.emit('handler-error', { method, error: e?.message ?? String(e) });
    }
  }

  async #decidePermission(params) {
    const options = params?.options ?? [];
    if (options.length === 0) return null;

    const pick = (...kinds) => {
      for (const k of kinds) {
        const hit = options.find(o => o.kind === k);
        if (hit) return hit.optionId;
      }
      return null;
    };

    const policy = this.#permissionPolicy;
    if (policy === 'allow-always') {
      return pick('allow_always', 'allow_once') ?? options[0].optionId;
    }
    if (policy === 'allow-once') {
      return pick('allow_once', 'allow_always') ?? options[0].optionId;
    }
    if (policy === 'reject') {
      return pick('reject_once', 'reject_always') ?? null;
    }
    if (this.#permissionHandler) {
      return this.#permissionHandler(params);
    }
    return null;
  }

  // ---- ACP 方法 ----

  async initialize() {
    const res = await this.#request('initialize', {
      protocolVersion: 1,
      // 不声明 fs / terminal 能力：harness 运行在本机扩展宿主内，使用其自身的文件与终端访问，
      // 避免把本机文件读写请求转交给本服务而无法满足。
      clientCapabilities: {},
      clientInfo: this.clientInfo,
    });
    this.agentCapabilities = res?.agentCapabilities ?? null;
    this.agentInfo = res?.agentInfo ?? null;
    return res;
  }

  listSessions({ cwd } = {}) {
    return this.#request('session/list', cwd ? { cwd } : {});
  }

  newSession({ cwd, mcpServers = [], modelId } = {}) {
    const params = { cwd, mcpServers };
    const meta = buildKiroMeta({ modelId });
    if (meta) params._meta = meta;
    return this.#request('session/new', params);
  }

  loadSession({ sessionId, cwd, mcpServers = [], modelId } = {}) {
    const params = { sessionId, cwd, mcpServers };
    const meta = buildKiroMeta({ modelId });
    if (meta) params._meta = meta;
    return this.#request('session/load', params);
  }

  /**
   * 取消是 ACP notification：Kiro 接受无 id 的 session/cancel，
   * 带 id 的 request 会被当成不支持的持久化分类请求。
   */
  cancel(sessionId) {
    this.#send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    return Promise.resolve();
  }

  setMode({ sessionId, modeId }) {
    return this.#request('session/set_mode', { sessionId, modeId });
  }

  /** 切换会话的配置项（模型用 configId='model'，value 为模型 id）。 */
  setConfigOption({ sessionId, configId, value }) {
    return this.#request('session/set_config_option', { sessionId, configId, value });
  }

  /** 切换会话模型。value 必须是模型 id（不是名称），见 applyModelId。 */
  setModel({ sessionId, modelId }) {
    return this.setConfigOption({ sessionId, configId: 'model', value: modelId });
  }

  /**
   * 发送提示词。采用长超时，流式内容通过 session-update 事件推送。
   *
   * 注意：ACP 官方规范里该字段名为 `content`，但 Kiro 的实现使用 `prompt`
   * （见 kiro.kiro-agent 中 ActiveSession.prompt：
   *   cx.request(session_prompt, { sessionId, prompt: promptBlocks(e) })
   * 且 promptBlocks 接受 string 或 [{type:"text",text}]）。
   * 传 `content` 会得到 "Invalid params"。
   */
  prompt({ sessionId, text, prompt }) {
    const blocks = prompt ?? (typeof text === 'string' ? [{ type: 'text', text }] : text);
    return this.#request('session/prompt', { sessionId, prompt: blocks }, PROMPT_TIMEOUT_MS);
  }

  close() {
    this.#closed = true;
    try { this.#ws?.close(); } catch {}
  }
}

/**
 * 构造 ACP 请求的 `_meta.kiro` 扩展字段。
 *
 * Kiro 的 agent 用 `_meta.kiro.modelId` 决定会话模型
 * （见 extension.js 的 pinSessionModelId：有值直接用，无值回退 defaultModel）。
 * 不传时会回退到「模型列表里的 defaultModel」，那个值未必可用 ——
 * 代理下发的 defaultModel 可能指向一个上游已失效的模型。
 */
function buildKiroMeta({ modelId, modeId } = {}) {
  const kiro = {};
  if (modelId) kiro.modelId = modelId;
  if (modeId) kiro.modeId = modeId;
  return Object.keys(kiro).length ? { kiro } : null;
}

/**
 * 把 ACP tool_call.content 数组归一化为 ToolContent[]（协议契约 v2）：
 *   {type:'content', content:{type:'text', text}} → {type:'text', text}
 *   {type:'diff', path, oldText?, newText?}       → {type:'diff', path, oldText, newText}
 *   {type:'terminal', terminalSessionId?}         → {type:'terminal'}
 * 其余类型（如 image）按未知内容跳过；没有任何可归一化条目时返回 undefined
 * （事件不带 content 字段，前端按可选字段处理）。
 */
function normalizeToolContent(arr) {
  if (!Array.isArray(arr)) return undefined;
  const out = [];
  for (const c of arr) {
    if (c?.type === 'content' && c.content?.type === 'text') {
      out.push({ type: 'text', text: c.content.text });
    } else if (c?.type === 'diff') {
      out.push({ type: 'diff', path: c.path ?? null, oldText: c.oldText ?? null, newText: c.newText ?? null });
    } else if (c?.type === 'terminal') {
      out.push({ type: 'terminal' });
    }
  }
  return out.length ? out : undefined;
}

/**
 * 将 ACP session/update 通知归一化为便于 UI 消费的事件。
 * 返回值形如 { kind, ... }；未知种类返回 { kind:'unknown', updateType }，
 * 仅当通知整体为空时返回 { kind:null }（无需展示）。
 */
export function normalizeUpdate(params) {
  if (!params) return { kind: null };
  const kind = params.update?.sessionUpdate ?? params.sessionUpdate;
  const u = params.update ?? params;

  // session/load 会把整段历史以 session/update 逐条重放，并给这些帧打上
  // _meta.kiro.replay = true（见 extension.js 的 zSt）。
  // 必须把它透传给渲染层：重放语义是「重建历史」，不是「新增消息」。
  // 丢掉该标记会让历史被当作新消息再追加一遍，界面上表现为消息重复。
  //
  // Kiro 还把「回合结束」也挂在同一个 _meta.kiro 上（实测 kind="turn_end"，
  // turnEnd.stopReason 给出 end_turn / cancelled 等）。实测它随
  // session_info_update 帧下发，但语义完全是另一回事 ——
  // 「本回合已结束」不是「会话标题变了」，因此必须显式透传，
  // 否则会被当成普通 session_info_update 处理，结束信号就此丢失。
  //
  // 为什么这个信号是必需的：手机端只拿得到自己发起的 prompt 响应，
  // 电脑端发起、手机旁观的回合没有响应可等 —— 缺了这个标记，那种回合
  // 永远收不到结束信号，界面上就是「工作过程永不折叠、结论一直关在里面」。
  const kiro = u._meta?.kiro;
  const replay = kiro?.replay === true;
  const turnEnd = (kiro && (kiro.kind === 'turn_end' || kiro.turnEnd))
    ? { stopReason: kiro.turnEnd?.stopReason ?? kiro.stopReason ?? null, messageId: kiro.messageId ?? null }
    : null;

  switch (kind) {
    case 'agent_message_chunk': {
      const text = u.content?.type === 'text' ? u.content.text : '';
      return text ? { kind: 'assistant-text', text, messageId: kiro?.messageId, replay } : { kind: null };
    }
    case 'user_message_chunk': {
      const text = u.content?.type === 'text' ? u.content.text : '';
      return text ? { kind: 'user-text', text, messageId: kiro?.messageId, replay } : { kind: null };
    }
    // 思考流分片：与 agent_message_chunk 同构（content:{type:'text',text}），
    // 但语义是「模型的思考过程」而非正文，前端按可折叠的 thought 流渲染。
    // 空文本不产生事件（与 assistant-text 的处理一致）。
    case 'agent_thought_message_chunk': {
      const text = u.content?.type === 'text' ? u.content.text : '';
      return text ? { kind: 'thought', text, messageId: kiro?.messageId, replay } : { kind: null };
    }
    case 'tool_call': {
      const ev = {
        kind: 'tool-call',
        toolCallId: u.toolCallId,
        title: u.title,
        status: u.status,
        toolKind: u.kind,
        rawInput: u.rawInput,
        replay,
      };
      // _meta.kiro.timestamp 是帧级时间戳（实测重放历史里也有）——
      // 重放时用「update 帧 timestamp − 首帧 timestamp」可还原真实工具耗时。
      if (typeof kiro?.timestamp === 'string') ev.timestamp = kiro.timestamp;
      const content = normalizeToolContent(u.content);
      if (content) ev.content = content;
      if (u.rawOutput !== undefined) ev.rawOutput = u.rawOutput;
      return ev;
    }
    case 'tool_call_update': {
      const ev = {
        kind: 'tool-call-update',
        toolCallId: u.toolCallId,
        title: u.title,
        status: u.status,
        replay,
      };
      if (typeof kiro?.timestamp === 'string') ev.timestamp = kiro.timestamp;
      const content = normalizeToolContent(u.content);
      if (content) ev.content = content;
      if (u.rawOutput !== undefined) ev.rawOutput = u.rawOutput;
      return ev;
    }
    case 'session_info_update': {
      // Kiro 把多种会话级信号都挂在本种类上，用 _meta.kiro.kind 区分（实测）：
      //   turn_end        → 回合结束（turnEnd，已有）；
      //   turn_completion → 回合完成统计，elapsedTime 是**真实耗时毫秒**——
      //                     重放历史里唯一可靠的「已工作 N」数据源；
      //   turn_start / context_usage / steering_inclusion → 已知但无需展示；
      //   display_error   → 上游模型错误，落 unknown 保持可观测。
      if (kiro?.kind === 'turn_completion') {
        return {
          kind: 'turn-completion',
          elapsedTimeMs: typeof kiro.elapsedTime === 'number' ? kiro.elapsedTime : null,
          status: typeof kiro.status === 'string' ? kiro.status : null,
          replay,
        };
      }
      if (
        kiro?.kind === 'turn_start' ||
        kiro?.kind === 'context_usage' ||
        kiro?.kind === 'steering_inclusion'
      ) {
        return { kind: null };
      }
      if (kiro?.kind === 'display_error') {
        return { kind: 'unknown', updateType: 'display_error', replay };
      }
      return { kind: 'session-info', title: u.title, updatedAt: u.updatedAt, replay, turnEnd };
    }
    case 'available_commands_update':
      return { kind: 'commands', commands: u.availableCommands ?? [], replay };
    case 'config_option_update':
      return { kind: 'config-options', options: u.configOptions ?? [], replay };
    case 'current_mode_update':
      return { kind: 'mode', modeId: u.currentModeId, replay };
    default:
      // 未识别的种类：显式标为 unknown（updateType 取原 sessionUpdate 名，
      // 缺失时为空串），不携带原始 raw 大对象 —— 前端能感知「有未知事件」
      // 并可展示占位，又不会被超大 payload 拖垮。
      return { kind: 'unknown', updateType: kind ?? '', replay };
  }
}
