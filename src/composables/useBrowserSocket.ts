/**
 * 浏览器 WebSocket 连接层。
 *
 * 只负责：连接 /ws?key=...、JSON 解析、open/message/close 回调、重连退避、sendRaw。
 * **不负责业务命令** —— 那是 useCommandClient 的职责。
 *
 * 重连退避保持原行为：第 n 次延迟 min(1000*n, 6000)ms（线性递增、上限 6 秒），
 * 连上一次即重置节奏。这不是指数退避，是刻意保留的既有行为。
 */

export interface BrowserSocketHandlers {
  onOpen?: (isReconnect: boolean) => void;
  onMessage?: (message: unknown) => void;
  onClose?: () => void;
}

export interface BrowserSocket {
  connect: () => void;
  isOpen: () => boolean;
  sendRaw: (data: unknown) => boolean;
  close: () => void;
  /** 已成功连接过（区分首次连接与断线重连）。 */
  hasEverOpened: () => boolean;
}

const MAX_RETRY_DELAY_MS = 6000;

export function createBrowserSocket(key: string, handlers: BrowserSocketHandlers): BrowserSocket {
  let ws: WebSocket | null = null;
  let retry = 0;
  let everOpened = false;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function isOpen(): boolean {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  function connect(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      proto + '://' + location.host + '/ws?key=' + encodeURIComponent(key)
    );
    ws = socket;

    socket.onopen = () => {
      retry = 0;
      // 断线重连（而非首次连接）后需要重新同步界面状态
      const isReconnect = everOpened;
      everOpened = true;
      handlers.onOpen?.(isReconnect);
    };

    socket.onclose = () => {
      if (closedByUser) return;
      handlers.onClose?.();
      retry += 1;
      const delay = Math.min(1000 * retry, MAX_RETRY_DELAY_MS);
      retryTimer = setTimeout(connect, delay);
    };

    // 错误只通过 onclose 表达，这里刻意不做事 —— mux 侧非 1000 关闭码
    // 会同时触发 error + close，重复上报会造成状态抖动。
    socket.onerror = () => {};

    socket.onmessage = (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // 非法 JSON 帧静默丢弃
      }
      handlers.onMessage?.(msg);
    };
  }

  function sendRaw(data: unknown): boolean {
    if (!isOpen()) return false;
    try {
      ws!.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  function close(): void {
    closedByUser = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      ws?.close();
    } catch {
      // 关闭失败无需处理：连接已不可用
    }
    ws = null;
  }

  return {
    connect,
    isOpen,
    sendRaw,
    close,
    hasEverOpened: () => everOpened,
  };
}
