/**
 * 回合 reducer —— 原 public/index.html 里那套「DOM 即状态」的回合状态机，
 * 在此抽象为纯数据操作。本文件不依赖 Vue、不依赖 DOM，可直接用 node:test 覆盖。
 *
 * 三条不可偏离的业务契约（都来自原实现的注释与实测行为）：
 *
 * 1. **文本归属**：同一回合里的文本有两种身份 —— 与工具调用交错的「过程叙述」
 *    （随面板折叠）与本回合末尾的「最终答案」（展平可见）。
 *    流式时无法预知后面还有没有工具调用，所以先按「回合级文本块」承接：
 *    一旦出现工具调用（demoteAnswer）就搬进面板，收尾时（promoteProc）
 *    再把面板里最后一段提升为答案。
 *
 * 2. **定稿是单向门**：settled 之后到达的文本一律进可见答案区，绝不再回填面板。
 *    分片与 prompt 响应走两条独立写出路径，响应可能早于最后一批分片 ——
 *    那段迟到内容正是本回合的结论，塞进已收起的面板就等于丢失。
 *
 * 3. **finishTurn 必须幂等**：重复调用不能把过程块逐个搬进答案区。
 *
 * 契约 v2 补充：
 * 4. **思考块**：thought 只进过程面板，永不提升为答案；连续分片**流式续写**
 *    当前思考块（与 appendProc 同规则），被工具/过程叙述/收尾切断时才另起新段；
 *    收尾时封口并定格耗时。
 * 5. **resume 补发帧**：不触发回放状态机（不 clearMessages、不动 replaying），
 *    但创建的块等同回放块（replay 标记 true、不记计时）。实时帧判据为
 *    `animateLive(state) && !event.resume`。
 */

import {
  createTextBlock,
  nextId,
  type ConversationItem,
  type SystemBlock,
  type TextBlock,
  type ThoughtBlock,
  type ToolBlock,
  type Turn,
  type TurnStatus,
} from './messageModel.ts';
import type {
  AssistantTextEvent,
  SessionInfoEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolCallUpdateEvent,
  TurnCompletionEvent,
  UserTextEvent,
} from '../protocol/types.ts';
import { isExpandable, toolTitle } from './toolModel.ts';

/** 会话投影状态。等价于原实现里那一堆闭包变量 + #msgs 的 DOM 树。 */
export interface ConversationState {
  sessionId: string | null;
  /** 有序内容：回合与回合外的系统提示。 */
  items: ConversationItem[];
  activeTurnId: string | null;

  /** 是否处于 session/load 历史回放阶段。 */
  replaying: boolean;
  /** 最近一次收到的事件序号（服务端全局 eventSeq）。第二阶段用于断线补发。 */
  lastSeq: number;

  /** 当前正在写入的过程叙述块 id（等价于 procEl）。 */
  openProcBlockId: string | null;
  /** 当前打开的思考块 id。同一时刻最多一个；封口/清空置 null。 */
  openThoughtBlockId: string | null;
  /** 打开中的用户气泡（等价于 userBubble + userMsgId）。 */
  openUserBubble: { turnId: string; messageId?: string } | null;

  /** 本页已显示、尚未被 Kiro 回显消耗掉的剩余文本（等价于 localEchoRemainder）。 */
  localEchoRemainder: string | null;

  /**
   * toolCallId → rawInput 缓存。
   * 权限请求帧里的 toolCall 只有 toolCallId/status/title，不带参数；
   * 判定「允许 / 拒绝」必须能看到操作对象，所以在此留存供权限面板回查。
   */
  toolInputs: Map<string, unknown>;
}

export function createConversationState(): ConversationState {
  return {
    sessionId: null,
    items: [],
    activeTurnId: null,
    replaying: false,
    lastSeq: 0,
    openProcBlockId: null,
    openThoughtBlockId: null,
    openUserBubble: null,
    localEchoRemainder: null,
    toolInputs: new Map(),
  };
}

/**
 * 是否给新插入的节点加淡入动画。回放是在重建历史，整屏历史淡入既无意义又拖慢打开速度。
 * 契约 v2：resume 补发帧虽不处于回放态，但创建的块等同回放块 —— 调用侧
 * 以 `animateLive(state) && !event.resume` 作为「实时」判据。
 */
