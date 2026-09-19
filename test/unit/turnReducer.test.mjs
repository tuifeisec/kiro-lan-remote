// turnReducer 单测：逐条覆盖开发文档 13.1 节要求的场景。
// reducer 是纯函数，不依赖浏览器 —— 这些断言等价于原 stream.test.mjs 的核心场景。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversationState,
  appendUserText,
  appendAssistantText,
  appendThought,
  addToolCall,
  updateToolCall,
  setToolWaiting,
  finishTurn,
  newTurn,
  settleReplayed,
  addSystem,
  markLocalEcho,
  closeUserBubble,
  applySessionInfo,
  applyTurnCompletion,
  markCancelling,
  stopReasonToFinishReason,
  __resetIdSeq,
} from '../../src/domain/turnReducer.ts';

const user = (text, messageId, replay = false) => ({
  kind: 'user-text',
  text,
  messageId,
  replay,
});
const asst = (text, replay = false, resume = false) => ({ kind: 'assistant-text', text, replay, resume });
const thought = (text, opts = {}) => ({
  kind: 'thought',
  text,
  replay: opts.replay ?? false,
  ...(opts.resume ? { resume: true } : {}),
});
const tool = (toolCallId, opts = {}) => ({
  kind: 'tool-call',
  toolCallId,
  title: opts.title ?? '终端',
  status: opts.status ?? 'in_progress',
  toolKind: opts.toolKind,
  rawInput: opts.rawInput,
  ...(opts.content ? { content: opts.content } : {}),
  replay: opts.replay ?? false,
  ...(opts.resume ? { resume: true } : {}),
});
const toolUpd = (toolCallId, status, opts = {}) => ({
  kind: 'tool-call-update',
  toolCallId,
  status,
  ...(opts.content ? { content: opts.content } : {}),
  replay: false,
  ...(opts.resume ? { resume: true } : {}),
});

function fresh() {
  __resetIdSeq();
  const s = createConversationState();
  s.sessionId = 's1';
  return s;
}
const turns = (s) => s.items.filter((i) => i.type === 'turn');
const procTexts = (t) => t.process.filter((b) => b.type === 'text');
const procTools = (t) => t.process.filter((b) => b.type === 'tool');
const procThoughts = (t) => t.process.filter((b) => b.type === 'thought');
const procKinds = (t) =>
  t.process.map((b) => (b.type === 'tool' ? 'tool:' + b.toolCallId : b.type));

// ---------- 用户消息合并 ----------

test('同 messageId 的多片只开一个回合并累加成完整消息', () => {
  const s = fresh();
  appendUserText(s, user('第一段', 'm1'));
  appendUserText(s, user('第二段', 'm1'));
  appendUserText(s, user('第三段', 'm1'));
  assert.equal(turns(s).length, 1);
  assert.equal(turns(s)[0].userMessage.text, '第一段第二段第三段');
});

test('不同 messageId 开新回合，不错误合并', () => {
  const s = fresh();
  appendUserText(s, user('第一条', 'm1'));
  appendUserText(s, user('另一条', 'm2'));
  assert.equal(turns(s).length, 2);
});

test('回复到达后关闭合并窗口：后续无 messageId 的 user 帧开新回合', () => {
  const s = fresh();
  appendUserText(s, user('问题一', 'm1'));
  appendAssistantText(s, asst('回答'));
  appendUserText(s, user('新问题'));
  assert.equal(turns(s).length, 2, '未被并进上一条');
  assert.equal(turns(s)[1].userMessage.text, '新问题');
});

test('本地回显去重：分片回显按前缀逐段消耗，不新增气泡', () => {
  const s = fresh();
  // 模拟 doSend：先建本地回合并标记待跳过文本
  const t = newTurn(s);
  t.userMessage = { id: 'u1', text: '帮我排查时区间问题' };
  markLocalEcho(s, '帮我排查时区间问题');

  const before = turns(s).length;
  appendUserText(s, user('帮我排查', 'e1'));
  appendUserText(s, user('时区间问题', 'e1'));
  assert.equal(turns(s).length, before, '回显不再新增回合');
  assert.equal(s.localEchoRemainder, null, '剩余串耗尽');
});

