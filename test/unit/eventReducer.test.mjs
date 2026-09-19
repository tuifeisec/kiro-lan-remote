// eventReducer 单测：路由顺序契约（mux-closed/governance 前置 → 会话过滤 →
// 回放判定 → 分派）与契约 v2 的 resume 绕过、thought/unknown/mode/commands 分派。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../../src/domain/eventReducer.ts';
import { createConversationState, __resetIdSeq } from '../../src/domain/turnReducer.ts';

function fresh() {
  __resetIdSeq();
  const s = createConversationState();
  s.sessionId = 's1';
  return s;
}

/** 记录调用轨迹的 deps 工厂。 */
function makeDeps(over = {}) {
  const calls = { onMuxClosed: [], onTitle: [], onMode: [], onCommands: [], absorb: [] };
  const deps = {
    isChatView: () => true,
    isActiveSession: (sid) => sid === 's1',
    onMuxClosed: () => calls.onMuxClosed.push(1),
    onTitle: (t) => calls.onTitle.push(t),
    onMode: (m) => calls.onMode.push(m),
    onCommands: (c) => calls.onCommands.push(c),
    absorbConfigOptions: (o) => calls.absorb.push(o),
    ...over,
  };
  return { deps, calls };
}

// ---------- 既有前置行为回归 ----------

test('mux-closed 在会话过滤之前处理：非会话页也触发 onMuxClosed', () => {
  const s = fresh();
  const { deps, calls } = makeDeps({ isChatView: () => false });
  const r = applyEvent(s, null, { kind: 'mux-closed', code: 1006 }, deps);
  assert.equal(r.handled, true);
  assert.equal(calls.onMuxClosed.length, 1);
});

test('governance 前置于会话过滤且不渲染', () => {
  const s = fresh();
  const { deps } = makeDeps({ isChatView: () => false, isActiveSession: () => false });
  const r = applyEvent(s, undefined, { kind: 'governance', state: 'x' }, deps);
  assert.deepEqual(r, { handled: false, contentChanged: false });
  assert.equal(s.items.length, 0);
});

test('会话过滤：非当前会话的事件不消费', () => {
  const s = fresh();
  const { deps } = makeDeps();
  const r = applyEvent(
    s,
    'other-session',
    { kind: 'assistant-text', text: '别会话', replay: false },
    deps
  );
  assert.equal(r.handled, false);
  assert.equal(s.items.length, 0);
});

test('会话过滤：列表页不消费会话事件', () => {
  const s = fresh();
  const { deps } = makeDeps({ isChatView: () => false });
  const r = applyEvent(s, 's1', { kind: 'assistant-text', text: 'x', replay: false }, deps);
  assert.equal(r.handled, false);
});

// ---------- 回放判定 ----------

test('回放首帧进入 replaying 并清空，live 帧退出', () => {
  const s = fresh();
  const { deps } = makeDeps();
  applyEvent(s, 's1', { kind: 'assistant-text', text: '实时。', replay: false }, deps);
  assert.equal(s.items.length, 1);

  applyEvent(s, 's1', { kind: 'user-text', text: '历史。', messageId: 'h1', replay: true }, deps);
  assert.equal(s.replaying, true);
  assert.equal(s.items.length, 1, '清空后只剩回放回合');

  applyEvent(s, 's1', { kind: 'assistant-text', text: '实时恢复。', replay: false }, deps);
  assert.equal(s.replaying, false);
});

test('thought 是 REPLAYABLE：replay thought 触发回放判定', () => {
  const s = fresh();
  const { deps } = makeDeps();
  const r = applyEvent(s, 's1', { kind: 'thought', text: '历史思考。', replay: true }, deps);
  assert.equal(r.contentChanged, true);
  assert.equal(s.replaying, true, 'thought 帧可进入回放态');
  const turn = s.items[0];
  assert.equal(turn.process[0].type, 'thought');
  assert.equal(turn.process[0].replay, true);
});

// ---------- resume 绕过（契约 v2） ----------

