<script setup lang="ts">
/**
 * 用户消息：右对齐低对比度气泡 + 右上角复制按钮。
 *
 * 文字用插值渲染（等价于原实现的 textContent）—— 用户输入不经过 markdown，
 * 因此不存在 HTML 注入面。
 */
import type { UserMessageBlock } from '../../domain/messageModel.ts';
import { ICON_COPY } from '../../assets/icons';
import { useClipboard } from '../../composables/useClipboard';

const props = defineProps<{
  message: UserMessageBlock;
  /** 是否播放流式淡入。回放历史不播（原实现 addUserMsg 的 animateLive 判据）。 */
  streamIn?: boolean;
}>();
const { copyText } = useClipboard();
</script>

<template>
  <div class="user-row" :class="{ 'stream-in': streamIn }">
    <div class="user-bubble" :class="{ 'stream-in': streamIn }">{{ message.text }}</div>
    <div class="user-tools">
      <button
        type="button"
        class="msg-icon-btn"
        title="复制"
        aria-label="复制"
        @click="copyText(props.message.text)"
      >
        <span v-html="ICON_COPY" />
      </button>
    </div>
  </div>
</template>