test('回显消耗完后，真实的新消息仍正常开新回合', () => {
  const s = fresh();
  const t = newTurn(s);
  t.userMessage = { id: 'u1', text: '原句' };
  markLocalEcho(s, '原句');
  appendUserText(s, user('原句', 'e1'));

  const before = turns(s).length;
  appendUserText(s, user('换个话题'));
  assert.equal(turns(s).length, before + 1);
});

test('前缀不匹配时不吞消息（防误吞保护）', () => {
  const s = fresh();
  newTurn(s);
  markLocalEcho(s, '原句');
  appendUserText(s, user('完全不同的内容'));
  assert.equal(s.localEchoRemainder, '原句', '不消耗');
  assert.equal(turns(s).length, 2, '按新消息渲染');
});

// ---------- 文本归属 ----------

test('纯问答回合：文本直接成为答案，不产生过程面板', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('## 标题'));
  appendAssistantText(s, asst('\n正文'));
  const t = turns(s)[0];
  assert.equal(t.answer.raw, '## 标题\n正文');
  assert.equal(t.process.length, 0);
  assert.equal(t.panelVisible, false, '没有工具调用就没有面板');
  assert.equal(t.workVisible, true, '但分割线存在');
});

test('首次工具调用把前置文本转为过程叙述', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('我先确认容器时区。'));
  addToolCall(s, tool('t1'));
  const t = turns(s)[0];
  assert.equal(t.answer, null, '答案槽位被搬空');
  assert.equal(procTexts(t).length, 1);
  assert.equal(procTexts(t)[0].raw, '我先确认容器时区。');
  assert.equal(t.panelVisible, true);
  assert.equal(t.toolCount, 1);
});

test('工具之后的文本成为过程叙述，与工具行按顺序交错', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  appendAssistantText(s, asst('现在检查配置。'));
  addToolCall(s, tool('t2'));
  const t = turns(s)[0];
  const kinds = t.process.map((b) => (b.type === 'tool' ? 'tool:' + b.toolCallId : 'text'));
  assert.deepEqual(kinds, ['tool:t1', 'text', 'tool:t2']);
});

test('收尾把最后一段过程叙述提升为结论，中间叙述留在折叠区', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('先看看。'));
  addToolCall(s, tool('t1'));
  appendAssistantText(s, asst('中间过程说明。'));
  addToolCall(s, tool('t2'));
  appendAssistantText(s, asst('结论：需要补上 TZ。'));
  finishTurn(s);
  const t = turns(s)[0];
  assert.equal(t.answer.raw, '结论：需要补上 TZ。');
  // 折叠区内留下「动手前说明」与「中间过程说明」两块；结论已被移出。
  const texts = procTexts(t);
  assert.equal(texts.length, 2, '中间叙述留在折叠区内');
  assert.deepEqual(
    texts.map((b) => b.raw),
    ['先看看。', '中间过程说明。']
  );
  assert.equal(procTools(t).length, 2, '工具行留在折叠区内');
  assert.equal(t.expanded, false, '结束后收起');
  assert.equal(t.settled, true);
});

test('回合以工具收尾时，动手前的说明仍被提升为可见结论', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('我先确认容器时区。'));
  addToolCall(s, tool('t1'));
  addToolCall(s, tool('t2'));
  addToolCall(s, tool('t3'));
  finishTurn(s);
  const t = turns(s)[0];
  assert.equal(t.answer.raw, '我先确认容器时区。', '说明已提升到面板外');
  assert.equal(t.toolCount, 3);
});

test('结论之后再出现工具调用，不丢结论', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('结论：需要补上 TZ。'));
  addToolCall(s, tool('t1'));
  addToolCall(s, tool('t2'));
  finishTurn(s);
  assert.equal(turns(s)[0].answer.raw, '结论：需要补上 TZ。');
});

// ---------- 定稿后的迟到事件 ----------

test('定稿后迟到的分片落到面板外且不裂成多块', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('结论前半段。'));
  addToolCall(s, tool('t1'));
  finishTurn(s);

  appendAssistantText(s, asst('结论后半段。'));
  const t = turns(s)[0];
  assert.equal(t.answer.raw, '结论前半段。结论后半段。', '同一块内顺序正确');
  assert.equal(t.panelVisible && t.expanded, false, '面板保持收起');
});

