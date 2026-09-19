// 契约测试（协议契约 v2）：权限全量接管（FIFO 队列）+ events.resume 断线补发 + configSessionId
//
// 结构：子进程起 node server.mjs（AUTO_DISCOVER=false，mux 指向 mockMux），
// 浏览器侧用 Node 全局 WebSocket 客户端连 /ws?key=testkey。
// 全部用例确定性（显式超时 + 轮询等待），不依赖真实 Kiro。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockMux } from './helpers/mockMux.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, { timeout = 5000, step = 25, describe = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`等待超时（${timeout}ms）：${describe}`);
    await sleep(step);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** 浏览器侧 WS 客户端封装：inbox 收全部消息，cmd 按应答 id 匹配 */
function openBrowser(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=testkey`);
  const b = { ws, inbox: [], nextId: 1, closed: false };
  ws.addEventListener('message', ev => {
    try { b.inbox.push(JSON.parse(ev.data)); } catch {}
  });
  ws.addEventListener('close', () => { b.closed = true; });
  b.opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('浏览器 WS 连接失败')), { once: true });
  });
  b.cmd = (method, params = {}) => {
    const id = b.nextId++;
    ws.send(JSON.stringify({ type: 'cmd', id, method, params }));
    return waitFor(
      () => b.inbox.find(m => m.type === 'res' && m.id === id),
      { timeout: 8000, describe: `res ${method}#${id}` },
    );
  };
  b.events = () => b.inbox.filter(m => m.type === 'event');
  b.close = () => new Promise(resolve => {
    if (b.closed || ws.readyState !== 1) { b.closed = true; return resolve(); }
    ws.addEventListener('close', resolve, { once: true });
    ws.close();
  });
  return b;
}

/** 触发 server 连接 mock mux 并等待 connected（AUTO_DISCOVER=false 下 cmd 才会连接） */
async function waitMuxConnected(b) {
  const start = Date.now();
  for (;;) {
    const r = await b.cmd('status');
    if (r.ok && r.result.connected === true) return r.result;
    if (Date.now() - start > 10_000) throw new Error('mux 未能在 10s 内连接');
    await sleep(200);
  }
}