export function animateLive(state: ConversationState): boolean {
  return !state.replaying;
}

function activeTurn(state: ConversationState): Turn | null {
  if (!state.activeTurnId) return null;
  const items = state.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'turn' && it.id === state.activeTurnId) return it;
  }
  return null;
}

function findTextBlock(turn: Turn, id: string): TextBlock | null {
  if (turn.answer && turn.answer.id === id) return turn.answer;
  for (const b of turn.process) {
    if (b.type === 'text' && b.id === id) return b;
  }
  return null;
}

// ---------- 回合生命周期 ----------

function createTurn(state: ConversationState): Turn {
  const turn: Turn = {
    type: 'turn',
    id: nextId('turn'),
    sessionId: state.sessionId ?? '',
    userMessage: null,
    process: [],
    answer: null,
    workVisible: false,
    panelVisible: false,
    expanded: false,
    actionsVisible: false,
    actionTime: null,
    status: 'running',
    settled: false,
    startedAt: null,
    frozenMs: null,
    finishedAt: null,
    stopReason: null,
    toolCount: 0,
    thoughtCount: 0,
    replay: state.replaying,
  };
  state.items.push(turn);
  state.activeTurnId = turn.id;
  state.openProcBlockId = null;
  state.openThoughtBlockId = null;
  state.openUserBubble = null;
  return turn;
}

/**
 * 开启新回合；上一回合随之收尾。
 *
 * 顺序关键：先用**旧的** activeTurn 收尾，再重置 openProcBlockId / 气泡窗口；
 * settled 由新回合自己的 false 初值保证。
 */
export function newTurn(state: ConversationState): Turn {
  finishTurn(state);
  const turn = createTurn(state);
  return turn;
}

/** 确保存在当前回合（仅 appendAssistant 需要，用户消息必须显式开新回合）。 */
function ensureTurn(state: ConversationState): Turn {
  return activeTurn(state) ?? createTurn(state);
}

/** 分割线（工作过程折叠条）出现。每个回合都会有。 */
function ensureDivider(turn: Turn): void {
  turn.workVisible = true;
}

/**
 * 过程面板创建。只有出现过工具调用才创建 ——
 * 纯问答回合不会凭空多出一个空面板。
 */
function ensureWork(turn: Turn): void {
  turn.workVisible = true;
  turn.panelVisible = true;
}

/** 操作条出现；时间只对实时回合诚实可得。 */
function ensureActions(state: ConversationState, turn: Turn): void {
  if (turn.actionsVisible) return;
  turn.actionsVisible = true;
  turn.actionTime = animateLive(state) ? new Date().toISOString() : null;
}

/** 本页发起的回合从此刻开始计时。 */
export function startTurnTimer(state: ConversationState): void {
  const turn = activeTurn(state);
  if (!turn) return;
  ensureDivider(turn);
  turn.startedAt = Date.now();
  turn.frozenMs = null;
}

/** 定格时长：结束后不再跳动。 */
function freezeWork(turn: Turn): void {
  if (turn.startedAt && turn.frozenMs == null) {
    turn.frozenMs = Date.now() - turn.startedAt;
  }
}

const CANCEL_REASONS = new Set(['cancelled', 'canceled', 'aborted']);

/**
 * 依据结束原因更新回合状态。
 * cancelled 是黏性的：一旦确认取消，后续的 'completed' 不得把它改回去。
 */
function applyFinishReason(turn: Turn, reason?: FinishReason, authoritative = false): void {
  if (!reason) {
    if (turn.status === 'running') turn.status = 'completed';
    return;
  }
  if (reason === 'cancelled') {
    turn.status = 'cancelled';
    turn.stopReason = 'cancelled';
    return;
  }
  // 取消命令的响应不是 turnEnd。若 prompt 响应先到，保持 cancelling，
  // 等可靠的 turnEnd.stopReason 决定最终状态，不伪造 completed。
  if (turn.status === 'cancelling' && reason === 'completed' && !authoritative) return;
  if (turn.status === 'cancelled' && !authoritative) return; // 已被确认取消，不再改回
  turn.status = reason === 'failed' ? 'failed' : 'completed';
  if (reason === 'failed') turn.stopReason = 'failed';
}