test('定稿后迟到的工具调用不再把后续叙述藏回面板', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('结论在这里。'));
  finishTurn(s);

  addToolCall(s, tool('tLate'));
  appendAssistantText(s, asst('迟到说明。'));

  const t = turns(s)[0];
  assert.equal(t.answer.raw, '结论在这里。迟到说明。', '迟到说明可见');
  assert.equal(t.expanded, false, '面板不重新弹开');
  assert.equal(t.toolCount, 1, '工具行仍记入过程（留痕）');
});

// ---------- finishTurn 幂等 ----------

test('重复 finishTurn 不改变结论区，也不搬空中间叙述', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('先看看。'));
  addToolCall(s, tool('t1'));
  appendAssistantText(s, asst('过程说明。'));
  addToolCall(s, tool('t2'));
  appendAssistantText(s, asst('总结：补 TZ 即可。'));

  finishTurn(s);
  const ans1 = turns(s)[0].answer.raw;
  const procCount1 = procTexts(turns(s)[0]).length;

  finishTurn(s);
  assert.equal(turns(s)[0].answer.raw, ans1, '二次收尾不改变结论区');
  assert.equal(procTexts(turns(s)[0]).length, procCount1, '中间叙述仍在折叠区内');
});

// ---------- 工具行 ----------

test('工具 update 不重复创建行、不重复计数', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  updateToolCall(s, toolUpd('t1', 'completed'));
  updateToolCall(s, toolUpd('t1', 'completed'));
  const t = turns(s)[0];
  assert.equal(procTools(t).length, 1, '只有一行');
  assert.equal(t.toolCount, 1, '计数只算首帧');
  assert.equal(procTools(t)[0].status, 'completed');
});

test('工具 update 找不到首帧时按新工具处理（乱序兼容）', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  updateToolCall(s, toolUpd('tUnknown', 'completed'));
  const t = turns(s)[0];
  assert.equal(procTools(t).length, 1);
  assert.equal(t.toolCount, 1);
});

test('无入参的工具是安静行（不可展开），有入参可展开', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1', { title: '思考', status: 'completed' }));
  addToolCall(s, tool('t2', { rawInput: { command: 'ls -la' } }));
  const t = turns(s)[0];
  assert.equal(procTools(t)[0].expandable, false, '无入参不可展开');
  assert.equal(procTools(t)[1].expandable, true, '有入参可展开');
});

test('空字符串入参也算安静行', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1', { rawInput: '' }));
  assert.equal(procTools(turns(s)[0])[0].expandable, false);
});

test('工具参数可从 toolInputs 缓存补齐（update 帧不带 rawInput）', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1', { rawInput: { path: 'D:/a/b.go' } }));
  addToolCall(s, tool('t2', { rawInput: undefined }));
  // t2 未带入参，expandable 应为 false
  assert.equal(procTools(turns(s)[0])[1].expandable, false);
  assert.equal(s.toolInputs.get('t1').path, 'D:/a/b.go', '缓存留存供权限面板回查');
});

// ---------- 回放 ----------

test('回放首帧清空并进入回放态，实时帧到达后退出', () => {
  const s = fresh();
  // 模拟 store 层：首帧 replay 时清空
  s.replaying = true;
  appendUserText(s, user('历史问题', 'h1', true));
  appendAssistantText(s, asst('历史回答。', true));
  assert.equal(turns(s).length, 1);

  s.replaying = false;
  appendUserText(s, user('实时问题', 'r1', false));
  assert.equal(turns(s).length, 2);
  assert.equal(turns(s)[0].replay, true, '回放回合被标记');
  assert.equal(turns(s)[1].replay, false);
});

test('回放末回合显式收尾：结论可见且面板收起', () => {
  const s = fresh();
  s.replaying = true;
  appendUserText(s, user('历史问题', 'h1', true));
  appendAssistantText(s, asst('中间过程', true));
  addToolCall(s, tool('th1', { replay: true }));
  addToolCall(s, tool('th2', { replay: true }));
  appendAssistantText(s, asst('总结：compose 里补 TZ 即可。', true));

  settleReplayed(s);
  const t = turns(s)[0];
  assert.equal(t.answer.raw, '总结：compose 里补 TZ 即可。', '结论提升为可见正文');
  assert.equal(t.expanded, false, '面板收起');
  assert.equal(t.status, 'completed', '不再显示运行中');
});

