// kiro-lan-remote —— 局域网内用浏览器遥控本机 Kiro IDE agent 会话
//
// 架构：
//   手机浏览器  ──(WebSocket, 需访问密钥)──►  本程序  ──(ACP over WebSocket)──►  Kiro agent mux
//
// 本程序是独立进程，不安装任何 Kiro/VS Code 扩展。
// 它通过只读扫描 Kiro 扩展宿主进程内存取得 mux token（见 lib/discover.mjs 的说明）。
//
// 启动：node server.mjs
// 停止：Ctrl+C

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverMux } from './lib/discover.mjs';
import { MuxClient, normalizeUpdate } from './lib/muxClient.mjs';
import { crypto_accept, createWsConn } from './lib/miniws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? '0.0.0.0';
const ACCESS_KEY = process.env.ACCESS_KEY?.trim() || randomBytes(4).toString('hex');
const PERMISSION_POLICY = (process.env.PERMISSION_POLICY ?? 'ask').trim();
const AUTO_DISCOVER = process.env.AUTO_DISCOVER !== 'false';

/**
 * 会话使用的模型 id。
 *
 * 必须显式指定：Kiro 的 agent 在 `_meta.kiro.modelId` 为空时会回退到模型列表里的
 * `defaultModel`（见 extension.js 的 pinSessionModelId），而这个默认值由上游决定，
 * 未必可用 —— 实测中代理下发的默认模型指向的上游 TLS 证书已过期，
 * 于是会话被钉在一个永远返回空响应的模型上，表现为 "No response from model"。
 *
 * 留空则不干预，使用 Kiro 自身的默认行为。
 */
const MODEL_ID = process.env.MODEL_ID?.trim() || '';

if (!['ask', 'allow-once', 'allow-always', 'reject'].includes(PERMISSION_POLICY)) {
  console.error(`PERMISSION_POLICY 取值非法：${PERMISSION_POLICY}（可选 ask | allow-once | allow-always | reject）`);
  process.exit(2);
}

// ---------- 应用状态 ----------

const state = {
  /** @type {{port:number, token:string, pid:number}|null} */
  endpoint: null,
  /** @type {MuxClient|null} */
  client: null,
  connecting: null,
  /** 最近一次发现的诊断信息，供页面显示 */
  lastError: null,
  /**
   * 由 Kiro 下发的可用模型列表 [{ value, name }]。
   * 来源是 session/update 的 config_option_update 里 id === 'model' 那一项，
   * 它是当前唯一权威的「本机到底能用哪些模型」的信息。
   * @type {Array<{value:string,name:string}>}
   */
  modelOptions: [],
  /**
   * 最近一次收到的完整配置项集合（原样保留）。
   *
   * 实测 Kiro 会下发 5 项，id 依次为：
   *   mode(mode) / model(model) / effortLevel(thought_level) / autopilot / contentCollection
   *
   * 注意：每个会话的 currentValue 是**各会话独立**的（A 会话用 spec 不代表 B 会话也是）。
   * 因此这里只作为未知会话时的兜底，权威来源是 sessionConfig（按会话存放）。
   * @type {Array<object>}
   */
  configOptions: [],
};

/** 每个会话当前生效的模型 id（用于页面显示）。@type {Map<string,string>} */
const sessionModel = new Map();

/**
 * 每个会话当前生效的全部配置项（原样，含 currentValue）。
 *
 * 必须按会话存放：mux 会把所有会话的 config_option_update 都广播过来，
 * 若只留一份全局的，后台会话一有配置变化就会把当前会话的
 * 模型/思考程度覆盖掉，页面随之显示错误的档位。
 * @type {Map<string, Array<object>>}
 */
const sessionConfig = new Map();

/**
 * 最近一次操作的会话 id。
 * config_option_update 通知本身不带会话归属，只能靠它来判断该配置属于哪个会话。
 * @type {string|null}
 */
let activeSessionId = null;

/**
 * 会话元数据缓存（标题 + 工作目录）。
 * 来源有三处：sessions.list 命令结果、session-update 里的 session-info 事件
 * （norm.title 非空时）、session.new 的入参 cwd。
 * 用途：
 *   - permission-request 广播里的 sessionTitle 从这里取，手机端据此知道
 *     弹的是哪个会话的权限；
 *   - session.load 的 cwd 兜底 —— 新建的会话要等下一次 sessions.list 才
 *     出现在列表里，期间断线重同步若没有缓存 cwd，Kiro 会报
 *     "Invalid params"（实测 load 必须带 cwd）。
 * @type {Map<string, {title?: string, cwd?: string}>}
 */