export type FinishReason = 'completed' | 'cancelled' | 'failed';

/** 把 ACP 的 stopReason 映射为结束原因。 */
export function stopReasonToFinishReason(stopReason: string | null | undefined): FinishReason {
  if (!stopReason) return 'completed';
  if (CANCEL_REASONS.has(stopReason)) return 'cancelled';
  if (stopReason === 'failed' || stopReason === 'error') return 'failed';
  return 'completed';
}

/**
 * 回合收尾：定稿 → 定格时长 → 提升末段为答案 → 收起面板。
 *
 * **幂等**：重复调用只收起面板。若允许重复收尾，第二次会把面板里剩余的
 * 过程叙述继续搬进答案区，一条完整回复会被拆成多块。
 */
export function finishTurn(
  state: ConversationState,
  reason?: FinishReason,
  authoritative = false
): void {
  const turn = activeTurn(state);
  if (!turn) return;

  // session/cancel 的 notification 已发出不代表回合已停止；
  // 非权威的 prompt 响应或异常不能提前定稿，必须等待 turnEnd。
  if (turn.status === 'cancelling' && !authoritative) return;

  if (turn.settled) {
    turn.expanded = false;
    applyFinishReason(turn, reason, authoritative);
    return;
  }

  turn.settled = true;
  turn.finishedAt = Date.now();
  freezeWork(turn);
  // 定稿同时封口思考块并定格其耗时；openThoughtBlockId 随之清空（幂等：
  // 定稿路径只走一次，迟到的思考分片会另开新块留痕）
  closeThoughtBlock(state, true);
  promoteProc(state, turn);
  turn.expanded = false;
  applyFinishReason(turn, reason, authoritative);
}

/**
 * 把过程叙述里尚未落盘的增量「封口」。
 * 工具调用会切断当前叙述块（后续文本另开新块，以还原过程节奏），
 * 切断即丢弃写入槽位，因此必须先封闭。
 */
function closeProcBlock(state: ConversationState): void {
  if (!state.openProcBlockId) return;
  const turn = activeTurn(state);
  if (turn) {
    const b = findTextBlock(turn, state.openProcBlockId);
    if (b) b.closed = true;
  }
  state.openProcBlockId = null;
}

/**
 * 封口当前思考块。
 *
 * @param freeze 定格耗时。只有回合收尾定格（契约 v2：思考块计时只在收尾冻结）；
 *   被后续分片/事件打断的封口只关块，不产耗时。
 */
function closeThoughtBlock(state: ConversationState, freeze = false): void {
  if (!state.openThoughtBlockId) return;
  const turn = activeTurn(state);
  if (turn) {
    for (const b of turn.process) {
      if (b.type === 'thought' && b.id === state.openThoughtBlockId) {
        b.closed = true;
        if (freeze && b.startedAt != null && b.frozenMs == null) {
          b.frozenMs = Date.now() - b.startedAt;
        }
        break;
      }
    }
  }
  state.openThoughtBlockId = null;
}

/**
 * 把回合级文本块降级为过程叙述：本回合出现首个工具调用时调用。
 *
 * 内容与顺序都不变，只是换了归属，因此不会让已显示的文字跳变。
 * 空白段直接丢弃（与原实现一致）—— 它不属于任何有意义的过程叙述。
 */
function demoteAnswer(turn: Turn): void {
  const ans = turn.answer;
  turn.answer = null;
  if (!ans) return;
  if (ans.raw.trim()) {
    ans.closed = true;
    turn.process.push(ans);
  }
}

/**
 * 把面板里最后一段叙述提升为答案：回合收尾时调用。
 *
 * 判据必须是「面板里最后一块叙述」，而不是「当前正在写入的块」——
 * 后者会在结论之后再出现工具调用时被封闭，导致收尾时无块可提升，
 * 整段结论被关进折叠区（这正是「结果全丢进工作过程里」的成因）。
 *
 * 只提升最后一段：中间的叙述属于过程，应留在折叠区内，
 * 否则正文会被过程说明淹没。
 *
 * 只认 `type === 'text'`：思考块（thought）与工具行永不提升为答案 ——
 * 思考是过程的一部分，纯思考回合收尾后 answer 保持 null。
 */