test('回放回合不自动展开面板（不播放假实时动画）', () => {
  const s = fresh();
  s.replaying = true;
  appendUserText(s, user('历史问题', 'h1', true));
  addToolCall(s, tool('th1', { replay: true }));
  assert.equal(turns(s)[0].expanded, false, '回放中工具调用不自动展开');
});

test('实时回合的首次工具调用自动展开面板', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  assert.equal(turns(s)[0].expanded, true);
});

// ---------- 结束原因 ----------

test('stopReason 映射：cancelled 识别为取消', () => {
  assert.equal(stopReasonToFinishReason('cancelled'), 'cancelled');
  assert.equal(stopReasonToFinishReason('end_turn'), 'completed');
  assert.equal(stopReasonToFinishReason(null), 'completed');
  assert.equal(stopReasonToFinishReason('failed'), 'failed');
});

test('turnEnd 触发收尾并把状态置为 cancelled', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  applySessionInfo(s, {
    kind: 'session-info',
    replay: false,
    turnEnd: { stopReason: 'cancelled', messageId: 'msg1' },
  });
  const t = turns(s)[0];
  assert.equal(t.status, 'cancelled');
  assert.equal(t.settled, true);
});

test('取消是黏性的：确认取消后 completed 不得改回', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  finishTurn(s, 'cancelled');
  finishTurn(s, 'completed');
  assert.equal(turns(s)[0].status, 'cancelled');
});

test('cancelling 期间迟到分片仍进答案区（未定稿）', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('部分结论。'));
  addToolCall(s, tool('t1'));
  markCancelling(s);
  appendAssistantText(s, asst('取消前最后一段。'));
  const t = turns(s)[0];
  assert.equal(t.status, 'cancelling');
  assert.equal(t.answer, null, '未定稿时不进答案区（此时面板仍开着）');
  assert.equal(procTexts(t).length, 2, '作为过程叙述累积');
});

test('本页发起回合的时长被定格，且不随重复收尾改变', async () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  const t = turns(s)[0];
  t.startedAt = Date.now() - 1234;
  finishTurn(s);
  const frozen = t.frozenMs;
  assert.ok(frozen >= 1234, '定格时长不小于实际间隔');
  finishTurn(s);
  assert.equal(t.frozenMs, frozen, '重复收尾不改定格值');
});

// ---------- 系统提示与投影 ----------

test('系统提示不属于任何回合，且不打断 activeTurn', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addSystem(s, '正在载入…');
  addSystem(s, '载入失败', 'err');
  const t = turns(s)[0];
  assert.equal(turns(s).length, 1);
  assert.equal(s.items.length, 3, '1 回合 + 2 条提示');
  assert.equal(s.items[1].level, 'sys');
  assert.equal(s.items[2].level, 'err');
  assert.equal(appendAndGetActive(s), t.id, 'activeTurn 未被提示改变');
});

function appendAndGetActive(s) {
  // 追加一段助手文本，应落在同一个回合里
  appendAssistantText(s, asst('继续'));
  const t = turns(s).find((x) => !!x.answer);
  return t.id;
}

test('新回合会先收尾上一回合', () => {
  const s = fresh();
  appendUserText(s, user('问题一', 'm1'));
  appendAssistantText(s, asst('结论一'));
  addToolCall(s, tool('t1'));
  newTurn(s);
  const prev = turns(s)[0];
  assert.equal(prev.settled, true, '上一回合已收尾');
  assert.equal(prev.expanded, false);
  assert.equal(prev.answer.raw, '结论一');
});

test('回放态与实时态可通过 replaying 区分', () => {
  const s = fresh();
  s.replaying = false;
  appendUserText(s, user('实时', 'r1'));
  assert.equal(turns(s)[0].replay, false);
});


