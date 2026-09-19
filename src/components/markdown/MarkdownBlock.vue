<script setup lang="ts">
/**
 * Markdown 渲染块。
 *
 * 安全边界：模型原文必须经 utils/markdown.ts 转义后才可 v-html，
 * 禁止直接对 `raw` 使用 v-html。
 *
 * 流式性能：用 rAF 合帧 + 仅在本块内容变化时重渲染。
 * 代码块横向滚动位置在重渲染前后按索引恢复 —— 否则每次增量都会把
 * 用户拖到一半的代码块弹回最左。
 */
import { onUnmounted, ref, watch } from 'vue';
import { renderMarkdown } from '../../utils/markdown';
import { useClipboard } from '../../composables/useClipboard';

const props = defineProps<{
  /** 原始 markdown 文本（未转义）。 */
  raw: string;
}>();

const { copyText } = useClipboard();

/** 代码块复制按钮的事件委托。 */
function onCopyClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('[data-copy]');
  if (!btn) return;
  const pre = btn.closest('.md-codeblock')?.querySelector('pre');
  if (pre) copyText(pre.textContent ?? '');
}

const el = ref<HTMLElement | null>(null);
const html = ref('');
let rafId: number | null = null;
let restoreRafId: number | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;
let pendingScrollLeft: number[] | null = null;

const STREAM_RENDER_DELAY_MS = 72;

/**
 * 只在一次批处理开始时读取代码块位置，避免每个流式 chunk 都触发布局查询。
 * 位置按代码块索引保存，和原实现保持一致。
 */
function captureCodeScroll(): void {
  if (pendingScrollLeft !== null) return;
  const target = el.value;
  if (!target) {
    pendingScrollLeft = [];
    return;
  }
  const pres = target.querySelectorAll<HTMLElement>('.md-pre');
  pendingScrollLeft = pres.length ? Array.from(pres, (p) => p.scrollLeft) : [];
}

function restoreCodeScroll(): void {
  restoreRafId = null;
  const pos = pendingScrollLeft;
  pendingScrollLeft = null;
  if (!pos?.length) return;
  const next = el.value?.querySelectorAll<HTMLElement>('.md-pre');
  if (!next?.length) return;
  for (let i = 0; i < pos.length && i < next.length; i++) next[i].scrollLeft = pos[i];
}

function render(): void {
  rafId = null;
  html.value = renderMarkdown(props.raw);
  if (pendingScrollLeft?.length && restoreRafId === null) {
    // 等 Vue 用新 html 完成 DOM patch 后再恢复横向位置。
    restoreRafId = requestAnimationFrame(restoreCodeScroll);
  } else {
    pendingScrollLeft = null;
  }
}

function scheduleRender(immediate = false): void {
  if (immediate) {
    if (streamTimer !== null) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    if (rafId === null) rafId = requestAnimationFrame(render);
    return;
  }
  if (rafId !== null || streamTimer !== null) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    if (rafId === null) rafId = requestAnimationFrame(render);
  }, STREAM_RENDER_DELAY_MS);
}

// 流式期间按时间窗口合并更新；首帧立即进入渲染队列，避免历史内容长时间空白。
watch(
  () => props.raw,
  (_raw, oldRaw) => {
    captureCodeScroll();
    scheduleRender(oldRaw === undefined);
  },
  { immediate: true }
);

onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (restoreRafId !== null) cancelAnimationFrame(restoreRafId);
  if (streamTimer !== null) clearTimeout(streamTimer);
  rafId = null;
  restoreRafId = null;
  streamTimer = null;
  pendingScrollLeft = null;
});

/**
 * 暴露给父组件用于「复制」取纯文本。
 *
 * 必须是**函数**而不是 computed：innerText 不是响应式数据，包进 computed
 * 只会在首次求值后永久缓存 —— 流式回答后续内容进不来，复制到的是旧文本。
 * 原实现也是在点击时才读取（`mds[last].innerText`）。
 */
defineExpose({
  getText: (): string => el.value?.innerText ?? '',
});
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- html 来自 renderMarkdown，已转义 -->
  <div ref="el" class="md" v-html="html" @click="onCopyClick" />
</template>