function promoteProc(state: ConversationState, turn: Turn): void {
  for (let i = turn.process.length - 1; i >= 0; i--) {
    const b = turn.process[i];
    if (b.type !== 'text') continue;
    turn.process.splice(i, 1); // 移出面板
    b.closed = true;
    if (state.openProcBlockId === b.id) state.openProcBlockId = null;
    turn.answer = b;
    return;
  }
}

/**
 * 回放结束后的显式收尾。
 *
 * session/load 的历史末回合没有实时 turnEnd，若不显式收尾会一直显示「运行中」。
 * 同时收起所有仍展开的面板 —— 历史过程默认折叠。
 *
 * 这里必须同时退出回放态：会话载入完成即是回放的终点，页面上的
 * 「正在重建历史…」横幅与回放态样式都由该标志驱动，不复位就不会消失。
 * （已创建块的 replay 标记是创建时捕获的，不受此复位影响。）
 */
export function settleReplayed(state: ConversationState): void {
  finishTurn(state);
  state.replaying = false;
  for (const it of state.items) {
    if (it.type === 'turn') it.expanded = false;
  }
}

/** 清理会话投影。对应原实现的 clearMsgs —— 清领域状态，不碰 DOM。 */
export function clearMessages(state: ConversationState): void {
  state.items = [];
  state.activeTurnId = null;
  state.openProcBlockId = null;
  state.openThoughtBlockId = null;
  state.openUserBubble = null;
  state.localEchoRemainder = null;
  state.toolInputs.clear();
}

/** 追加一条回合外的系统提示。 */
export function addSystem(state: ConversationState, text: string, level: 'sys' | 'err' = 'sys'): SystemBlock {
  const block: SystemBlock = {
    type: 'system',
    id: nextId('sys'),
    text,
    level,
    replay: !animateLive(state),
  };
  // 系统提示不属于任何回合：插入到末尾，但保持 activeTurn 不变
  state.items.push(block);
  return block;
}

// ---------- 文本与思考写入 ----------

/**
 * 过程叙述：写进工作过程面板，与工具行按发生顺序交错。
 * @param replay 新建块时使用的回放标记（resume 帧等同回放块）
 */
function appendProc(state: ConversationState, turn: Turn, text: string, replay: boolean): void {
  let block = state.openProcBlockId ? findTextBlock(turn, state.openProcBlockId) : null;
  // 找不到（已被提升/封口）就另开新块，保证与工具行的顺序仍然正确
  if (!block || block !== findProcessText(turn, state.openProcBlockId)) {
    block = createTextBlock(nextId('proc'), replay);
    turn.process.push(block);
    state.openProcBlockId = block.id;
  }
  block.raw += text;
}

function findProcessText(turn: Turn, id: string | null): TextBlock | null {
  if (!id) return null;
  for (const b of turn.process) {
    if (b.type === 'text' && b.id === id) return b;
  }
  return null;
}

/** 按 id 在回合过程区定位思考块（流式续写的查找入口）。 */
function findThoughtBlock(turn: Turn, id: string | null): ThoughtBlock | null {
  if (!id) return null;
  for (const b of turn.process) {
    if (b.type === 'thought' && b.id === id) return b;
  }
  return null;
}

/** 最终答案：展平在对话流里（位于过程面板之后）。 */
function appendAnswer(turn: Turn, text: string, replay: boolean): void {
  if (!turn.answer) turn.answer = createTextBlock(nextId('ans'), replay);
  turn.answer.raw += text;
}

/**
 * 追加助手文本。
 *
 * 归属判据 = `panelVisible && !settled`：
 *   面板已建且未定稿 → 过程叙述（与工具行交错）
 *   面板未建        → 答案（纯问答回合不会凭空多出面板）
 *   已定稿          → 答案（迟到分片必须可见）
 */
export function appendAssistantText(state: ConversationState, event: AssistantTextEvent): void {
  closeUserBubble(state);
  const turn = ensureTurn(state);
  ensureDivider(turn);
  ensureActions(state, turn);
  // 切块规则：过程叙述到达封口当前思考块，后续思考另起新段
  closeThoughtBlock(state);

  // resume 补发帧创建的块等同回放块（契约 v2）：不播放淡入
  const replayBlock = !animateLive(state) || event.resume === true;

  if (turn.panelVisible && !turn.settled) appendProc(state, turn, event.text, replayBlock);
  else appendAnswer(turn, event.text, replayBlock);
}

