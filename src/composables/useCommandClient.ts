/**
 * 命令客户端：自增请求 ID、pending 表、超时、断线批量 reject。
 *
 * 超时分类（保持原行为）：
 *   - 普通命令：120 秒
 *   - session.prompt：**不设超时** —— 它要等整个 agent 回合结束才应答
 *   - 权限响应：30 秒（比服务端 5 分钟超时短，保证 UI 能及时给出失败反馈）
 *
 * 这里不做「降级」「重试」「静默兜底」：断线即让所有在飞请求失败，
 * 由上层决定是重连后重新拉取，还是给用户看错误。
 */

export interface CommandRequestOptions {
  /** 超时毫秒数；0 或负数表示不设超时。缺省 120000。 */
  timeoutMs?: number;
}

export const TIMEOUT_DEFAULT_MS = 120_000;
export const TIMEOUT_PERMISSION_MS = 30_000;
/** session.prompt 不设前端超时：回合结束由事件驱动。 */
export const TIMEOUT_NO_LIMIT = 0;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CommandClient {
  request: (method: string, params?: unknown, options?: CommandRequestOptions) => Promise<unknown>;
  /** 消费一条 res 消息；返回是否命中在飞请求。 */
  resolve: (id: number, ok: boolean, result: unknown, error?: string) => boolean;
  /** 断线时批量失败，避免请求挂到超时。 */
  rejectAll: (error: Error) => void;
  pendingCount: () => number;
}

/**
 * @param send 实际的发送函数；返回 false 表示连接不可用
 * @param whenOpen 等待连接就绪；断开时 reject
 */
export function createCommandClient(
  send: (payload: unknown) => boolean,
  whenOpen: () => Promise<void>
): CommandClient {
  let seq = 0;
  const pending = new Map<number, Pending>();

  async function request(
    method: string,
    params?: unknown,
    options?: CommandRequestOptions
  ): Promise<unknown> {
    await whenOpen();

    return new Promise<unknown>((resolve, reject) => {
      const id = ++seq;
      const limit = options?.timeoutMs === undefined ? TIMEOUT_DEFAULT_MS : options.timeoutMs;

      const entry: Pending = {
        resolve,
        reject,
        timer:
          limit > 0
            ? setTimeout(() => {
                if (!pending.has(id)) return;
                pending.delete(id);
                reject(new Error(`${method} 超时`));
              }, limit)
            : null,
      };
      pending.set(id, entry);

      const sent = send({ type: 'cmd', id, method, params: params ?? {} });
      if (!sent) {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(id);
        reject(new Error('连接未就绪'));
      }
    });
  }

  function resolve(id: number, ok: boolean, result: unknown, error?: string): boolean {
    const p = pending.get(id);
    if (!p) return false; // 迟到的 res（超时后到达）直接丢弃
    if (p.timer) clearTimeout(p.timer);
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error || '未知错误'));
    return true;
  }

  function rejectAll(error: Error): void {
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  }

  return { request, resolve, rejectAll, pendingCount: () => pending.size };
}
