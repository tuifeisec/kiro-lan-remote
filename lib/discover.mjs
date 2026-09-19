// Kiro 本机 mux 端点发现：定位 extension host 进程、监听端口，并解析出 token
//
// 背景（来自实测）：
//   Kiro 的 agent mux 是一个 WebSocket 服务，绑定 127.0.0.1:<随机端口>，
//   接收方为扩展宿主进程（命令行含 node.mojom.NodeService）。
//   连接必须携带 ?token=<uuid>，该 token 由 crypto.randomUUID() 生成且只存在于进程内存。
//   因此这里通过只读内存扫描 + 试连验证来取得 token。
//
// 安全边界：内存扫描为纯读取（PROCESS_VM_READ），不写入/不注入；
//           试连使用 role=observer（只读），不会驱动或干扰你的会话。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS1_DISCOVER = path.join(HERE, '..', 'discover.ps1');
const PS1_MEMSCAN = path.join(HERE, '..', 'memscan.ps1');

/**
 * 定位扩展宿主进程与它持有的本地监听端口。
 * @returns {Promise<{pid:number, ports:number[]}>}
 */
export async function findEndpoint() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_DISCOVER],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }
  );
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) throw new Error('discover.ps1 未返回结果');
  const info = JSON.parse(line);
  if (!info.pid) throw new Error(`未找到 Kiro 扩展宿主进程（${info.error ?? 'unknown'}）`);
  return { pid: info.pid, ports: Array.isArray(info.ports) ? info.ports : [] };
}

/**
 * 只读扫描指定进程内存，导出 UUID v4 候选。
 * @returns {Promise<string[]>}
 */
export async function dumpUuidCandidates(pid, { capMB = 900 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kiro-lan-'));
  const out = path.join(dir, 'uuids.txt');
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PS1_MEMSCAN,
        '-TargetPid', String(pid),
        '-CapMB', String(capMB),
        '-OutFile', out,
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 300_000 }
    );
    const text = await readFile(out, 'utf8');
    return text.split(/\r?\n/).map(s => s.trim()).filter(s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 用单个 token 尝试与 mux 握手。
 *
 * 关键细节：mux 服务端在校验 token 之前就已完成 WebSocket 握手，
 * 因此客户端的 open 事件**不能**作为"token 正确"的判据 —— 错误的 token
 * 也会先 open，随后立刻收到 close(4001, "Invalid token")。
 * 判定标准改为：open 之后在 settleMs 内未收到 close，才算通过。
 *
 * @returns {Promise<{ok:boolean, info:string}>}
 */
export function probeToken(port, token, { role = 'observer', settleMs = 400, timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let ws;
    let openedAt = 0;

    const finish = (ok, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { ws?.close(); } catch {}
      resolve({ ok, info });
    };

    const hardTimer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&role=${role}`);
    } catch (e) {
      return finish(false, 'ctor:' + e.message);
    }

    ws.addEventListener('open', () => {
      openedAt = Date.now();
      // 存活观察窗口：期间未被关闭即认为 token 有效
      setTimeout(() => {
        if (!settled && openedAt) finish(true, 'open+stable');
      }, settleMs);
    });
    ws.addEventListener('close', e => finish(false, `close ${e.code}`));
    ws.addEventListener('error', () => {});
  });
}

/**
 * 在候选集中并发搜索有效 token。
 * 找到即返回；失败时返回各失败原因的统计，便于诊断（例如端口不是 mux）。
 * @returns {Promise<{token:string|null, tried:number, reasons:Map<string,number>}>}
 */
export async function findToken(port, candidates, { role = 'observer', concurrency = 8 } = {}) {
  const reasons = new Map();
  let idx = 0;
  let found = null;

  async function worker() {
    while (idx < candidates.length && !found) {
      const token = candidates[idx++];
      const r = await probeToken(port, token, { role });
      if (r.ok) { found = token; return; }
      reasons.set(r.info, (reasons.get(r.info) ?? 0) + 1);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { token: found, tried: idx, reasons };
}

/**
 * 完整发现流程：定位端点 → 导出候选 → 逐端口试连。
 * @returns {Promise<{port:number, token:string, pid:number}>}
 */
export async function discoverMux({ onProgress = () => {}, capMB = 900 } = {}) {
  // 测试/调试钩子：环境变量 KIRO_MUX_PORT 与 KIRO_MUX_TOKEN 均非空时，
  // 跳过进程扫描与内存导出，直接返回给定端点（仅供测试/调试使用，
  // 正常使用请勿设置这两个变量，否则会绕过真实端点发现）。
  const envPort = process.env.KIRO_MUX_PORT?.trim();
  const envToken = process.env.KIRO_MUX_TOKEN?.trim();
  if (envPort && envToken) {
    onProgress(`测试钩子：跳过扫描，直接使用 port=${envPort}`);
    return { port: Number(envPort), token: envToken, pid: 0 };
  }

  onProgress('定位 Kiro 扩展宿主进程…');
  const { pid, ports } = await findEndpoint();
  onProgress(`扩展宿主 pid=${pid}，本地端口 [${ports.join(', ') || '无'}]`);

  if (ports.length === 0) {
    throw new Error('扩展宿主没有本地监听端口；请确认 Kiro 中至少打开了一个窗口。');
  }

  onProgress('只读扫描进程内存以获取 token 候选…');
  const candidates = await dumpUuidCandidates(pid, { capMB });
  onProgress(`获得 ${candidates.length} 个候选，开始试连…`);
  if (candidates.length === 0) {
    throw new Error('未从进程内存取得任何候选；请确认 Kiro 正在运行且已打开窗口。');
  }

  let last = null;
  for (const port of ports) {
    const { token, tried, reasons } = await findToken(port, candidates);
    if (token) {
      onProgress(`端口 ${port} 验证通过（尝试 ${tried} 个候选）`);
      return { port, token, pid };
    }
    last = { port, tried, reasons };
    onProgress(`端口 ${port} 未匹配：${[...reasons].map(([k, v]) => `${v}×${k}`).join(', ')}`);
  }

  const detail = last ? `最后端口 ${last.port}：${[...last.reasons].map(([k, v]) => `${v}×${k}`).join(', ')}` : '';
  throw new Error(`所有端口均未匹配到有效 token（候选 ${candidates.length} 个）。${detail}`);
}
