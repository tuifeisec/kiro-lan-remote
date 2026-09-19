<script setup lang="ts">
/**
 * 最终回答：展平在对话流里的正常正文列（**不复用用户气泡样式**）。
 * 这是与「工作过程」区分开的层级 —— 结论必须在折叠面板之外直接可见。
 */
import type { TextBlock } from '../../domain/messageModel.ts';
import { ref } from 'vue';
import MarkdownBlock from '../markdown/MarkdownBlock.vue';

defineProps<{ block: TextBlock }>();

const md = ref<InstanceType<typeof MarkdownBlock> | null>(null);

/**
 * 取渲染后的纯文本。
 *
 * 必须在**点击时**调用而不是包成 computed —— 原实现取的是 `.assistant .md`
 * 的 innerText，粘贴出来是可读正文；而 innerText 不是响应式数据，
 * 缓存会拿到流式早期的不完整内容。
 */
defineExpose({ getText: (): string => md.value?.getText() ?? '' });
</script>

<template>
  <!-- stream-in：实时结论淡入；回放历史不播（原实现 ensureAnswerWrap 的判据） -->
  <div class="assistant" :class="{ 'stream-in': !block.replay }">
    <MarkdownBlock ref="md" :raw="block.raw" />
  </div>
</template>