test('resume 帧不把 replaying 置位，也不清空已有内容', () => {
  const s = fresh();
  const { deps } = makeDeps();
  applyEvent(s, 's1', { kind: 'assistant-text', text: '已有。', replay: false }, deps);
  const before = s.items.length;

  // 即使恶意携带 replay:true，resume 语义优先：不进入回放、不清空
  const r = applyEvent(
    s,
    's1',
    { kind: 'user-text', text: '补发。', replay: true, resume: true },
    deps
  );
  assert.equal(r.contentChanged, true);
  assert.equal(s.replaying, false, 'resume 帧不置 replaying');
  assert.equal(s.items.length, before + 1, '已有内容保留，补发另开回合');
});

test('replaying 期间 resume 帧不退出回放态，仍按无动画创建', () => {
  const s = fresh();
  const { deps } = makeDeps();
  applyEvent(s, 's1', { kind: 'user-text', text: '历史。', replay: true }, deps);
  assert.equal(s.replaying, true);

  const r = applyEvent(
    s,
    's1',
    { kind: 'tool-call-update', toolCallId: 't1', status: 'completed', replay: false, resume: true },
    deps
  );
  assert.equal(r.contentChanged, true);
  assert.equal(s.replaying, true, 'resume 帧不退出回放态');
});

// ---------- 分派 ----------

test('thought 路由到 appendThought 并返回 CHANGED', () => {
  const s = fresh();
  const { deps } = makeDeps();
  const r = applyEvent(s, 's1', { kind: 'thought', text: '想。', replay: false }, deps);
  assert.deepEqual(r, { handled: true, contentChanged: true });
  const turn = s.items[0];
  assert.equal(turn.process[0].type, 'thought');
  assert.equal(turn.thoughtCount, 1);
});

test('mode 调用 deps.onMode 并返回 HANDLED', () => {
  const s = fresh();
  const { deps, calls } = makeDeps();
  const r = applyEvent(s, 's1', { kind: 'mode', modeId: 'autopilot', replay: false }, deps);
  assert.deepEqual(r, { handled: true, contentChanged: false });
  assert.deepEqual(calls.onMode, ['autopilot']);
});

test('commands 调用 deps.onCommands 并返回 HANDLED', () => {
  const s = fresh();
  const { deps, calls } = makeDeps();
  const cmds = [{ name: '/fix' }];
  const r = applyEvent(s, 's1', { kind: 'commands', commands: cmds, replay: false }, deps);
  assert.deepEqual(r, { handled: true, contentChanged: false });
  assert.equal(calls.onCommands.length, 1);
  assert.equal(calls.onCommands[0], cmds);
});

test('unknown 返回 HANDLED 且不产生内容', () => {
  const s = fresh();
  const { deps } = makeDeps();
  const r = applyEvent(
    s,
    's1',
    { kind: 'unknown', updateType: 'mystery_update', replay: false },
    deps
  );
  assert.deepEqual(r, { handled: true, contentChanged: false });
  assert.equal(s.items.length, 0, 'unknown 不进 UI');
});

test('kind:null（前端不认识的 sessionUpdate）仍不消费', () => {
  const s = fresh();
  const { deps } = makeDeps();
  const r = applyEvent(s, 's1', { kind: null }, deps);
  assert.equal(r.handled, false);
});

test('session-info 标题回调 onTitle；turnEnd 返回 CHANGED', () => {
  const s = fresh();
  const { deps, calls } = makeDeps();
  applyEvent(s, 's1', { kind: 'assistant-text', text: '答。', replay: false }, deps);
  const r = applyEvent(
    s,
    's1',
    {
      kind: 'session-info',
      title: '新标题',
      replay: false,
      turnEnd: { stopReason: 'end_turn', messageId: null },
    },
    deps
  );
  assert.equal(r.contentChanged, true);
  assert.deepEqual(calls.onTitle, ['新标题']);
  assert.equal(s.items[0].settled, true);
});
