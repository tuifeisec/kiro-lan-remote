/**
 * 权限 store。
 * 对应开发文档 5.4 与 10.3。
 *
 * 权限请求是带 reqId/sessionId 的异步资源。所有结束操作都必须带条件，
 * 防止旧请求的响应、超时或清理通知关闭新请求，或清理其他会话的等待状态。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { PermissionOption, PermissionToolCall } from '../protocol/types';

export interface PendingPermission {
  reqId: string;
  sessionId: string;
  /** 收到请求时当前会话的回合；没有可匹配回合时为 null。 */
  turnId: string | null;
  toolCallId: string | null;
  toolCall: PermissionToolCall | null;
  options: PermissionOption[];
  /** 请求归属会话的标题；服务端未携带时为 null。弹层用它提示「是哪个会话在请求」。 */
  sessionTitle: string | null;
  createdAt: number;
  state: 'open' | 'resolving' | 'resolved' | 'timeout' | 'deferred';
}

export const usePermissionStore = defineStore('permission', () => {
  /** 当前打开的权限请求；null 表示无待决。 */
  const current = ref<PendingPermission | null>(null);
  /** 最近一次结束原因，供界面提示（超时 / 交回 / 已应答）。 */
  const lastOutcome = ref<{ reqId: string; kind: 'timeout' | 'cleared' | 'answered' | 'deferred' } | null>(null);

  const isOpen = computed(
    () => current.value?.state === 'open' || current.value?.state === 'resolving'
  );
  const isResolving = computed(() => current.value?.state === 'resolving');

  /** 打开一个权限请求。已有待决请求时忽略新的，避免异步请求互相覆盖。 */
  function open(req: {
    reqId: string;
    sessionId: string;
    turnId?: string | null;
    toolCall: PermissionToolCall | null;
    options: PermissionOption[];
    sessionTitle?: string | null;
  }): boolean {
    if (current.value) return false;
    current.value = {
      reqId: req.reqId,
      sessionId: req.sessionId,
      turnId: req.turnId ?? null,
      toolCallId: req.toolCall?.toolCallId ?? null,
      toolCall: req.toolCall,
      options: req.options,
      sessionTitle: req.sessionTitle ?? null,
      createdAt: Date.now(),
      state: 'open',
    };
    lastOutcome.value = null;
    return true;
  }

  /** 标记指定请求为应答中。 */
  function markResolving(reqId: string): boolean {
    const item = current.value;
    if (!item || item.reqId !== reqId || item.state !== 'open') return false;
    item.state = 'resolving';
    return true;
  }

  /** 传输失败时恢复指定请求的可操作状态。 */
  function restoreOpen(reqId: string): boolean {
    const item = current.value;
    if (!item || item.reqId !== reqId || item.state !== 'resolving') return false;
    item.state = 'open';
    return true;
  }

  /** 只关闭指定 reqId，旧请求不能关闭新请求。 */
  function closeIf(reqId: string): boolean {
    if (current.value?.reqId !== reqId) return false;
    current.value = null;
    return true;
  }

  /** 服务端超时：只处理匹配的当前请求。 */
  function handleTimeout(reqId: string): PendingPermission | null {
    const item = current.value;
    if (!item || item.reqId !== reqId) return null;
    item.state = 'timeout';
    current.value = null;
    lastOutcome.value = { reqId, kind: 'timeout' };
    return item;
  }

  /** 指定会话这一轮已结束，残留弹层作废。 */
  function handleCleared(sessionId: string): PendingPermission | null {
    const item = current.value;
    if (!item || item.sessionId !== sessionId) return null;
    current.value = null;
    lastOutcome.value = { reqId: item.reqId, kind: 'cleared' };
    return item;
  }

  /** 记录指定请求已应答；请求不匹配时不覆盖新请求的结果。 */
  function noteAnswered(reqId: string, deferred: boolean): boolean {
    if (current.value?.reqId !== reqId) return false;
    lastOutcome.value = { reqId, kind: deferred ? 'deferred' : 'answered' };
    return true;
  }

  return {
    current,
    lastOutcome,
    isOpen,
    isResolving,
    open,
    markResolving,
    restoreOpen,
    closeIf,
    handleTimeout,
    handleCleared,
    noteAnswered,
  };
});