const sessionMeta = new Map();

/**
 * 每会话事件环形缓冲（断线补发用），每会话保留最近 500 条事件信封。
 * 只记录带 sessionId 的 session 事件；governance / mux-closed 这类全局事件不入缓冲。
 * @type {Map<string, Array<{type:string, seq:number, sessionId:string, event:object}>>}
 */
const eventLog = new Map();
const EVENT_LOG_MAX = 500;

/** 浏览器连接（每个手机页面一个） */
const browsers = new Set();

/** 全局事件序号，用于页面断线补发时判断 */
let eventSeq = 0;

function log(...args) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}]`, ...args);
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of browsers) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch {}
    }
  }
}

/**
 * 广播一条带会话归属的事件；带 sessionId 的同时写入该会话环形缓冲
 * （events.resume 的数据源），无 sessionId 的（理论上仅 mux 异常帧）只广播。
 * 信封浅拷贝入缓冲，广播本体不受缓冲持有影响；超过 500 条 shift 最旧。
 */
function broadcastSessionEvent(sessionId, event) {
  const envelope = { type: 'event', seq: ++eventSeq, sessionId, event };
  if (sessionId) {
    let arr = eventLog.get(sessionId);
    if (!arr) {
      arr = [];
      eventLog.set(sessionId, arr);
    }
    arr.push({ ...envelope });
    if (arr.length > EVENT_LOG_MAX) arr.shift();
  }
  broadcast(envelope);
}

/**
 * 正在进行的 session.load 及其归属连接。
 *
 * session/load 会把整段历史以 replay:true 的帧重放下来。这些帧是
 * **发起该命令的那个连接的私有数据**，不是会话的实时活动：
 *   - 广播给其他页面会让旁观者的投影被历史清空并卡在回放态；
 *   - 写进环形缓冲会在重连补发时再送一遍历史，还会挤掉真正错过的事件。
 * 因此回放帧按连接精确投递，且不占全局 eventSeq（它们不参与补发去重）。
 *
 * conns 用连接 → 在飞 load 次数（而不是 Set）：快速连点同一会话会让同一
 * 连接并发发起多次 load，先结束的那次不得摘掉仍在飞的那次归属。
 *
 * @type {Map<string, {conns:Map<object, number>, frames:number}>}
 */
const replayTargets = new Map();

/** 登记一个正在 load 该会话的连接。 */
function addReplayTarget(sessionId, conn) {
  let entry = replayTargets.get(sessionId);
  if (!entry) {
    entry = { conns: new Map(), frames: 0 };
    replayTargets.set(sessionId, entry);
  }
  entry.conns.set(conn, (entry.conns.get(conn) ?? 0) + 1);
  return entry;
}

/** 注销一次投递登记；该连接不再有在飞 load 时移除，全部移除后删除条目。 */
function removeReplayTarget(sessionId, conn) {
  const entry = replayTargets.get(sessionId);
  if (!entry) return null;
  const n = entry.conns.get(conn) ?? 0;
  if (n <= 1) entry.conns.delete(conn);
  else entry.conns.set(conn, n - 1);
  if (entry.conns.size === 0) replayTargets.delete(sessionId);
  return entry;
}

/** 连接断开时清掉它名下所有回放投递登记（load 可能还没应答）。 */
function dropReplayTargetsOf(conn) {
  for (const [sid, entry] of replayTargets) {
    entry.conns.delete(conn);
    if (entry.conns.size === 0) replayTargets.delete(sid);
  }
}

/**
 * 投递一条回放帧：只发给该会话当前的 session.load 发起者。
 *
 * **不带 seq**：回放帧不进环形缓冲、不参与断线补发，也就不是增量时间轴上
 * 的事件。若给它分配全局 seq，会在缓冲里凭空留下序号空洞，
 * 让后续 events.resume 误判为「补不全」而退化成整段重放。
 * 前端对 seq=0 的帧不更新 lastSeq，语义正好吻合。
 *
 * 没有任何归属者时整帧丢弃：回放帧只在 load 期间产生（实测它们在该命令的
 * 应答之前就发完了），此时没有订阅者说明它不属于任何页面 —— 广播出去只会
 * 给旁观页面注入历史（清空投影、卡在回放态），比丢弃危险得多。
 */
function deliverReplayFrame(sessionId, event) {
  const entry = sessionId ? replayTargets.get(sessionId) : null;
  if (!entry) return;
  entry.frames += 1;
  const payload = JSON.stringify({ type: 'event', sessionId, event });
  for (const conn of entry.conns.keys()) {
    try { conn.send(payload); } catch {}
  }
}

function statusSnapshot() {
  return {
    connected: state.client?.isOpen ?? false,
    endpoint: state.endpoint ? { port: state.endpoint.port, pid: state.endpoint.pid } : null,
    permissionPolicy: PERMISSION_POLICY,
    lastError: state.lastError,
    agentInfo: state.client?.agentInfo ?? null,
    browsers: browsers.size,
    /** 当前会话使用的模型（若已知） */
    modelId: currentModelId(),
    modelName: modelNameOf(currentModelId()),
    /**
     * 当前会话的配置项，原样透传给页面。
     * 页面按 id 通用渲染 —— 服务端不解释其业务含义，Kiro 新增配置项无需改这里。
     */
    configOptions: currentConfigOptions(),
    /**
     * configOptions 的归属会话（= 服务端 activeSessionId）。
     * 页面据此判断这套配置显示在哪个会话上，避免把别的会话的配置张冠李戴。
     */
    configSessionId: activeSessionId,
  };
}

/**
 * 当前会话的配置项。
 * 优先取该会话自己的记录；从未收到过就退回最近一次的全局快照
 * （总比空着好：刚启动时页面还没打开任何会话，但仍需渲染模型列表）。
 */
function currentConfigOptions() {
  if (activeSessionId && sessionConfig.has(activeSessionId)) return sessionConfig.get(activeSessionId);
  return state.configOptions;
}

function currentModelId() {
  if (activeSessionId && sessionModel.has(activeSessionId)) return sessionModel.get(activeSessionId);
  return MODEL_ID || null;
}

function modelNameOf(id) {
  if (!id) return null;
  const hit = state.modelOptions.find(m => m.value === id);
  return hit?.name ?? null;
}

/**
 * 记录 Kiro 下发的会话配置（config_option_update）。
 *
 * 原样保留整份 options（不只 model）并记到会话维度 —— 页面显示
 * 「当前用什么模型、思考到什么程度」依赖它们，且每个会话的值互相独立。
 *
 * @param {Array<object>} options 配置项列表
 * @param {string|null} sessionId 归属会话；缺省时退回 activeSessionId
 */
function absorbConfigOptions(options, sessionId = null) {
  if (!Array.isArray(options) || !options.length) return;

  // 全局快照只用于「还没有任何会话」时的兜底显示
  state.configOptions = options;

  const sid = sessionId ?? activeSessionId;
  if (sid) sessionConfig.set(sid, options);

  const modelOpt = options.find(o => o?.id === 'model');
  if (modelOpt) {
    const opts = modelOpt.options ?? [];
    if (opts.length) {
      const sig = opts.map(o => o.value).join(',');
      const prev = state.modelOptions.map(o => o.value).join(',');
      state.modelOptions = opts.map(o => ({ value: o.value, name: o.name ?? o.value }));
      if (sig !== prev) log(`模型列表已更新（${opts.length} 个）：${state.modelOptions.map(m => m.name).join(', ')}`);
    }
    // 归属已知时才记会话模型。model 项的 currentValue 就是该会话当前模型，
    // 比会话维度独立维护一份更不容易和真实状态脱节。
    if (sid && modelOpt.currentValue) sessionModel.set(sid, modelOpt.currentValue);
  }
}

function pushStatus() {
  broadcast({ type: 'status', status: statusSnapshot() });
}

// ---------- mux 连接管理 ----------

async function connectMux({ force = false } = {}) {
  if (state.client?.isOpen && !force) return state.client;
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    // 若已有连接但需要重连，先关闭旧连接
    if (state.client) {
      try { state.client.close(); } catch {}
      state.client = null;
    }

    const ep = await discoverMux({ onProgress: msg => log('[discover]', msg) });
    state.endpoint = ep;
    log(`mux 端点：port=${ep.port} pid=${ep.pid} token=${ep.token.slice(0, 8)}…`);

    const client = new MuxClient({ port: ep.port, token: ep.token, role: 'observer' });

    if (PERMISSION_POLICY === 'ask') {
      // 交给手机端决策；由页面通过 resolve-permission 回填
      client.setPermissionPolicy('ask', params => requestPermissionFromPhones(params));
    } else {
      client.setPermissionPolicy(PERMISSION_POLICY);
    }

    client.on('session-update', params => {
      const norm = normalizeUpdate(params);
      // 会话归属：显式带上通知里的 sessionId，页面据此过滤
      const sid = params?.sessionId ?? activeSessionId ?? null;
      if (norm.kind === 'config-options') absorbConfigOptions(norm.options, sid);
      // 会话标题缓存：session-info 带非空标题时更新（permission-request 的
      // sessionTitle 就从这里取）。回放帧里的标题同样是历史数据，
      // 但标题只是文本、不驱动投影，照常吸收。
      if (norm.kind === 'session-info' && sid && norm.title) {
        const meta = sessionMeta.get(sid) ?? {};
        sessionMeta.set(sid, { ...meta, title: norm.title });
      }
      // 回放帧按连接精确投递（见 replayTargets 注释）：只有发起 session.load
      // 的页面需要它，广播会把历史灌进旁观页面、并挤占断线补发缓冲。
      if (norm.replay === true) {
        deliverReplayFrame(sid, norm);
      } else {
        broadcastSessionEvent(sid, norm);
      }
      if (norm.kind === 'config-options') pushStatus();
    });
    client.on('permission-respond-failed', info => {
      // _kiro/permission/respond 被拒：桌面端已先应答了这个权限。
      // 无论该请求此刻仍在待决（排队/active）、还是刚被手机应答过，
      // 都要让手机端的弹层收起：广播 permission-cleared；
      // 同时 resolve(null) 保持对 mux 静默（不再回应答）。
      const pendingHit = [...pendingPermissions.entries()]
        .find(([, p]) => p.toolCallId && p.toolCallId === info?.toolCallId);
      if (pendingHit) {
        log(`桌面端已先应答权限（${pendingHit[0]}），收起手机弹层`);
        settlePermission(pendingHit[0], { notify: 'cleared' });
        return;
      }
      const sid = info?.toolCallId ? recentlyAnswered.get(info.toolCallId) : undefined;
      if (sid !== undefined) {
        recentlyAnswered.delete(info.toolCallId);
        log(`桌面端已先应答权限（toolCallId=${info.toolCallId}），收起手机弹层`);
        broadcast({ type: 'permission-cleared', sessionId: sid });
        return;
      }
      log(`权限应答被拒（toolCallId=${info?.toolCallId}）但无对应请求，忽略`);
    });
    client.on('governance', params => {
      broadcast({ type: 'event', seq: ++eventSeq, event: { kind: 'governance', ...params } });
    });
    client.on('closed', info => {
      log(`mux 连接关闭：code=${info.code} ${info.reason || ''}`);
      state.client = null;
      broadcast({ type: 'event', seq: ++eventSeq, event: { kind: 'mux-closed', ...info } });
      pushStatus();
      // Kiro 重启后 token/端口会变，自动重新发现
      if (AUTO_DISCOVER) {
        setTimeout(() => {
          connectMux({ force: true }).catch(e => log('自动重连失败：', e.message));
        }, 1500);
      }
    });

    await client.connect();
    const init = await client.initialize();
    state.client = client;
    state.lastError = null;
    log(`已连接 mux，agent=${init?.agentInfo?.name ?? '?'} ${init?.agentInfo?.version ?? ''}`);
    pushStatus();
    return client;
  })().catch(e => {
    state.lastError = e.message;
    state.connecting = null;
    log('连接 mux 失败：', e.message);
    pushStatus();
    throw e;
  });

  try {
    return await state.connecting;
  } finally {
    state.connecting = null;
  }
}

// ---------- 权限请求转交手机端 ----------

/**
 * @typedef {object} PendingPermission
 * @property {(v:any)=>void} resolve
 * @property {NodeJS.Timeout|null} timer 仅 active 有超时计时
 * @property {string} sessionId
 * @property {string|null} toolCallId
 * @property {object|null} toolCall
 * @property {Array<object>} options
 */

/** @type {Map<string, PendingPermission>} */
const pendingPermissions = new Map();

/** FIFO 排队中的 reqId（不含当前 active）。 */
const permissionQueue = [];

/** 当前 active（已广播给手机、等待应答）的 reqId。@type {string|null} */
let activePermissionId = null;
let permSeq = 0;

/**
 * 最近被手机应答过的权限（toolCallId → sessionId）小环形记录。
 * 用途：手机应答后 mux 拒绝了 _kiro/permission/respond（桌面端已先应答），
 * 此时该请求已不在待决表中，permission-respond-failed 处理器据此仍能
 * 广播 permission-cleared 收起手机弹层。只保留最近 16 条，防无界增长。
 * @type {Map<string, string>}
 */
const recentlyAnswered = new Map();
const RECENT_ANSWERED_MAX = 16;

/**
 * 权限全量接管模型：只要有手机在线（browsers.size > 0），
 * 所有 session/request_permission 都进入 FIFO 队列 —— 同一时刻只有队首是
 * active（广播 permission-request），其余排队等待。
 *
 * active 的三种结束方式：
 *   1) 手机应答（permission.resolve → resolvePermission）；
 *   2) 5 分钟超时（广播 permission-timeout 后交回桌面端）；
 *   3) 桌面端已先应答（mux 端 _kiro/permission/respond 被拒 →
 *      广播 permission-cleared，手机收起弹层）。
 * active 结束后自动把下一个排队项提升为 active 并广播。
 *
 * 原「同一时刻只允许一个手机权限弹层」的 UX 契约保留：弹层是全屏遮罩，
 * 多开会互相覆盖、只剩最后一个可点 —— 现在以队列化实现：并发请求排队
 * 逐个弹给手机，而不是像旧实现那样把后续请求静默丢回桌面端。
 *
 * 无手机在线（browsers.size === 0）的请求不入队，立即 resolve(null)
 * 静默交回桌面端，保持原有语义。
 */
function promoteNextPermission() {
  if (activePermissionId !== null || permissionQueue.length === 0) return;
  const reqId = permissionQueue.shift();
  const p = pendingPermissions.get(reqId);
  if (!p) {
    // 请求已被外部清掉（理论不可达，防御式跳过），继续提升下一个
    promoteNextPermission();
    return;
  }
  activePermissionId = reqId;
  log(`等待手机端确认权限：${p.toolCall?.title ?? p.toolCallId ?? reqId}`);

  p.timer = setTimeout(() => {
    log(`权限请求超时（5 分钟），交回桌面端处理：${reqId}`);
    settlePermission(reqId, { notify: 'timeout', value: null });
  }, 5 * 60 * 1000);

  broadcast({
    type: 'permission-request',
    reqId,
    sessionId: p.sessionId,
    sessionTitle: sessionMeta.get(p.sessionId)?.title ?? null,
    toolCall: p.toolCall ?? null,
    options: p.options ?? [],
  });
}

function requestPermissionFromPhones(params) {
  const sessionId = params?.sessionId;

  // 静默条件：无手机在线。不入队，立即交回桌面端。
  if (browsers.size === 0 || !sessionId) {
    return Promise.resolve(null);
  }

  const reqId = `perm_${++permSeq}`;
  log(`权限请求入队（第 ${permissionQueue.length + 1} 位）：${params?.toolCall?.title ?? params?.toolCall?.toolCallId ?? reqId}`);

  return new Promise(resolve => {
    pendingPermissions.set(reqId, {
      resolve,
      timer: null,
      sessionId,
      toolCallId: params?.toolCall?.toolCallId ?? null,
      toolCall: params?.toolCall ?? null,
      options: params?.options ?? [],
    });
    permissionQueue.push(reqId);
    promoteNextPermission();
  });
}

/**
 * 结束一个权限请求（active 或排队中均可）。
 * notify: 'timeout' → 广播 permission-timeout；
 *        'cleared' → 广播 permission-cleared（带 sessionId）；
 *        其他     → 不广播。
 * 结束后自动提升下一个排队项。
 */
function settlePermission(reqId, { notify = null, value = null } = {}) {
  const p = pendingPermissions.get(reqId);
  if (!p) return false;
  if (p.timer) clearTimeout(p.timer);
  pendingPermissions.delete(reqId);

  if (activePermissionId === reqId) {
    activePermissionId = null;
    if (notify === 'timeout') broadcast({ type: 'permission-timeout', reqId });
    else if (notify === 'cleared') broadcast({ type: 'permission-cleared', sessionId: p.sessionId });
  } else {
    const i = permissionQueue.indexOf(reqId);
    if (i >= 0) permissionQueue.splice(i, 1);
  }

  p.resolve(value);
  promoteNextPermission();
  return true;
}

function resolvePermission(reqId, optionId) {
  const p = pendingPermissions.get(reqId);
  const toolCallId = p?.toolCallId;
  const sessionId = p?.sessionId;
  const ok = settlePermission(reqId, { value: optionId ?? null });
  if (ok) {
    // 记录「手机刚应答过」：若 mux 端随后拒绝这次应答（桌面端已先应答），
    // permission-respond-failed 处理器据此广播 permission-cleared 收起弹层
    if (toolCallId) {
      if (recentlyAnswered.size >= RECENT_ANSWERED_MAX) {
        recentlyAnswered.delete(recentlyAnswered.keys().next().value);
      }
      recentlyAnswered.set(toolCallId, sessionId);
    }
    log(`权限请求已处理：${reqId} -> ${optionId ?? '(拒绝)'}`);
  }
  return ok;
}

/**
 * 手机全部断开时清空 active 与整个队列，避免它们悬挂到超时。
 * 所有请求一律 resolve(null) 静默交回桌面端（保持原有语义）。
 */
function releaseAllPendingPermissions(reason) {
  if (pendingPermissions.size === 0) return;
  log(`释放 ${pendingPermissions.size} 个待决权限请求（${reason}），交由桌面端处理`);
  const ids = [...pendingPermissions.keys()];
  permissionQueue.length = 0;
  activePermissionId = null;
  for (const reqId of ids) {
    const p = pendingPermissions.get(reqId);
    if (p?.timer) clearTimeout(p.timer);
    pendingPermissions.delete(reqId);
    p.resolve(null);
  }
}

// ---------- 命令处理 ----------

/**
 * events.resume：断线补发。
 * 按会话事件环形缓冲把 seq > afterSeq 的事件补发给「发起请求的这个连接」
 * （不是 broadcast），补发帧的 event 上带 resume:true。
 * 缓冲为空、或缓冲最早 seq > afterSeq+1（说明有缺口、补不全）时：
 * 返回 {delivered:0, requiresReplay:true, lastSeq:当前全局 eventSeq} 且不补发。
 */
function handleEventsResume(params = {}, ctx = {}) {
  const sessionId = params?.sessionId;
  if (!sessionId) throw new Error('缺少 sessionId');
  const afterSeq = Number(params?.afterSeq ?? 0);
  if (!Number.isFinite(afterSeq) || afterSeq < 0) throw new Error('afterSeq 非法');
  if (typeof ctx.sendToCaller !== 'function') throw new Error('events.resume 需要连接上下文');

  const arr = eventLog.get(sessionId) ?? [];
  if (arr.length === 0 || arr[0].seq > afterSeq + 1) {
    return { delivered: 0, requiresReplay: true, lastSeq: eventSeq };
  }

  const missed = arr.filter(env => env.seq > afterSeq);
  for (const env of missed) {
    ctx.sendToCaller({
      type: 'event',
      seq: env.seq,
      sessionId: env.sessionId,
      event: { ...env.event, resume: true },
    });
  }
  return { delivered: missed.length, requiresReplay: false, lastSeq: eventSeq };
}

async function handleCommand(method, params = {}, ctx = {}) {
  // 断线补发只依赖本地环形缓冲，不依赖 mux 连接 —— mux 重连期间也要能补发
  if (method === 'events.resume') return handleEventsResume(params, ctx);

  const client = await connectMux();

  switch (method) {
    case 'status':
      return statusSnapshot();

    case 'rediscover':
      state.endpoint = null;
      await connectMux({ force: true });
      return statusSnapshot();

    case 'sessions.list': {
      const res = await client.listSessions({ cwd: params.cwd });
      const sessions = (res?.sessions ?? []).map(s => {
        // 标题与 cwd 进缓存：之后该会话的权限弹层就能带上标题，
        // 断线重同步的 session.load 也有 cwd 兜底
        if (s.sessionId) {
          const meta = sessionMeta.get(s.sessionId) ?? {};
          sessionMeta.set(s.sessionId, { ...meta, title: s.title || meta.title, cwd: s.cwd || meta.cwd });
        }
        return {
          sessionId: s.sessionId,
          cwd: s.cwd,
          title: s.title,
          updatedAt: s.updatedAt,
          agentMode: s._meta?.kiro?.agentMode,
          status: s._meta?.kiro?.status,
          executionTarget: s._meta?.kiro?.executionTarget?.kind,
          description: s._meta?.kiro?.description,
        };
      });
      return { sessions };
    }

    case 'session.new': {
      // Kiro 的 session/new 实测只接受正斜杠绝对路径（"D:\x" 报
      // "Invalid params: cwd must be an absolute path"，"D:/x" 通过），
      // 而页面新建弹层按 Windows 习惯输入反斜杠 —— 在服务端统一归一化，
      // 用户无需关心分隔符。
      const cwd = typeof params.cwd === 'string' && params.cwd.trim()
        ? params.cwd.trim().replace(/\\/g, '/')
        : undefined;
      const modelId = params.modelId || MODEL_ID || undefined;
      const res = await client.newSession({ cwd, mcpServers: [], modelId });
      if (res?.sessionId) {
        activeSessionId = res.sessionId;
        if (modelId) sessionModel.set(res.sessionId, modelId);
        // 记下新建会话的 cwd：它在下一次 sessions.list 之前不出现在列表里，
        // 期间断线重同步的 session.load 需要这个 cwd 兜底（实测 load 必须带 cwd）。
        if (cwd) {
          const meta = sessionMeta.get(res.sessionId) ?? {};
          sessionMeta.set(res.sessionId, { ...meta, cwd });
        }
      }
      // 新建会话的返回值带完整 configOptions（实测 5 项）。必须吸收 ——
      // 否则页面会继续显示上一个会话的模型与思考程度，而新会话未必用同一套。
      absorbConfigOptions(res?.configOptions, res?.sessionId);
      pushStatus();
      return res;
    }

    case 'session.load': {
      // 注意：只套用显式指定的 modelId —— 载入是读历史，不应静默改掉已有会话的模型，
      // 否则手机上翻一下历史就会改掉你桌面上那个会话的模型。
      const modelId = params.modelId || undefined;
      // cwd 兜底：新建会话尚未进入 sessions.list 时前端拿不到 cwd，
      // 这里用缓存的创建 cwd 补上（实测缺 cwd 会报 "Invalid params"）。
      const cwd = params.cwd || sessionMeta.get(params.sessionId)?.cwd;
      // 回放帧（replay:true）只发给本连接：登记投递目标，覆盖整个 load 期间
      // （实测回放帧在 load 的应答之前就发完了，必须在发请求之前登记）。
      const conn = ctx.conn ?? null;
      if (!conn) throw new Error('session.load 需要连接上下文');
      addReplayTarget(params.sessionId, conn);
      let res;
      try {
        res = await client.loadSession({
          sessionId: params.sessionId,
          cwd,
          mcpServers: [],
          modelId,
        });
      } finally {
        const stat = removeReplayTarget(params.sessionId, conn);
        if (stat?.frames) log(`会话回放已投递 ${stat.frames} 帧（仅发起连接）：${params.sessionId}`);
      }
      activeSessionId = params.sessionId;
      if (modelId) sessionModel.set(params.sessionId, modelId);
      // 载入的返回值同样带 configOptions，吸收它页面才知道这个会话
      // 实际用的是什么模型、什么思考程度（可能与上一个会话不同）。
      absorbConfigOptions(res?.configOptions, params.sessionId);
      pushStatus();
      return res;
    }

    case 'session.setModel': {
      if (!params.sessionId) throw new Error('缺少 sessionId');
      if (!params.modelId) throw new Error('缺少 modelId');
      activeSessionId = params.sessionId;
      const res = await client.setModel({ sessionId: params.sessionId, modelId: params.modelId });
      sessionModel.set(params.sessionId, params.modelId);
      // 换模型会连带改变思考程度的可用档位（模型 hasEffort=false 时该项整个消失，
      // 切回支持的模型则重置为它的 defaultEffortLevel）。返回值里带的就是最新配置，
      // 直接吸收，避免页面还显示着上一个模型的档位。
      absorbConfigOptions(res?.configOptions, params.sessionId);
      pushStatus();
      return res;
    }

    /**
     * 切换任意会话配置项。
     *
     * 目前页面用它切 effortLevel（思考程度）。做成通用命令而非只做思考程度：
     * 配置项由 Kiro 下发、对服务端是不透明数据，写死 id 会在 Kiro 新增/改名时失效。
     */
    case 'session.setConfigOption': {
      if (!params.sessionId) throw new Error('缺少 sessionId');
      if (!params.configId) throw new Error('缺少 configId');
      if (params.value === undefined) throw new Error('缺少 value');
      activeSessionId = params.sessionId;
      const res = await client.setConfigOption({
        sessionId: params.sessionId,
        configId: params.configId,
        value: params.value,
      });
      // 返回值里带全部配置项的最新值，直接吸收，避免页面靠本地推测状态。
      absorbConfigOptions(res?.configOptions, params.sessionId);
      pushStatus();
      return res;
    }

    case 'session.prompt': {
      if (!params.sessionId) throw new Error('缺少 sessionId');
      if (!params.text?.trim()) throw new Error('内容为空');
      activeSessionId = params.sessionId;
      try {
        const res = await client.prompt({ sessionId: params.sessionId, text: params.text });
        return res;
      } finally {
        // 提示词结束后，若手机上还留着属于该会话的权限弹层，通知它收起。
        broadcast({ type: 'permission-cleared', sessionId: params.sessionId });
      }
    }

    case 'session.cancel': {
      const res = await client.cancel(params.sessionId);
      return res ?? { cancelled: true };
    }

    case 'session.setMode': {
      return await client.setMode({ sessionId: params.sessionId, modeId: params.modeId });
    }

    case 'permission.resolve': {
      return { resolved: resolvePermission(params.reqId, params.optionId) };
    }

    default:
      throw new Error(`未知命令：${method}`);
  }
}

// ---------- HTTP ----------

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function getLanAddresses() {
  const out = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // 页面本身不含数据，允许无密钥加载，再通过 key 查询参数完成鉴权
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = await readFile(path.join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('无法读取 index.html：' + e.message);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// ---------- WebSocket（浏览器侧） ----------

// 极简 WebSocket 服务端实现（RFC 6455 子集：文本帧、ping/pong、close）
// 选择自实现是为了保持"零依赖"，避免要求用户 npm install。
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = url.searchParams.get('key') ?? '';
  if (!safeEqual(key, ACCESS_KEY)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto_accept(wsKey);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const conn = createWsConn(socket, log);
  browsers.add(conn);
  log(`手机端已连接（当前 ${browsers.size} 个）`);

  conn.send(JSON.stringify({ type: 'status', status: statusSnapshot() }));
  conn.send(JSON.stringify({ type: 'hello', permissionPolicy: PERMISSION_POLICY }));

  if (AUTO_DISCOVER) {
    connectMux().then(
      () => conn.send(JSON.stringify({ type: 'status', status: statusSnapshot() })),
      () => conn.send(JSON.stringify({ type: 'status', status: statusSnapshot() }))
    );
  }

  conn.onMessage(async text => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg?.type !== 'cmd') return;

    const { id, method, params } = msg;
    try {
      // ctx 把「本连接」传给命令处理器：session.load 据此把历史回放帧只发给
      // 发起者（见 replayTargets），events.resume 据此把补发帧只发给请求者
      // （sendToCaller），都不走 broadcast。
      const result = await handleCommand(method, params, {
        conn,
        sendToCaller: o => conn.send(JSON.stringify(o)),
      });
      conn.send(JSON.stringify({ type: 'res', id, ok: true, result }));
    } catch (e) {
      conn.send(JSON.stringify({ type: 'res', id, ok: false, error: e?.message ?? String(e) }));
    }
  });

  conn.onClose(() => {
    browsers.delete(conn);
    dropReplayTargetsOf(conn);
    log(`手机端断开（剩余 ${browsers.size} 个）`);
    if (browsers.size === 0) releaseAllPendingPermissions('手机端全部断开');
  });
});

// WebSocket 帧编解码已抽取到 lib/miniws.mjs（与测试 mock mux 共用同一实现）。

// ---------- 启动 ----------

server.listen(PORT, HOST, async () => {
  const addrs = getLanAddresses();
  const lines = [
    '',
    '  局域网遥控已启动（独立程序，未安装任何扩展）',
    '  ────────────────────────────────────────────',
  ];
  for (const a of addrs) lines.push(`  手机访问：http://${a.address}:${PORT}/?key=${ACCESS_KEY}   (${a.name})`);
  if (addrs.length === 0) lines.push(`  未检测到局域网 IPv4 地址，请检查网络`);
  lines.push(`  本机访问：http://127.0.0.1:${PORT}/?key=${ACCESS_KEY}`);
  lines.push(`  权限策略：${PERMISSION_POLICY}${PERMISSION_POLICY === 'ask' ? '（每次工具调用需在手机上确认）' : ''}`);
  lines.push(
    MODEL_ID
      ? `  指定模型：${MODEL_ID}`
      : `  指定模型：（未指定，使用 Kiro 会话默认；若新会话报 "No response from model"，用 MODEL_ID 指定一个可用模型）`
  );
  lines.push('  停止服务：Ctrl+C');
  lines.push('');
  console.log(lines.join('\n'));

  if (AUTO_DISCOVER) {
    connectMux().catch(e => log('首次连接 mux 失败：', e.message));
  }
});

process.on('SIGINT', () => {
  log('正在关闭…');
  for (const ws of browsers) { try { ws.close(); } catch {} }
  try { state.client?.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
