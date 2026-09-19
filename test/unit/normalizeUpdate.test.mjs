// normalizeUpdate 单元测试：协议契约 v2 的归一化行为
//
// 覆盖：
//   - 新增 agent_thought_message_chunk → thought
//   - tool_call / tool_call_update 的 content（三种 ToolContent 变体）与 rawOutput
//   - 未识别种类 → unknown（updateType 正确、不携带原始 raw 大对象）
//   - 既有 8 类映射回归（行为保持不变）
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUpdate } from '../../lib/muxClient.mjs';

/** 构造 Kiro 实测的 session/update 通知 params 形态 */
function frame(update, sessionId = 's1') {
  return { sessionId, update };
}

test('agent_thought_message_chunk → thought（含 messageId/replay）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'agent_thought_message_chunk',
    content: { type: 'text', text: '先看看目录结构…' },
    _meta: { kiro: { messageId: 'msg-9', replay: true } },
  }));
  assert.deepEqual(ev, {
    kind: 'thought',
    text: '先看看目录结构…',
    messageId: 'msg-9',
    replay: true,
  });
});

test('agent_thought_message_chunk 空文本 → kind:null（不产生事件）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'agent_thought_message_chunk',
    content: { type: 'text', text: '' },
  }));
  assert.equal(ev.kind, null);
});

test('tool_call 带 content 三种变体与 rawOutput', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: '终端',
    status: 'completed',
    kind: 'execute',
    rawInput: { command: 'node -v' },
    content: [
      { type: 'content', content: { type: 'text', text: 'v24.16.0' } },
      { type: 'diff', path: 'a/b.txt', oldText: '旧', newText: '新' },
      { type: 'terminal', terminalSessionId: 'term-7' },
    ],
    rawOutput: { exitCode: 0, stdout: 'v24.16.0' },
  }));
  assert.equal(ev.kind, 'tool-call');
  assert.equal(ev.toolCallId, 'tc-1');
  assert.deepEqual(ev.content, [
    { type: 'text', text: 'v24.16.0' },
    { type: 'diff', path: 'a/b.txt', oldText: '旧', newText: '新' },
    { type: 'terminal' },
  ]);
  assert.deepEqual(ev.rawOutput, { exitCode: 0, stdout: 'v24.16.0' });
});

test('tool_call 无 content/rawOutput 时事件不带这两个字段', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-2',
    title: '读文件',
    status: 'pending',
  }));
  assert.equal(ev.kind, 'tool-call');
  assert.equal('content' in ev, false);
  assert.equal('rawOutput' in ev, false);
});

test('tool_call content 里未支持的类型被跳过；全部不可归一化时不带 content', () => {
  const skipped = normalizeUpdate(frame({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-3',
    content: [{ type: 'content', content: { type: 'image', data: 'xxx' } }, { type: 'diff', path: 'p', newText: 'n' }],
  }));
  assert.deepEqual(skipped.content, [{ type: 'diff', path: 'p', oldText: null, newText: 'n' }]);

  const allSkipped = normalizeUpdate(frame({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-4',
    content: [{ type: 'content', content: { type: 'image', data: 'xxx' } }],
  }));
  assert.equal('content' in allSkipped, false);
});

test('tool_call_update 带 content 与 rawOutput', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '输出内容' } }],
    rawOutput: '原始字符串输出',
  }));
  assert.equal(ev.kind, 'tool-call-update');
  assert.deepEqual(ev.content, [{ type: 'text', text: '输出内容' }]);
  assert.equal(ev.rawOutput, '原始字符串输出');
});

test('未知种类 → unknown（updateType 正确、无 raw 字段）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'some_future_kind',
    bigPayload: { data: 'x'.repeat(5000) },
  }));
  assert.deepEqual(ev, { kind: 'unknown', updateType: 'some_future_kind', replay: false });
  assert.equal('raw' in ev, false);
});

test('sessionUpdate 缺失 → unknown 且 updateType 为空串', () => {
  const ev = normalizeUpdate(frame({ foo: 1 }));
  assert.deepEqual(ev, { kind: 'unknown', updateType: '', replay: false });
});

test('params 为空 → kind:null（保持既有行为）', () => {
  assert.deepEqual(normalizeUpdate(null), { kind: null });
});

// ---------- 既有 8 类回归 ----------

test('回归：agent_message_chunk → assistant-text', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '你好' },
    _meta: { kiro: { messageId: 'm1' } },
  }));
  assert.deepEqual(ev, { kind: 'assistant-text', text: '你好', messageId: 'm1', replay: false });
});

