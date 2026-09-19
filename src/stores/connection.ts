/**
 * 连接 store：WebSocket 生命周期 + 命令客户端 + 状态快照。
 *
 * 职责边界（对应开发文档 5.1）：
 *   - 建立/关闭浏览器 WebSocket、重连退避
 *   - 发送命令、维护 pending 请求
 *   - 分发收到的 status / res（event 与权限事件由上层订阅回调处理）
 *   - **不保存任何消息 DOM 或会话内容**
 */

import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { createBrowserSocket, type BrowserSocket } from '../composables/useBrowserSocket';
import {
  createCommandClient,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_NO_LIMIT,
  TIMEOUT_PERMISSION_MS,
  type CommandClient,
} from '../composables/useCommandClient';
import { parseServerMessage } from '../protocol/guards';
import type { ConfigOption, ServerMessage, StatusPayload } from '../protocol/types';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed';

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnectionState>('idle');
  const retryCount = ref(0);
  const lastError = ref<string | null>(null);
  const endpoint = ref<{ port: number; pid: number } | null>(null);
  const agentInfo = shallowRef<unknown | null>(null);
  const permissionPolicy = ref<string | null>(null);
  const muxConnected = ref(false);
  const browsers = ref(0);
  const modelId = ref<string | null>(null);
  const modelName = ref<string | null>(null);
  /** 服务端 status 带来的配置快照。权威来源是 config store，这里只作透传。 */
  const configOptions = shallowRef<ConfigOption[]>([]);
  /** configOptions 的归属会话（契约 v2）；null 表示无会话归属。 */
  const configSessionId = ref<string | null>(null);
  const commandSeq = ref(0);

  let socket: BrowserSocket | null = null;
  let commandClient: CommandClient | null = null;

  /** 等待连接就绪的挂起者；断线时统一 reject。 */
  let openWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  /** 消息订阅者。event / permission-* 由具体 store 注册，避免 connection store 认识业务。 */
  const listeners = new Set<(msg: ServerMessage) => void>();

  function whenOpen(): Promise<void> {
    if (socket?.isOpen()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      openWaiters.push({ resolve, reject });
    });
  }

  function flushWaiters(error?: Error): void {
    const waiters = openWaiters;
    openWaiters = [];
    for (const w of waiters) {
      if (error) w.reject(error);
      else w.resolve();
    }
  }

  function applyStatus(status: StatusPayload): void {
    muxConnected.value = status.connected;
    if (status.endpoint) endpoint.value = status.endpoint;
    permissionPolicy.value = status.permissionPolicy;
    lastError.value = status.lastError;
    agentInfo.value = status.agentInfo;
    browsers.value = status.browsers;
    if (status.modelId) modelId.value = status.modelId;
    modelName.value = status.modelName;
    // 只在非空时覆盖：服务端某次推空数组时保留旧值（与原实现一致）
    if (status.configOptions.length) configOptions.value = status.configOptions;
    // configSessionId 每次都覆盖：null 也是有效归属信号（无会话）
    configSessionId.value = status.configSessionId;
  }

  function handleMessage(msg: ServerMessage): void {
    if (msg.type === 'status') {
      applyStatus(msg.status);
      state.value = 'connected';
      return;
    }
    if (msg.type === 'res') {
      commandClient?.resolve(msg.id, msg.ok, msg.result, msg.error);
      return;
    }
    // event / permission-* 交给订阅者
    for (const fn of listeners) fn(msg);
  }

  function subscribe(fn: (msg: ServerMessage) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function connect(key: string): void {
    if (socket) return; // 幂等：重复调用不重建连接

    state.value = 'connecting';
    commandClient = null;

    socket = createBrowserSocket(key, {
      onOpen: (isReconnect) => {
        state.value = 'connected';
        retryCount.value = 0;
        flushWaiters();
        // 断线重连（而非首次连接）后由上层重新同步界面状态
        if (isReconnect) for (const fn of reconnectHandlers) fn();
      },
      onMessage: (raw) => {
        const msg = parseServerMessage(raw);
        if (!msg) return; // 未知 type 或结构非法
        handleMessage(msg);
      },
      onClose: () => {
        state.value = 'reconnecting';
        retryCount.value += 1;
        // 在飞命令立即失败，而不是静默等到超时
        commandClient?.rejectAll(new Error('连接已断开'));
        flushWaiters(new Error('连接已断开'));
      },
    });

    commandClient = createCommandClient(
      (payload) => socket!.sendRaw(payload),
      whenOpen
    );
    socket.connect();
  }

  const reconnectHandlers = new Set<() => void>();
  function onReconnect(fn: () => void): () => void {
    reconnectHandlers.add(fn);
    return () => reconnectHandlers.delete(fn);
  }

  /** 发送命令。options.timeoutMs === 0 表示不设超时（session.prompt）。 */
  function request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    if (!commandClient) return Promise.reject(new Error('连接未初始化'));
    return commandClient.request(method, params, options);
  }

  function disconnect(): void {
    socket?.close();
    socket = null;
    commandClient?.rejectAll(new Error('已断开'));
    commandClient = null;
    state.value = 'closed';
  }

  return {
    state,
    retryCount,
    lastError,
    endpoint,
    agentInfo,
    permissionPolicy,
    muxConnected,
    browsers,
    modelId,
    modelName,
    configOptions,
    configSessionId,
    commandSeq,

    connect,
    disconnect,
    onReconnect,
    subscribe,
    request,
    whenOpen,

    // 超时常量导出，供 UI 层语义化使用
    TIMEOUT_DEFAULT_MS,
    TIMEOUT_PERMISSION_MS,
    TIMEOUT_NO_LIMIT,
  };
});
