// 投影链路集成测试：脚本化事件流按 bootstrap 同等链路灌入真实 Pinia stores
// （parseServerMessage 归一化 → 会话元数据旁路 → conversation.applyServerMessage，
//   status 走 absorbFor + setModel，与 bindStatusToUi 一致），
// 断言回合结构、工具状态、waiting 流程、会话投影与多会话配置隔离。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setActivePinia, createPinia } from 'pinia';
import { parseServerMessage } from '../../src/protocol/guards.ts';
import { useSessionStore } from '../../src/stores/session.ts';
import { useConversationStore } from '../../src/stores/conversation.ts';
import { useConfigStore } from '../../src/stores/config.ts';
import { useUiStore } from '../../src/stores/ui.ts';

const A = 'sessA';
const B = 'sessB';

function setup() {
  setActivePinia(createPinia());
  const sessions = useSessionStore();
  const conversation = useConversationStore();
  const config = useConfigStore();
  const ui = useUiStore();

  sessions.setSessions([
    { sessionId: A, cwd: 'd:/proj', title: 'A 旧标题', updatedAt: '2026-09-18T10:00:00Z' },
    { sessionId: B, cwd: 'd:/proj', title: 'B 会话', updatedAt: '2026-09-18T09:00:00Z' },
  ]);
  ui.setView('chat');
  conversation.openSession(A);
  config.setViewed(A);

  // —— bootstrap 同等链路 ——
  const isChatView = () => ui.view === 'chat';

  // handleEventBypass 同款：会话过滤之前的全会话元数据旁路
  function bypass(msg) {
    if (!msg.sessionId) return;
    const sid = msg.sessionId;
    const kind = msg.event.kind;
    if (kind === 'session-info') {
      sessions.applyLiveMeta(sid, { title: msg.event.title, updatedAt: msg.event.updatedAt });
      if (msg.event.turnEnd) sessions.markLive(sid, 'ended');
      return;
    }
    if (
      ['assistant-text', 'user-text', 'tool-call', 'tool-call-update', 'thought'].includes(kind) &&
      msg.event.replay !== true
    ) {
      sessions.markLive(sid, 'running');
    }
  }

  /** 灌入一条原始帧；返回 applyServerMessage 的可见变化结果（非事件帧返回 true）。 */
  function feed(raw) {
    const msg = parseServerMessage(raw);
    if (!msg) return false;
    if (msg.type === 'status') {
      // bindStatusToUi 同款
      config.absorbFor(msg.status.configSessionId, msg.status.configOptions);
      config.setModel(msg.status.modelId, msg.status.modelName);
      return true;
    }
    if (msg.type !== 'event') return false;
    bypass(msg);
    return conversation.applyServerMessage(msg, {
      isChatView,
      onTitle: (title) => sessions.renameSession(conversation.state.sessionId ?? '', title),
      onMode: (modeId) => {
        if (modeId) config.setModeValue(modeId);
      },
      onCommands: (commands) => config.setCommands(conversation.state.sessionId ?? '', commands),
    });
  }

  const ev = (seq, sessionId, event) => feed({ type: 'event', seq, sessionId, event });

  return { sessions, conversation, config, ui, feed, ev };
}

const optsFor = (modelValue, modeValue) => [
  { id: 'model', currentValue: modelValue, options: [{ value: modelValue, name: '模型 ' + modelValue }] },
  { id: 'mode', currentValue: modeValue, options: [{ value: modeValue, name: '模式 ' + modeValue }] },
  { id: 'effortLevel', currentValue: 'high' },
];