/**
 * 追加思考流分片（流式累积语义）。
 *
 * 思考分片是连续小帧：与 appendProc 同规则续写当前思考块 ——
 * `openThoughtBlockId` 在活动回合里能找到且未封口就直接 `raw += text`；
 * 找不到（首帧/已被工具、过程叙述、收尾切断）才新建块，此时才
 * thoughtCount+1 并按实时判据记 startedAt。
 * 思考块永不提升为答案（promoteProc 只挑 text 块）。
 *
 * 计时只对实时帧生效：`animateLive(state) && !event.resume` 为真才记
 * startedAt；回放/resume 创建的块耗时无意义，定格发生在回合收尾。
 */
export function appendThought(state: ConversationState, event: ThoughtEvent): void {
  const turn = ensureTurn(state);
  ensureWork(turn);
  if (!turn.settled) demoteAnswer(turn);
  // 切块规则：思考到达先封口当前过程叙述，保证叙述/思考各成段且顺序可读
  closeProcBlock(state);

  const live = animateLive(state) && !event.resume;
  let block = state.openThoughtBlockId ? findThoughtBlock(turn, state.openThoughtBlockId) : null;
  if (!block || block.closed) {
    block = {
      type: 'thought',
      id: nextId('thought'),
      raw: '',
      streaming: true,
      closed: false,
      replay: !live,
      startedAt: live ? Date.now() : null,
      frozenMs: null,
    };
    turn.process.push(block);
    state.openThoughtBlockId = block.id;
    turn.thoughtCount += 1;
  }
  if (live && !turn.settled) turn.expanded = true;
  block.raw += event.text;
}

// ---------- 用户消息 ----------

/** 关闭用户气泡合并窗口。回复、工具调用、新回合都会调用。 */
export function closeUserBubble(state: ConversationState): void {
  state.openUserBubble = null;
  state.localEchoRemainder = null;
}

/** 本页发送一条消息后，记录待跳过的回显文本（去重基准）。 */
export function markLocalEcho(state: ConversationState, text: string): void {
  state.openUserBubble = null;
  state.localEchoRemainder = text;
}

function appendUserBubbleText(state: ConversationState, turn: Turn, text: string): void {
  if (!turn.userMessage) {
    turn.userMessage = { id: nextId('user'), text: '' };
  }
  turn.userMessage.text += text;
  state.openUserBubble = { turnId: turn.id, messageId: turn.userMessage.messageId };
}

/**
 * 追加用户消息（可能是分片）。
 *
 * Kiro 会把一条长消息切成多个 user_message_chunk 发下来。若每片都开新回合，
 * 同一句话会在界面上裂成多个气泡，每片还会把上一回合的面板反复收起。
 *
 * 合并规则（两种，按优先级）：
 *   1. echo 去重：本页发出的消息被 Kiro 回显回来时，按**剩余串前缀**逐段消耗。
 *   2. messageId 合并：与当前打开的气泡同属一条才累加；
 *      协议未给 messageId 时退化为「相邻性」—— 一段对话里 user/assistant 交替，
 *      因此相邻的连续 user 分片必然同属一条。回复或工具调用一到就关闭窗口。
 */
export function appendUserText(state: ConversationState, event: UserTextEvent): void {
  const text = event.text || '';
  if (!text) return;

  const remainder = state.localEchoRemainder;
  if (remainder && remainder.indexOf(text) === 0) {
    state.localEchoRemainder = remainder.slice(text.length) || null;
    return;
  }

  const open = state.openUserBubble;
  if (open) {
    const turn = findTurn(state, open.turnId);
    // e.messageId === undefined → 协议未给，按相邻性合并
    // 否则必须同 messageId 才合并；已有 id 而新片无 id（或反之）不合并
    const sameMessage =
      event.messageId === undefined || event.messageId === open.messageId;
    if (turn && sameMessage) {
      appendUserBubbleText(state, turn, text);
      return;
    }
  }

  // 新消息 → 新回合
  const turn = createTurn(state);
  turn.userMessage = {
    id: nextId('user'),
    text,
    messageId: event.messageId,
  };
  state.openUserBubble = { turnId: turn.id, messageId: event.messageId };
}