test('取消命令响应不提前收尾，必须等待权威 turnEnd', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('部分结果。'));
  markCancelling(s);

  finishTurn(s, 'completed');
  const t = turns(s)[0];
  assert.equal(t.status, 'cancelling');
  assert.equal(t.settled, false, '非权威完成响应不能定稿');

  applySessionInfo(s, {
    kind: 'session-info',
    replay: false,
    turnEnd: { stopReason: 'cancelled', messageId: 'msg-cancel' },
  });
  assert.equal(t.status, 'cancelled');
  assert.equal(t.settled, true, 'turnEnd 到达后才定稿');
});

// ---------- 思考块（契约 v2） ----------

test('thought 建面板且把已有 answer 降级', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('动手前的说明。'));
  appendThought(s, thought('让我想想。'));
  const t = turns(s)[0];
  assert.equal(t.answer, null, '答案槽位被搬空');
  assert.equal(t.panelVisible, true, '思考也建面板');
  assert.deepEqual(procKinds(t), ['text', 'thought'], '降级文本与思考块按序排列');
  assert.equal(procTexts(t)[0].raw, '动手前的说明。');
  assert.equal(procThoughts(t)[0].raw, '让我想想。');
  assert.equal(t.thoughtCount, 1);
});

test('thought 与工具/过程文本按到达顺序交错', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendThought(s, thought('先查一下。'));
  addToolCall(s, tool('t1'));
  appendThought(s, thought('结果符合预期。'));
  appendAssistantText(s, asst('中间说明。'));
  addToolCall(s, tool('t2'));
  appendThought(s, thought('收尾思考。'));
  const t = turns(s)[0];
  assert.deepEqual(procKinds(t), ['thought', 'tool:t1', 'thought', 'text', 'tool:t2', 'thought']);
  assert.equal(t.thoughtCount, 3);
  assert.equal(t.toolCount, 2);
});

test('连续思考分片流式续写同一块：raw 拼接、thoughtCount===1', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendThought(s, thought('思考'));
  appendThought(s, thought('分片'));
  const t = turns(s)[0];
  assert.equal(procThoughts(t).length, 1, '连续分片同块续写不裂块');
  assert.equal(procThoughts(t)[0].raw, '思考分片');
  assert.equal(t.thoughtCount, 1, '只在新建块时计数');
  assert.equal(procThoughts(t)[0].closed, false, '打开中的块可继续写');
  assert.equal(t.expanded, true, 'live 思考分片让面板自动展开（与工具同规则）');
});

test('thought 永不提升为答案：纯思考回合收尾后 answer 为 null', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendThought(s, thought('思考一。'));
  appendThought(s, thought('思考二。'));
  finishTurn(s);
  const t = turns(s)[0];
  assert.equal(t.answer, null, '思考块留在过程区，answer 保持 null');
  assert.deepEqual(procKinds(t), ['thought'], '连续分片合并为一块');
  assert.equal(procThoughts(t)[0].closed, true, '收尾封口思考块');
  assert.equal(procThoughts(t)[0].frozenMs != null, true, '收尾定格思考耗时');
  assert.equal(t.settled, true);
});

test('「thought→文本」无工具回合收尾后末段文本成为答案', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendThought(s, thought('思考过程。'));
  // 思考已建面板 → 后续文本按过程叙述走；收尾时末段叙述提升为答案
  appendAssistantText(s, asst('最终结论。'));
  finishTurn(s);
  const t = turns(s)[0];
  assert.equal(t.answer.raw, '最终结论。', '末段文本提升为答案');
  assert.deepEqual(procKinds(t), ['thought'], '思考块留在折叠区');
  assert.equal(procThoughts(t)[0].closed, true, '收尾封口思考块');
});

test('turnEnd 封口思考块并定格 frozenMs', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendThought(s, thought('实时思考。'));
  const tb = procThoughts(turns(s)[0])[0];
  assert.equal(tb.startedAt != null, true, '实时帧记录计时起点');
  applySessionInfo(s, {
    kind: 'session-info',
    replay: false,
    turnEnd: { stopReason: 'end_turn', messageId: 'm1' },
  });
  assert.equal(tb.closed, true, 'turnEnd 封口思考块');
  assert.equal(tb.frozenMs != null, true, 'turnEnd 定格思考耗时');
  assert.equal(s.openThoughtBlockId, null, '写入槽位清空');
});