function textUpdate(sid, text) {
  return { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

describe('契约：权限全量接管 + events.resume', () => {
  let mock;
  let serverProc;
  let serverPort;
  let serverLog = [];

  before(async () => {
    mock = createMockMux();
    await mock.ready;
    serverPort = await getFreePort();

    const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
    serverProc = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        AUTO_DISCOVER: 'false',
        KIRO_MUX_PORT: String(mock.port),
        KIRO_MUX_TOKEN: '11111111-2222-4333-8444-555555555555',
        ACCESS_KEY: 'testkey',
        PORT: String(serverPort),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => serverLog.push(String(d)));
    serverProc.stderr.on('data', d => serverLog.push(String(d)));

    // 等待 HTTP 服务就绪
    const start = Date.now();
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
        if (res.ok) break;
      } catch {}
      if (Date.now() - start > 10_000) throw new Error('server.mjs 未能在 10s 内监听');
      await sleep(100);
    }
  });

  after(async () => {
    if (serverProc?.exitCode === null) {
      serverProc.kill();
      await Promise.race([once(serverProc, 'exit'), sleep(3000)]);
    }
    await mock?.close();
    console.log('----- server.mjs 输出尾部 -----');
    console.log(serverLog.slice(-30).join(''));
  });

  test('1. status 首帧含 configSessionId（string|null）', async () => {
    const b = openBrowser(serverPort);
    await b.opened;
    const first = await waitFor(() => b.inbox.find(m => m.type === 'status'), { describe: 'status 首帧' });
    assert.equal(typeof first.status.browsers, 'number');
    assert.ok(
      first.status.configSessionId === null || typeof first.status.configSessionId === 'string',
      `configSessionId 应为 string|null，实际：${JSON.stringify(first.status.configSessionId)}`,
    );
    assert.equal(first.status.configSessionId, null); // 尚未有任何会话操作
    await b.close();
  });

  test('2. 事件入缓冲、seq 递增；断线后 events.resume 恰好补发缺失事件并带 resume:true', async () => {
    const b = openBrowser(serverPort);
    await b.opened;
    await waitMuxConnected(b);

    // mock 推 3 条 → 浏览器按序收到 3 条 event
    mock.pushUpdate(textUpdate('s1', 'm1'));
    mock.pushUpdate(textUpdate('s1', 'm2'));
    mock.pushUpdate(textUpdate('s1', 'm3'));
    const evs = await waitFor(
      () => {
        const list = b.events().filter(e => e.sessionId === 's1');
        return list.length >= 3 ? list : null;
      },
      { describe: '3 条 session 事件' },
    );
    assert.equal(evs.length, 3);
    assert.deepEqual(evs.map(e => e.event.text), ['m1', 'm2', 'm3']);
    assert.ok(evs[0].seq < evs[1].seq && evs[1].seq < evs[2].seq, 'seq 应递增');
    assert.equal(evs[0].event.kind, 'assistant-text');
    assert.notEqual(evs[0].event.resume, true, '实时事件不得带 resume 标记');
    const lastSeq = evs[2].seq;

    // 断开浏览器，再推 2 条（无浏览器在线，只进缓冲）
    await b.close();
    await sleep(300); // 等服务端 onClose 生效
    mock.pushUpdate(textUpdate('s1', 'm4'));
    mock.pushUpdate(textUpdate('s1', 'm5'));

    // 重连后 events.resume(afterSeq=旧值)
    const b2 = openBrowser(serverPort);
    await b2.opened;
    const res = await b2.cmd('events.resume', { sessionId: 's1', afterSeq: lastSeq });
    assert.equal(res.ok, true);
    assert.equal(res.result.delivered, 2);
    assert.equal(res.result.requiresReplay, false);
    assert.ok(Number.isInteger(res.result.lastSeq));
    assert.ok(res.result.lastSeq >= lastSeq + 2);

    // 恰好收到缺失的 2 条，均带 resume:true，seq 递增且大于旧值
    await sleep(300); // 确认没有更多补发
    const resumed = b2.events().filter(e => e.sessionId === 's1' && e.event.resume === true);
    assert.equal(resumed.length, 2);
    assert.deepEqual(resumed.map(e => e.event.text), ['m4', 'm5']);
    assert.ok(resumed[0].seq > lastSeq && resumed[0].seq < resumed[1].seq);
    assert.ok(resumed.every(e => e.seq <= res.result.lastSeq));
    await b2.close();
    await sleep(300);
  });

  test('3. events.resume 出现缺口（afterSeq=0 但缓冲非从 1 开始）→ requiresReplay=true 且不补发', async () => {
    const b = openBrowser(serverPort);
    await b.opened;

    // 新会话 s2：其缓冲里的首条 seq 必然 > 1（seq 是全局递增的）
    mock.pushUpdate(textUpdate('s2', 'k1'));
    mock.pushUpdate(textUpdate('s2', 'k2'));
    mock.pushUpdate(textUpdate('s2', 'k3'));
    await waitFor(() => b.events().filter(e => e.sessionId === 's2').length >= 3, { describe: 's2 的 3 条事件' });

    const res = await b.cmd('events.resume', { sessionId: 's2', afterSeq: 0 });
    assert.equal(res.ok, true);
    assert.equal(res.result.delivered, 0);
    assert.equal(res.result.requiresReplay, true);
    assert.ok(Number.isInteger(res.result.lastSeq));

    await sleep(300);
    const s2WithResume = b.events().filter(e => e.sessionId === 's2' && e.event.resume === true);
    assert.equal(s2WithResume.length, 0, '缺口时不得补发任何事件');
    await b.close();
    await sleep(300);
  });

  test('4. permission-request 带 sessionTitle；手机应答转发为 _kiro/permission/respond', async () => {
    const b = openBrowser(serverPort);
    await b.opened;
    await waitMuxConnected(b);

    // 先让会话标题进缓存（session-info 事件）
    mock.pushUpdate({ sessionId: 's1', update: { sessionUpdate: 'session_info_update', title: '测试会话标题' } });
    await waitFor(() => b.events().find(e => e.event.kind === 'session-info'), { describe: 'session-info 事件' });

    mock.sendPermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-perm-1', title: '读文件' },
      options: [
        { optionId: 'opt-allow', kind: 'allow_once', name: '允许一次' },
        { optionId: 'opt-reject', kind: 'reject_once', name: '拒绝' },
      ],
    });

    const pr = await waitFor(() => b.inbox.find(m => m.type === 'permission-request'), { describe: 'permission-request' });
    assert.equal(pr.sessionId, 's1');
    assert.equal(pr.sessionTitle, '测试会话标题');
    assert.ok(pr.reqId);
    assert.equal(pr.toolCall.toolCallId, 'tc-perm-1');
    assert.equal(pr.options.length, 2);

    const r = await b.cmd('permission.resolve', { reqId: pr.reqId, optionId: 'allow_once' });
    assert.equal(r.ok, true);
    assert.equal(r.result.resolved, true);

    await waitFor(
      () => mock.permissionResponds.find(p => p.toolCallId === 'tc-perm-1' && p.optionId === 'allow_once'),
      { describe: 'mock mux 收到 _kiro/permission/respond' },
    );
    await b.close();
    await sleep(300);
  });

  test('5. _kiro/permission/respond 被拒 → 浏览器收到 permission-cleared', async () => {
    const b = openBrowser(serverPort);
    await b.opened;
    mock.setRespondError(true);
    try {
      mock.sendPermissionRequest({
        sessionId: 's1',
        toolCall: { toolCallId: 'tc-perm-2', title: '写文件' },
        options: [{ optionId: 'opt-allow', kind: 'allow_once', name: '允许一次' }],
      });
      const pr = await waitFor(() => b.inbox.find(m => m.type === 'permission-request' && m.toolCall?.toolCallId === 'tc-perm-2'), { describe: 'permission-request #2' });

      const r = await b.cmd('permission.resolve', { reqId: pr.reqId, optionId: 'allow_once' });
      assert.equal(r.result.resolved, true);

      const cleared = await waitFor(() => b.inbox.find(m => m.type === 'permission-cleared'), { describe: 'permission-cleared' });
      assert.equal(cleared.sessionId, 's1');
    } finally {
      mock.setRespondError(false);
    }
    await b.close();
    await sleep(300);
  });

  test('6. FIFO：连续两个权限请求，先只弹第 1 个；应答后才弹第 2 个', async () => {
    const b = openBrowser(serverPort);
    await b.opened;

    mock.sendPermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-fifo-1', title: '第一个' },
      options: [{ optionId: 'opt-allow', kind: 'allow_once', name: '允许一次' }],
    });
    mock.sendPermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-fifo-2', title: '第二个' },
      options: [{ optionId: 'opt-allow', kind: 'allow_once', name: '允许一次' }],
    });

    const first = await waitFor(() => b.inbox.find(m => m.type === 'permission-request'), { describe: '第 1 个 permission-request' });
    assert.equal(first.toolCall.toolCallId, 'tc-fifo-1');

    await sleep(400);
    const all = b.inbox.filter(m => m.type === 'permission-request');
    assert.equal(all.length, 1, '第 2 个请求必须排队，不得同时弹出');

    const r = await b.cmd('permission.resolve', { reqId: first.reqId, optionId: 'allow_once' });
    assert.equal(r.result.resolved, true);

    const second = await waitFor(
      () => b.inbox.find(m => m.type === 'permission-request' && m.toolCall?.toolCallId === 'tc-fifo-2'),
      { describe: '第 2 个 permission-request' },
    );
    assert.notEqual(second.reqId, first.reqId);

    // 清理：应答第 2 个，避免残留待决权限影响后续用例
    await b.cmd('permission.resolve', { reqId: second.reqId, optionId: 'opt-allow' });
    await waitFor(
      () => mock.permissionResponds.find(p => p.toolCallId === 'tc-fifo-2'),
      { describe: 'mock mux 收到第 2 个 respond' },
    );
    await b.close();
    await sleep(400); // 等服务端清空 browsers
  });

  test('7. 无浏览器在线时权限请求不入队：mux 端收不到 respond，server 保持静默', async () => {
    // 前置：此时所有浏览器已断开
    assert.ok(serverProc.exitCode === null || serverProc.exitCode === undefined, 'server 应仍在运行');
    const respondCountBefore = mock.permissionResponds.length;

    mock.sendPermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-nobrowser', title: '无人在线' },
      options: [{ optionId: 'opt-allow', kind: 'allow_once', name: '允许一次' }],
    });

    await sleep(800);
    assert.equal(
      mock.permissionResponds.find(p => p.toolCallId === 'tc-nobrowser'),
      undefined,
      '无浏览器时不得发出 _kiro/permission/respond',
    );
    assert.equal(mock.permissionResponds.length, respondCountBefore);
    assert.deepEqual(
      mock.clientResponses,
      [],
      'observer 对 session/request_permission 的 JSON-RPC 响应必须保持静默',
    );

    // server 未崩溃，仍可正常响应
    const b = openBrowser(serverPort);
    await b.opened;
    const r = await b.cmd('status');
    assert.equal(r.ok, true);
    await b.close();
  });
});