function findTurn(state: ConversationState, id: string): Turn | null {
  for (const it of state.items) {
    if (it.type === 'turn' && it.id === id) return it;
  }
  return null;
}

// ---------- 工具调用 ----------

/**
 * 工具调用首帧。
 *
 * 顺序关键（与原实现一致）：
 *   1. 先建面板（否则 demote 无处可放）；
 *   2. 未定稿才 demote —— 动手前的说明搬进过程区；
 *   3. 封口当前叙述块；
 *   4. 计数 +1（**只在此处计数**，update 不重复计）；
 *   5. 实时且未定稿才自动展开。
 */
export function addToolCall(state: ConversationState, event: ToolCallEvent): void {
  const turn = ensureTurn(state);
  ensureWork(turn);

  if (!turn.settled) demoteAnswer(turn);
  closeProcBlock(state);
  // 切块规则：工具调用同时封口思考块，后续思考另起新段
  closeThoughtBlock(state);

  turn.toolCount += 1;

  // resume 补发帧等同回放块：不记计时、不自动展开、不播放淡入。
  // 重放帧例外：带 Kiro 帧级 timestamp（重放历史里唯一的耗时来源），
  // 记下首帧时间供 update 帧相减还原真实耗时。
  const live = animateLive(state) && !event.resume;
  if (live && !turn.settled) turn.expanded = true;

  if (event.rawInput !== undefined) state.toolInputs.set(event.toolCallId, event.rawInput);
  const raw = event.rawInput !== undefined ? event.rawInput : state.toolInputs.get(event.toolCallId);

  const frameTs = event.timestamp ? Date.parse(event.timestamp) : NaN;
  const block: ToolBlock = {
    type: 'tool',
    id: nextId('tool'),
    toolCallId: event.toolCallId,
    title: toolTitle(event.title, event.toolKind),
    toolKind: event.toolKind,
    status: event.status,
    rawInput: raw,
    expandable: isExpandable(raw),
    expanded: false,
    replay: !live,
    startedAt: live ? Date.now() : !Number.isNaN(frameTs) ? frameTs : null,
    finishedMs: null,
    output: event.content ?? [],
    waiting: false,
  };
  turn.process.push(block);
}

/** completed/failed 视为工具行结束，才定格耗时。 */
function isDoneStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * 就地应用一条 update：状态、耗时定格、输出覆盖。
 * 耗时只在未定格过时记录（重复 update 不覆盖已有 finishedMs）：
 *   - 实时帧：now − startedAt（本页时钟）；
 *   - 重放帧：update 帧 timestamp − 首帧 timestamp（Kiro 帧级时间戳，
 *     这是重放历史里唯一真实的单工具耗时来源）。
 */
function applyToolUpdate(state: ConversationState, block: ToolBlock, event: ToolCallUpdateEvent): void {
  block.status = event.status;
  const live = animateLive(state) && !event.resume;
  if (block.finishedMs == null && isDoneStatus(event.status)) {
    if (live) {
      block.finishedMs = block.startedAt == null ? null : Date.now() - block.startedAt;
    } else if (event.timestamp && block.startedAt != null) {
      const endTs = Date.parse(event.timestamp);
      if (!Number.isNaN(endTs)) {
        block.finishedMs = Math.max(0, endTs - block.startedAt);
      }
    }
  }
  // content 非空才覆盖：update 帧缺省时保留既有输出
  if (event.content && event.content.length) block.output = event.content;
}

/**
 * 工具状态更新。
 *
 * 只改状态类与耗时/输出：不改标题/操作对象、不更新参数缓存、不重复计数。
 * 按 toolCallId 定位，绝不生成重复行；找不到首帧（乱序）时按新工具处理，
 * 并对新行同步同一套状态/耗时/输出规则。
 */