test('回放思考分片流式续写，不记计时且 replay 标记为 true', () => {
  const s = fresh();
  s.replaying = true;
  appendThought(s, thought('历史思考。', { replay: true }));
  appendThought(s, thought('历史续写。', { replay: true }));
  const tb = procThoughts(turns(s)[0])[0];
  assert.equal(tb.replay, true);
  assert.equal(tb.startedAt, null, '回放帧不记计时');
  assert.equal(tb.raw, '历史思考。历史续写。', '回放分片同样续写');
  assert.equal(turns(s)[0].thoughtCount, 1, '回放分片合并计数');
});

test('resume 思考帧：无打开思考块时新建 replay 块、不记计时', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendThought(s, thought('实时思考。'));
  addToolCall(s, tool('t1')); // 工具调用封口当前思考块
  appendThought(s, thought('补发思考。', { resume: true }));
  const t = turns(s)[0];
  assert.equal(procThoughts(t).length, 2, '被打断后 resume 帧另起新段');
  const tb2 = procThoughts(t)[1];
  assert.equal(tb2.replay, true, 'resume 帧新建块等同回放块');
  assert.equal(tb2.startedAt, null, 'resume 帧不记计时');
  assert.equal(s.replaying, false, 'resume 帧不进入回放态');
  assert.equal(t.thoughtCount, 2);
});

// ---------- 工具计时 / 输出 / 等待标记（契约 v2） ----------

test('工具首帧记录 startedAt，回放帧为 null', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  assert.equal(procTools(turns(s)[0])[0].startedAt != null, true, '实时首帧记录起点');

  const s2 = fresh();
  s2.replaying = true;
  appendUserText(s2, user('历史问题', 'h1', true));
  addToolCall(s2, tool('th1', { replay: true }));
  assert.equal(procTools(turns(s2)[0])[0].startedAt, null, '回放帧无计时');
});

test('resume 首帧不记 startedAt（等同回放块）', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1', { resume: true }));
  const b = procTools(turns(s)[0])[0];
  assert.equal(b.replay, true);
  assert.equal(b.startedAt, null);
  assert.equal(s.replaying, false, 'resume 帧不置回放态（由事件路由层保证）');
});

test('update 到 completed/failed 记 finishedMs，重复 update 不覆盖', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  const b = procTools(turns(s)[0])[0];
  updateToolCall(s, toolUpd('t1', 'completed'));
  const frozen = b.finishedMs;
  assert.equal(frozen != null, true, 'completed 定格耗时');
  assert.ok(frozen >= 0);
  updateToolCall(s, toolUpd('t1', 'completed'));
  assert.equal(b.finishedMs, frozen, '重复 update 不覆盖');
  assert.equal(b.status, 'completed');
});

test('resume 的 update 不记 finishedMs', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  const b = procTools(turns(s)[0])[0];
  updateToolCall(s, toolUpd('t1', 'completed', { resume: true }));
  assert.equal(b.finishedMs, null, '补发帧不产耗时');
  assert.equal(b.status, 'completed', '状态照常更新');
});

test('content 覆盖 output；无 content 的 update 保留', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1', { content: [{ type: 'terminal', text: 'ls' }] }));
  const b = procTools(turns(s)[0])[0];
  assert.equal(b.output.length, 1);
  assert.equal(b.output[0].text, 'ls');

  updateToolCall(s, toolUpd('t1', 'in_progress', {
    content: [
      { type: 'terminal', text: 'ls -la' },
      { type: 'text', text: '总计 4' },
    ],
  }));
  assert.equal(b.output.length, 2, 'update 的非空 content 覆盖');
  assert.equal(b.output[0].text, 'ls -la');

  updateToolCall(s, toolUpd('t1', 'completed'));
  assert.equal(b.output.length, 2, '缺省 content 保留既有输出');
});

test('setToolWaiting 定位当前回合的工具行；找不到静默返回', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  addToolCall(s, tool('t1'));
  const b = procTools(turns(s)[0])[0];

  setToolWaiting(s, 't1', true);
  assert.equal(b.waiting, true);
  setToolWaiting(s, 't1', false);
  assert.equal(b.waiting, false);

  assert.doesNotThrow(() => setToolWaiting(s, '不存在的行', true), '找不到时不抛错');
  assert.doesNotThrow(() => setToolWaiting(fresh(), 't1', true), '无活动回合时不抛错');
});

