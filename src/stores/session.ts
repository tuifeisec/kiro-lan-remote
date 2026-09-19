/**
 * 会话 store：会话列表、工作区分组、当前会话。
 * 对应开发文档 5.2。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { normCwd, wsName } from '../utils/path.ts';
import type { SessionSummary } from '../protocol/types';

export interface WorkspaceGroup {
  /** 归一化后的分组键（用于去重与稳定标识）。 */
  key: string;
  /** 原始 cwd，用于展示与新建会话。 */
  cwd: string;
  /** 工作区显示名。 */
  name: string;
  items: SessionSummary[];
  /** 最近更新时间（毫秒），用于组间排序。 */
  latest: number;
}

const tsOf = (s: SessionSummary): number => {
  const t = Date.parse(s.updatedAt || '');
  return Number.isNaN(t) ? 0 : t;
};

/** 会话实时活动状态：running=正在产出 / ended=回合已结束。 */
export type LiveStatus = 'running' | 'ended';

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionSummary[]>([]);
  const activeSessionId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** 折叠全部工作区后，新数据到达也不自动展开。 */
  const collapsedAll = ref(false);

  /**
   * 会话元数据的实时投影（事件流驱动，先于下一次 sessions.list 轮询）。
   * key 为 sessionId；整体替换 Map 以保证响应式。
   */
  const liveStatus = ref(new Map<string, LiveStatus>());

  const active = computed(
    () => sessions.value.find((s) => s.sessionId === activeSessionId.value) ?? null
  );

  /**
   * 按工作区分组。
   *
   * 排序规则（与原实现一致）：
   *   - 组内：按 updatedAt 降序（最近更新的会话在前）
   *   - 组间：按各组最新会话的 updatedAt 降序
   * 分组键用 normCwd，使 `d:\x` 与 `d:/x` 合并为同一工作区。
   */
  const groupedSessions = computed<WorkspaceGroup[]>(() => {
    const order: WorkspaceGroup[] = [];
    const byKey = new Map<string, WorkspaceGroup>();

    for (const s of sessions.value) {
      const key = normCwd(s.cwd);
      let g = byKey.get(key);
      if (!g) {
        g = { key, cwd: s.cwd || '', name: wsName(s.cwd), items: [], latest: 0 };
        byKey.set(key, g);
        order.push(g);
      }
      g.items.push(s);
    }

    for (const g of order) {
      g.items.sort((a, b) => tsOf(b) - tsOf(a));
      g.latest = tsOf(g.items[0]);
    }
    order.sort((a, b) => b.latest - a.latest);
    return order;
  });

  const summaryText = computed(() => {
    if (!sessions.value.length) return '';
    return `${groupedSessions.value.length} 个工作区 · ${sessions.value.length} 个会话`;
  });

  function setActive(sessionId: string | null): void {
    activeSessionId.value = sessionId;
  }

  function setSessions(list: SessionSummary[]): void {
    // 轮询兜底每 15s 拉一次全量列表：内容没变就跳过替换，
    // 否则侧栏整列表（180+ 行）每 15 秒白白重渲染一次，滚动时能感知到顿挫。
    const cur = sessions.value;
    if (
      cur.length === list.length &&
      cur.every((s, i) => {
        const n = list[i];
        return (
          n.sessionId === s.sessionId &&
          n.title === s.title &&
          n.updatedAt === s.updatedAt &&
          n.status === s.status &&
          n.agentMode === s.agentMode
        );
      })
    ) {
      error.value = null;
      return;
    }
    sessions.value = list;
    error.value = null;
  }

  // ---------- 实时元数据投影（事件流 → 会话列表） ----------

  /**
   * 用事件流里的会话元数据 patch 列表条目。
   * 只更新已存在的条目，不新建 —— 列表本身仍以 sessions.list 为准，
   * 新会话等下一次轮询被发现。
   *
   * 性能契约：值没变就**不动数组**。运行中会话的每个流式事件都会走到
   * 这里，无差别替换整个数组会让 groupedSessions 重排序、侧栏整列
   * 重渲染（实测是页面卡顿的主因之一）。
   */
  function applyLiveMeta(sessionId: string, patch: { title?: string; updatedAt?: string }): void {
    const idx = sessions.value.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0) return;
    const cur = sessions.value[idx];
    const title = patch.title !== undefined ? patch.title : cur.title;
    const updatedAt = patch.updatedAt !== undefined ? patch.updatedAt : cur.updatedAt;
    if (title === cur.title && updatedAt === cur.updatedAt) return;
    const next: SessionSummary = { ...cur, title, updatedAt };
    const list = sessions.value.slice();
    list[idx] = next;
    sessions.value = list;
  }

  /** 重命名会话（session-info.title）。空串忽略，避免事件缺字段清掉已有标题。 */
  function renameSession(sessionId: string, title: string): void {
    if (!title) return;
    applyLiveMeta(sessionId, { title });
  }

  /**
   * 标记会话实时活动状态；整体替换 Map 以触发响应式。
   * 状态没变时必须跳过：运行中会话的每个流式分片都会调用，
   * 无守护的替换会让侧栏全部会话行跟着每个分片重渲染。
   */
  function markLive(sessionId: string, status: LiveStatus): void {
    if (liveStatus.value.get(sessionId) === status) return;
    const m = new Map(liveStatus.value);
    m.set(sessionId, status);
    liveStatus.value = m;
  }

  /** 查询会话实时活动状态；无记录返回 null。 */
  function liveStatusOf(sessionId: string): LiveStatus | null {
    return liveStatus.value.get(sessionId) ?? null;
  }

  return {
    sessions,
    activeSessionId,
    active,
    loading,
    error,
    collapsedAll,
    liveStatus,
    groupedSessions,
    summaryText,
    setActive,
    setSessions,
    applyLiveMeta,
    renameSession,
    markLive,
    liveStatusOf,
  };
});