export function updateToolCall(state: ConversationState, event: ToolCallUpdateEvent): void {
  const turn = activeTurn(state);
  if (turn) {
    for (let i = turn.process.length - 1; i >= 0; i--) {
      const b = turn.process[i];
      if (b.type === 'tool' && b.toolCallId === event.toolCallId) {
        applyToolUpdate(state, b, event);
        return;
      }
    }
  }
  // 没有首帧 → 当新工具处理（等价于原实现 updateTool 的 `if (!el) addTool(e)`）
  addToolCall(state, {
    kind: 'tool-call',
    toolCallId: event.toolCallId,
    title: event.title,
    status: event.status,
    content: event.content,
    replay: event.replay,
  });
  // 乱序兜底：对新行同步耗时规则（startedAt 刚记下，completed/failed 立即定格）
  const created = activeTurn(state);
  if (created) {
    for (let i = created.process.length - 1; i >= 0; i--) {
      const b = created.process[i];
      if (b.type === 'tool' && b.toolCallId === event.toolCallId) {
        applyToolUpdate(state, b, event);
        return;
      }
    }
  }
}

/**
 * 设置某个工具行的权限等待标记。
 * 只在当前活动回合内定位；找不到（非当前会话/回合、或行不存在）静默返回。
 */
export function setToolWaiting(state: ConversationState, toolCallId: string, waiting: boolean): void {
  const turn = activeTurn(state);
  if (!turn) return;
  for (let i = turn.process.length - 1; i >= 0; i--) {
    const b = turn.process[i];
    if (b.type === 'tool' && b.toolCallId === toolCallId) {
      b.waiting = waiting;
      return;
    }
  }
}

/** 会话信息事件：标题更新 + 回合结束信号。 */
export function applySessionInfo(
  state: ConversationState,
  event: SessionInfoEvent,
  onTitle?: (title: string) => void
): void {
  // turnEnd 是「电脑端发起、手机旁观」的回合唯一结束依据 ——
  // 那种回合没有本页发起的 prompt 响应可等，缺了它面板永不折叠、结论被关在里面。
  if (event.turnEnd) {
    finishTurn(state, stopReasonToFinishReason(event.turnEnd.stopReason), true);
  }
  if (event.title && onTitle) onTitle(event.title);
}

/**
 * 回合完成统计（_meta.kiro.kind='turn_completion'，带真实 elapsedTime 毫秒）。
 *
 * 帧序上它先于 turn_end：turnEnd 负责收尾（settled/提升/收起），这里只负责
 * 把真实耗时写进回合 —— 包括已经收尾的回合（重放历史里本回合没有 startedAt，
 * freezeWork 拿不到值，frozenMs 只能从这里来）。已有人工定格值时不覆盖。
 * 事件流里本帧落在该回合末尾，activeTurn 仍指向它；下一条用户消息才会开新回合。
 */
export function applyTurnCompletion(state: ConversationState, event: TurnCompletionEvent): void {
  const turn = activeTurn(state);
  if (!turn || event.elapsedTimeMs == null) return;
  if (turn.frozenMs == null) turn.frozenMs = Math.max(0, event.elapsedTimeMs);
}

// ---------- 取消与权限状态 ----------

/** 用户点击停止：进入 cancelling，但不当作已取消 —— 等 turnEnd.stopReason 确认。 */
export function markCancelling(state: ConversationState): void {
  const turn = activeTurn(state);
  if (turn && !turn.settled) turn.status = 'cancelling';
}

/** 取消命令发送失败：让当前回合回到可继续运行状态。 */
export function restoreCancelling(state: ConversationState): void {
  const turn = activeTurn(state);
  if (turn && !turn.settled && turn.status === 'cancelling') turn.status = 'running';
}

/** 权限等待：让当前回合与工具行附近有明确视觉状态。 */
export function markWaitingPermission(state: ConversationState): void {
  const turn = activeTurn(state);
  if (turn && !turn.settled) turn.status = 'waiting-permission';
}

/** 权限请求结束（已应答/超时/交回），回到运行中。 */
export function clearWaitingPermission(state: ConversationState): void {
  const turn = activeTurn(state);
  if (turn && turn.status === 'waiting-permission') turn.status = 'running';
}

/** 失败标记：保留已产生的文本与工具行，只改状态。 */
export function markFailed(state: ConversationState): void {
  const turn = activeTurn(state);
  if (turn && !turn.settled) turn.status = 'failed';
}

export type { Turn, TurnStatus, ConversationItem };
export { nextId, __resetIdSeq, createTextBlock } from './messageModel.ts';
