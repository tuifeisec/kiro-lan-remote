// 测试用 mock mux：最小 JSON-RPC over WebSocket 服务端，模拟 Kiro agent mux。
//
// 复用 lib/miniws.mjs 的握手（crypto_accept）与帧实现（createWsConn）——
// 与 server.mjs 浏览器侧是同一套帧代码，保证被测链路里的 WS 行为真实。
//
// 支持的最小 JSON-RPC 服务端：
//   initialize / session/list / session/new / session/load / session/prompt /
//   session/set_config_option / session/set_mode —— 都立即应答；
//   session/cancel 是 notification，不应答；
//   _kiro/permission/respond —— 记录 payload，可通过 setRespondError(true)
//   让它回 JSON-RPC error（模拟"桌面端已先应答/请求被拒"）。
//
// 可编程动作：
//   pushUpdate(params)          向 mux 客户端（被测 server.mjs）发 session/update 通知
//   sendPermissionRequest(p)    发 session/request_permission 请求（观察 observer 静默语义）
import http from 'node:http';
import { createWsConn, crypto_accept } from '../../lib/miniws.mjs';

export function createMockMux({ agentInfo } = {}) {
  /** 收到的全部请求/通知：{method, params, id, at} */
  const requests = [];
  /** 收到的 _kiro/permission/respond params 列表 */
  const permissionResponds = [];
  /** 收到的客户端 JSON-RPC 响应（observer 对 request_permission 应回答静默，此数组应保持为空） */
  const clientResponses = [];
  let respondError = false;
  const conns = new Set();
  const sessions = [];
  let sessionCounter = 0;
  let nextReqId = 5000;
  let port = null;

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
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
    const conn = createWsConn(socket, () => {});
    conns.add(conn);
    conn.onMessage(text => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      const { id, method, params } = msg;

      // 客户端发来的 JSON-RPC 响应（observer 对 session/request_permission
      // 必须保持静默 —— 该数组有任何记录都说明被测实现违约）
      if (method === undefined && id !== undefined) {
        clientResponses.push(msg);
        return;
      }
      if (!method) return;
      requests.push({ method, params, id: id ?? null, at: Date.now() });

      if (method === '_kiro/permission/respond') {
        permissionResponds.push(params);
        if (id !== undefined) {
          if (respondError) {
            conn.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'mock: permission respond rejected (desktop answered first)' } }));
          } else {
            conn.send(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
          }
        }
        return;
      }

      // session/cancel 是 notification 不应答；其他 notification 一律不应答
      if (method === 'session/cancel' || id === undefined) return;

      const reply = body => conn.send(JSON.stringify({ jsonrpc: '2.0', id, result: body }));
      switch (method) {
        case 'initialize':
          reply({ agentInfo: agentInfo ?? { name: 'mock-mux', version: '0.0.1' } });
          break;
        case 'session/list':
          reply({ sessions: sessions.slice() });
          break;
        case 'session/new': {
          const sid = `mock-s-${++sessionCounter}`;
          sessions.push({ sessionId: sid, cwd: params?.cwd, title: `mock session ${sessionCounter}` });
          reply({ sessionId: sid, configOptions: [] });
          break;
        }
        case 'session/load':
          reply({ sessionId: params?.sessionId ?? null, configOptions: [] });
          break;
        case 'session/prompt':
          reply({ stopReason: 'end_turn' });
          break;
        case 'session/set_config_option':
          reply({ configOptions: [] });
          break;
        case 'session/set_mode':
          reply({});
          break;
        default:
          conn.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `mock: method not found: ${method}` } }));
      }
    });
    conn.onClose(() => conns.delete(conn));
  });

  const ready = new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
    server.on('error', reject);
  });

  const api = {
    ready,
    /** 收到的全部请求/通知 */
    requests,
    /** 收到的 _kiro/permission/respond params 列表 */
    permissionResponds,
    /** 收到的客户端 JSON-RPC 响应（应恒为空） */
    clientResponses,
    get port() { return port; },
    /** 让 _kiro/permission/respond 回 error（模拟桌面端已先应答） */
    setRespondError(v) { respondError = !!v; },
    /** 向所有已连接的 mux 客户端发一条 session/update 通知 */
    pushUpdate(params) {
      const payload = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params });
      for (const c of conns) c.send(payload);
    },
    /** 向所有已连接的 mux 客户端发一条 session/request_permission 请求 */
    sendPermissionRequest(params) {
      const id = nextReqId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params });
      for (const c of conns) c.send(payload);
      return id;
    },
    close() {
      for (const c of conns) { try { c.close(); } catch {} }
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
  return api;
}
