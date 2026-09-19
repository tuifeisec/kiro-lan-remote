<script setup lang="ts">
/**
 * 会话行。低噪声信息：标题 + 相对时间 + 状态徽章 + 模式 pill（对齐官方：
 * 不渲染摘要行）。
 *
 * 实时状态：事件流投影（session store 的 liveStatusOf）优先于快照 status ——
 * running 时固定显示「运行中」（带低噪声脉动点），否则回退快照显示。
 * 只读访问 store，不修改其状态。
 */
import { computed } from 'vue';
import type { SessionSummary } from '../../protocol/types.ts';
import { useSessionStore } from '../../stores/session.ts';
import { cleanTitle } from '../../utils/title';
import { formatRelative } from '../../utils/time';
import { SVG_CHECK_BADGE } from '../../assets/icons';

const props = defineProps<{ session: SessionSummary }>();
const emit = defineEmits<{ (e: 'open', session: SessionSummary): void }>();

const sessions = useSessionStore();

const title = computed(() => cleanTitle(props.session));
const time = computed(() => formatRelative(props.session.updatedAt));

/** 实时运行中：快照 status 可能滞后（如仍报 in_progress 或未刷新），以此为准。 */
const liveRunning = computed(() => sessions.liveStatusOf(props.session.sessionId) === 'running');

/** 会话状态统一为中文，避免同一排 badge 里中英混用。 */
const STATUS_TEXT: Record<string, string> = {
  in_progress: '运行中',
  idle: '空闲',
  failed: '失败',
  completed: '已完成',
  cancelled: '已取消',
  pending: '等待中',
};

const statusClass = computed(() => {
  const s = props.session.status;
  if (s === 'in_progress') return 'pill pill-run';
  if (s === 'failed') return 'pill pill-fail';
  return 'pill';
});

const statusText = computed(() => {
  const s = props.session.status;
  if (!s) return '';
  return STATUS_TEXT[s] || s;
});
</script>

<template>
  <li>
    <button type="button" class="task-row" @click="emit('open', session)">
      <span class="task-marker" />
      <span class="task-body">
        <span class="task-title" :title="title">{{ title }}</span>
        <span class="task-time">
          <span>{{ time }}</span>
          <!-- 实时运行中覆盖快照状态显示 -->
          <span v-if="liveRunning" class="pill pill-run" title="正在产出"><span class="live-dot" />运行中</span>
          <!-- 「已完成」是唯一有结论的状态，配实心绿徽章 -->
          <span v-else-if="session.status === 'completed'" class="badge">
            <span v-html="SVG_CHECK_BADGE" />
            <span>{{ statusText }}</span>
          </span>
          <span v-else-if="session.status" :class="statusClass">{{ statusText }}</span>
          <span v-if="session.agentMode" class="pill">{{ session.agentMode }}</span>
        </span>
      </span>
    </button>
  </li>
</template>