test('脚本化事件流投影：回合结构 / 工具字段 / waiting / 收尾 / 会话与配置投影', () => {
  const { sessions, conversation, config, ev, feed } = setup();

  // status 推送会话 A 的配置（bindStatusToUi 同款链路）
  assert.equal(
    feed({
      type: 'status',
      status: {
        connected: true, endpoint: null, permissionPolicy: null, lastError: null,
        agentInfo: null, browsers: 1,
        modelId: 'm1', modelName: '模型一',
        configOptions: optsFor('m1', 'auto'),
        configSessionId: A,
      },
    }),
    true
  );
  assert.equal(config.cfg('model').currentValue, 'm1', '查看 A 显示 A 的条目');

  // —— 会话 A 的一个回合 ——
  assert.equal(ev(1, A, { kind: 'user-text', text: '帮我检查', messageId: 'm1', replay: false }), true);
  assert.equal(ev(2, A, { kind: 'thought', text: '思考一。', replay: false }), true);
  assert.equal(ev(3, A, { kind: 'thought', text: '思考二。', replay: false }), true);
  assert.equal(
    ev(4, A, {
      kind: 'tool-call', toolCallId: 't1', title: '终端', status: 'in_progress',
      content: [{ type: 'terminal', text: 'ls' }], replay: false,
    }),
    true
  );

  // 权限等待流程（bootstrap 在 permission-request/resolve 时调用）
  conversation.markToolWaiting('t1', true);
  assert.equal(turnOf(conversation).process[1].waiting, true, '工具行进入等待标记');

  assert.equal(
    ev(5, A, {
      kind: 'tool-call-update', toolCallId: 't1', status: 'completed',
      content: [{ type: 'terminal', text: 'ls -la' }], replay: false,
    }),
    true
  );
  conversation.markToolWaiting('t1', false);

  assert.equal(ev(6, A, { kind: 'assistant-text', text: '结论：没有问题。', replay: false }), true);

  // —— 会话 B 的事件串台：当前会话过滤生效 ——
  assert.equal(ev(7, B, { kind: 'user-text', text: 'B 的消息', replay: false }), false, '串台帧不消费');
  assert.equal(ev(8, B, { kind: 'assistant-text', text: 'B 的回答', replay: false }), false);
  assert.equal(turnsOf(conversation).length, 1, '串台不产生内容');

  // —— 回合收尾 ——
  assert.equal(
    ev(9, A, {
      kind: 'session-info', title: 'A 新标题', updatedAt: '2026-09-19T10:00:00Z',
      replay: false, turnEnd: { stopReason: 'end_turn', messageId: 'm1' },
    }),
    true
  );
  assert.equal(sessions.liveStatusOf(A), 'ended', 'turnEnd → ended');

  // —— resume 防重复：旧 seq 的补发帧被跳过 ——
  assert.equal(
    ev(3, A, { kind: 'thought', text: '重复思考。', replay: false, resume: true }),
    false,
    'seq <= lastSeq 的 resume 帧直接跳过'
  );
  assert.equal(turnOf(conversation).thoughtCount, 1, '重复帧不产生新思考块');

  // —— resume 补发：新 seq 的帧正常落地（等同回放块） ——
  assert.equal(
    ev(10, A, { kind: 'thought', text: '补发思考。', replay: false, resume: true }),
    true
  );

  // ---------- 断言：回合结构 ----------
  const turn = turnOf(conversation);
  assert.equal(turn.settled, true, 'turnEnd 定稿');
  assert.equal(turn.status, 'completed');
  const kinds = turn.process.map((b) => (b.type === 'tool' ? 'tool:' + b.toolCallId : b.type));
  assert.deepEqual(
    kinds,
    ['thought', 'tool:t1', 'thought'],
    '思考分片合并为一块；气泡/思考/工具按到达顺序交错；末段文本已提升为答案'
  );
  assert.equal(turn.answer && turn.answer.raw, '结论：没有问题。', '末段文本提升为答案');
  assert.equal(turn.thoughtCount, 2, '实时分片合并为一块 + 一个 resume 思考块');
  assert.equal(turn.toolCount, 1);
  assert.equal(turn.userMessage.text, '帮我检查');

  const thoughts = turn.process.filter((b) => b.type === 'thought');
  assert.equal(thoughts[0].raw, '思考一。思考二。', '连续实时分片流式拼接');
  assert.equal(thoughts[1].replay, true, 'resume 思考块等同回放块');

  // ---------- 断言：工具状态与耗时字段 ----------
  const tool = turn.process.find((b) => b.type === 'tool');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.startedAt != null, true, '实时首帧有计时起点');
  assert.equal(tool.finishedMs != null, true, 'completed 定格耗时');
  assert.deepEqual(
    tool.output.map((c) => ({ type: c.type, text: c.text })),
    [{ type: 'terminal', text: 'ls -la' }],
    'update 的非空 content 覆盖输出'
  );
  assert.equal(tool.waiting, false, '应答后等待标记清除');

  // ---------- 断言：session store 投影 ----------
  const a = sessions.sessions.find((s) => s.sessionId === A);
  const b = sessions.sessions.find((s) => s.sessionId === B);
  assert.equal(a.title, 'A 新标题', 'session-info 标题实时投影');
  assert.equal(a.updatedAt, '2026-09-19T10:00:00Z', 'updatedAt 实时投影');
  // resume 补发帧代表被错过的实时活动：旁路在 turnEnd 之后收到 seq 10 的思考帧，
  // 把 A 重新标记为 running（旁路先于 resume 去重执行，与 bootstrap 顺序一致）
  assert.equal(sessions.liveStatusOf(A), 'running', 'resume 补发活动覆盖 ended');
  assert.equal(sessions.liveStatusOf(B), 'running', '会话 B 的事件经旁路标记 running（不受会话过滤影响）');

  // updatedAt 变化自然影响排序（A 更新时间更近，应排在其分组首位）
  const group = sessions.groupedSessions[0];
  assert.equal(group.items[0].sessionId, A, '实时 updatedAt 驱动组内排序');

  // ---------- 断言：config 按会话隔离 ----------
  // status 推送会话 B 的配置：不得覆盖当前查看会话 A 的显示
  feed({
    type: 'status',
    status: {
      connected: true, endpoint: null, permissionPolicy: null, lastError: null,
      agentInfo: null, browsers: 1,
      modelId: 'm2', modelName: '模型二',
      configOptions: optsFor('m2', 'spec'),
      configSessionId: B,
    },
  });
  assert.equal(config.cfg('model').currentValue, 'm1', 'B 的推送不覆盖 A 的显示');
  assert.equal(config.cfg('mode').currentValue, 'auto');

  // 切到会话 B：显示 B 自己的条目
  config.setViewed(B);
  assert.equal(config.cfg('model').currentValue, 'm2', '切到 B 显示 B 的条目');
  assert.equal(config.cfg('mode').currentValue, 'spec');

  // 切回 A：仍是 A 的条目
  config.setViewed(A);
  assert.equal(config.cfg('model').currentValue, 'm1');

  // mode 事件 → 本地权威回写（作用于 A 的条目）；HANDLED 无可见内容变化
  assert.equal(ev(11, A, { kind: 'mode', modeId: 'spec', replay: false }), false);
  assert.equal(config.cfg('mode').currentValue, 'spec', 'mode 事件回写当前查看会话的档位');

  // commands 事件按会话归档（HANDLED 无可见内容变化）
  assert.equal(ev(12, A, { kind: 'commands', commands: [{ name: '/fix' }], replay: false }), false);
  assert.equal(config.commands.length, 1, '查看 A 时显示 A 的命令列表');
  config.setViewed(B);
  assert.equal(config.commands.length, 0, 'B 无命令列表时为空数组');
});

function turnsOf(conversation) {
  return conversation.state.items.filter((i) => i.type === 'turn');
}
function turnOf(conversation) {
  return turnsOf(conversation)[0];
}