test('乱序 update 兜底建行并同步状态/输出/耗时字段', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  updateToolCall(s, toolUpd('tUnknown', 'completed', {
    content: [{ type: 'text', text: '兜底输出' }],
  }));
  const t = turns(s)[0];
  assert.equal(procTools(t).length, 1);
  assert.equal(t.toolCount, 1);
  const b = procTools(t)[0];
  assert.equal(b.status, 'completed');
  assert.deepEqual(b.output.map((c) => c.text), ['兜底输出'], '兜底行同步 content');
  assert.equal(b.startedAt != null, true, '兜底建行也是实时首帧');
  assert.equal(b.finishedMs != null, true, '兜底行按同一规则定格耗时');
});

// ---------- resume 帧（契约 v2） ----------

test('resume 文本帧：不进入 replaying、不清空已有内容、新块 replay=true', () => {
  const s = fresh();
  appendUserText(s, user('问题', 'm1'));
  appendAssistantText(s, asst('已有内容。'));
  addToolCall(s, tool('t1'));

  const turnCountBefore = turns(s).length;
  const procCountBefore = turns(s)[0].process.length;

  appendAssistantText(s, asst('补发内容。', false, true));
  const t = turns(s)[0];
  assert.equal(s.replaying, false, '不进入回放态');
  assert.equal(turns(s).length, turnCountBefore, '不清空已有内容（无新回合）');
  assert.equal(t.process.length, procCountBefore + 1, '补发内容另开新块');
  const freshBlock = t.process[t.process.length - 1];
  assert.equal(freshBlock.replay, true, '新块等同回放块');
  assert.equal(freshBlock.raw, '补发内容。');
});

// ---------- v1.2 增补：重放历史的真实计时（Kiro 帧级 timestamp / turn_completion.elapsedTime） ----------

test('重放工具耗时：update 帧 timestamp − 首帧 timestamp', () => {
  __resetIdSeq();
  const state = createConversationState();
  state.replaying = true;
  addToolCall(state, {
    kind: 'tool-call', toolCallId: 't1', title: 'Read File', toolKind: 'read',
    status: 'in_progress', replay: true, timestamp: '2026-09-11T11:52:14.914Z',
  });
  updateToolCall(state, {
    kind: 'tool-call-update', toolCallId: 't1', status: 'completed',
    replay: true, timestamp: '2026-09-11T11:52:17.914Z',
  });
  const turn = state.items.find(i => i.type === 'turn');
  const blk = turn.process.find(b => b.type === 'tool');
  assert.equal(blk.finishedMs, 3000);
});

test('重放回合耗时：turn-completion 的 elapsedTime 写入 frozenMs（含 turnEnd 已收尾后到达）', () => {
  __resetIdSeq();
  const state = createConversationState();
  state.replaying = true;
  appendUserText(state, user('问题', 'm1', true));
  appendAssistantText(state, asst('结论', true));
  // 帧序：turn_completion 先于 turn_end
  applyTurnCompletion(state, { kind: 'turn-completion', elapsedTimeMs: 7799, status: 'failed', replay: true });
  applySessionInfo(state, {
    kind: 'session-info', replay: true,
    turnEnd: { stopReason: 'error', messageId: 'm1' },
  });
  const turn = state.items.find(i => i.type === 'turn');
  assert.equal(turn.frozenMs, 7799);
  assert.equal(turn.settled, true);
  assert.equal(turn.status, 'failed');
});

test('实时回合已定格的时长不被 turn-completion 覆盖', () => {
  __resetIdSeq();
  const state = createConversationState();
  appendUserText(state, user('问题', 'm1'));
  const turn = state.items.find(i => i.type === 'turn');
  turn.startedAt = Date.now() - 5000;
  finishTurn(state, 'completed');
  const liveFrozen = turn.frozenMs;
  applyTurnCompletion(state, { kind: 'turn-completion', elapsedTimeMs: 999999, status: 'completed', replay: false });
  assert.equal(turn.frozenMs, liveFrozen);
});