test('回归：user_message_chunk → user-text', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: '帮我看下' },
  }));
  assert.deepEqual(ev, { kind: 'user-text', text: '帮我看下', messageId: undefined, replay: false });
});

test('回归：tool_call 基础（无 content）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-b',
    title: '读文件',
    status: 'in_progress',
    kind: 'read',
    rawInput: { path: 'x' },
  }));
  assert.deepEqual(ev, {
    kind: 'tool-call',
    toolCallId: 'tc-b',
    title: '读文件',
    status: 'in_progress',
    toolKind: 'read',
    rawInput: { path: 'x' },
    replay: false,
  });
});

test('回归：tool_call_update 基础（无 content）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-b',
    status: 'completed',
  }));
  assert.deepEqual(ev, {
    kind: 'tool-call-update',
    toolCallId: 'tc-b',
    title: undefined,
    status: 'completed',
    replay: false,
  });
});

test('回归：session_info_update 含 _meta.kiro turn_end', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'session_info_update',
    title: '我的会话',
    updatedAt: '2026-09-19T00:00:00Z',
    _meta: { kiro: { kind: 'turn_end', turnEnd: { stopReason: 'end_turn' }, messageId: 'm2' } },
  }));
  assert.deepEqual(ev, {
    kind: 'session-info',
    title: '我的会话',
    updatedAt: '2026-09-19T00:00:00Z',
    replay: false,
    turnEnd: { stopReason: 'end_turn', messageId: 'm2' },
  });
});

test('回归：available_commands_update → commands', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'init', description: 'd' }],
  }));
  assert.deepEqual(ev, { kind: 'commands', commands: [{ name: 'init', description: 'd' }], replay: false });
});

test('回归：config_option_update → config-options', () => {
  const options = [{ id: 'model', currentValue: 'm', options: [] }];
  const ev = normalizeUpdate(frame({ sessionUpdate: 'config_option_update', configOptions: options }));
  assert.deepEqual(ev, { kind: 'config-options', options, replay: false });
});

test('回归：current_mode_update → mode', () => {
  const ev = normalizeUpdate(frame({ sessionUpdate: 'current_mode_update', currentModeId: 'spec' }));
  assert.deepEqual(ev, { kind: 'mode', modeId: 'spec', replay: false });
});

// ---------- v1.2 增补：session_info_update 的 _meta.kiro.kind 细分与帧级时间戳 ----------

test('session_info_update + _meta.kiro.kind=turn_completion → turn-completion（真实耗时）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'session_info_update',
    _meta: { kiro: {
      kind: 'turn_completion',
      elapsedTime: 88896,
      status: 'failed',
      promptTurnSummaries: [{ usedTools: ['read_file'], unit: 'credit', usage: 0.984 }],
      replay: true,
    } },
  }));
  assert.deepEqual(ev, {
    kind: 'turn-completion',
    elapsedTimeMs: 88896,
    status: 'failed',
    replay: true,
  });
});

test('turn_completion 缺 elapsedTime → elapsedTimeMs=null', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'session_info_update',
    _meta: { kiro: { kind: 'turn_completion', status: 'completed' } },
  }));
  assert.equal(ev.kind, 'turn-completion');
  assert.equal(ev.elapsedTimeMs, null);
  assert.equal(ev.status, 'completed');
});

test('session_info_update + context_usage / turn_start / steering_inclusion → kind:null（已知不展示）', () => {
  for (const k of ['context_usage', 'turn_start', 'steering_inclusion']) {
    const ev = normalizeUpdate(frame({
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: k } },
    }));
    assert.deepEqual(ev, { kind: null }, k);
  }
});

test('session_info_update + display_error → unknown（可观测）', () => {
  const ev = normalizeUpdate(frame({
    sessionUpdate: 'session_info_update',
    _meta: { kiro: { kind: 'display_error', message: 'BedrockValidationError' } },
  }));
  assert.deepEqual(ev, { kind: 'unknown', updateType: 'display_error', replay: false });
});

test('tool_call / tool_call_update 透传 _meta.kiro.timestamp', () => {
  const ts = '2026-09-11T11:52:14.914Z';
  const first = normalizeUpdate(frame({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Read File',
    kind: 'read',
    status: 'in_progress',
    _meta: { kiro: { timestamp: ts, replay: true } },
  }));
  assert.equal(first.timestamp, ts);
  const upd = normalizeUpdate(frame({
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
    _meta: { kiro: { timestamp: '2026-09-11T11:52:17.914Z', replay: true } },
  }));
  assert.equal(upd.timestamp, '2026-09-11T11:52:17.914Z');
});
