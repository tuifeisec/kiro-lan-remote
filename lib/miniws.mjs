// 极简 WebSocket 帧编解码（RFC 6455 子集：文本帧、分片、ping/pong、close）
//
// 从 server.mjs 原样抽取的独立模块：server.mjs（浏览器侧）与测试用 mock mux
// （test/helpers/mockMux.mjs）共用同一套帧实现。
// 选择自实现是为了保持"零依赖"，避免要求用户 npm install。

import { createHash } from 'node:crypto';

/**
 * 计算 RFC6455 握手所需的 Sec-WebSocket-Accept 值。
 * @param {string} key 客户端 Sec-WebSocket-Key
 */
export function crypto_accept(key) {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');
}

/**
 * 在已完成 HTTP 101 升级的 socket 上建立一个极简 WS 连接对象。
 * @param {import('node:net').Socket} socket
 * @param {(...args:any[])=>void} log 诊断日志钩子（默认静默；服务端传入带时间戳的 log）
 */
export function createWsConn(socket, log = () => {}) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const messageHandlers = [];
  const closeHandlers = [];
  /** 分片消息累积 */
  let fragOpcode = 0;
  let fragParts = [];

  function send(text) {
    if (closed || socket.destroyed) return;
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81; // FIN + text
    try { socket.write(Buffer.concat([header, payload])); } catch {}
  }

  function sendClose(code = 1000, reason = '') {
    if (closed || socket.destroyed) return;
    const r = Buffer.from(reason, 'utf8');
    const buf = Buffer.alloc(2 + r.length);
    buf.writeUInt16BE(code, 0);
    r.copy(buf, 2);
    const header = Buffer.alloc(2);
    header[0] = 0x88;
    header[1] = buf.length;
    try { socket.write(Buffer.concat([header, buf])); } catch {}
    closed = true;
    socket.end();
  }

  function emitMessage(text) {
    for (const h of messageHandlers) {
      try { h(text); } catch (e) { log('消息处理异常：', e.message); }
    }
  }

  function handleFrame(opcode, payload) {
    if (opcode === 0x1) { // text
      emitMessage(payload.toString('utf8'));
    } else if (opcode === 0x0) { // continuation
      fragParts.push(payload);
    } else if (opcode === 0x2) { // binary — 本应用不使用，忽略
    } else if (opcode === 0x8) { // close
      closed = true;
      try { socket.end(); } catch {}
      for (const h of closeHandlers) { try { h(); } catch {} }
    } else if (opcode === 0x9) { // ping
      const header = Buffer.alloc(2);
      header[0] = 0x8a;
      header[1] = payload.length;
      try { socket.write(Buffer.concat([header, payload])); } catch {}
    } else if (opcode === 0xa) { // pong
    }
  }

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > 64n * 1024n * 1024n) { sendClose(1009, 'message too big'); return; }
        len = Number(big);
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + len) return;

      const raw = Buffer.from(buffer.subarray(offset, offset + len));
      buffer = buffer.subarray(offset + len);

      if (maskKey) {
        for (let i = 0; i < raw.length; i++) raw[i] ^= maskKey[i & 3];
      }

      if (opcode === 0x0) {
        fragParts.push(raw);
        if (fin) {
          const full = Buffer.concat(fragParts);
          fragParts = [];
          if (fragOpcode === 0x1) emitMessage(full.toString('utf8'));
          fragOpcode = 0;
        }
      } else if (opcode === 0x1 && !fin) {
        fragOpcode = 0x1;
        fragParts = [raw];
      } else {
        handleFrame(opcode, raw);
      }
    }
  });

  socket.on('error', () => { closed = true; for (const h of closeHandlers) { try { h(); } catch {} } });
  socket.on('close', () => { if (!closed) { closed = true; for (const h of closeHandlers) { try { h(); } catch {} } } });

  return {
    send,
    onMessage: h => messageHandlers.push(h),
    onClose: h => closeHandlers.push(h),
    close: () => sendClose(1000, 'server closing'),
    get readyState() { return closed ? 3 : 1; },
  };
}
