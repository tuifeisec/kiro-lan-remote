<script setup lang="ts">
/**
 * 回复下方的操作条：复制 + 绝对时间。
 *
 * 赞/踩/分叉占位按钮已按用户要求移除（2026-09-19）——对 Kiro 数据源
 * 没有对应的业务能力，留着只会占视线。时间只对实时回合诚实可得
 * （回放回合为 null，不显示），保持绝对格式。
 */
import { computed } from 'vue';
import type { Turn } from '../../domain/messageModel.ts';
import { fmtTime } from '../../utils/time';
import { ICON_COPY } from '../../assets/icons';
import { useClipboard } from '../../composables/useClipboard';

const props = defineProps<{
  turn: Turn;
  /** 取本回合最终回答的渲染后纯文本（点击时才求值）。 */
  getAnswerText: () => string;
}>();
const { copyText } = useClipboard();

/** 复制最终回答：取渲染后的纯文本，等价于原实现取 `.assistant .md` 的 innerText。 */
function copyAnswer(): void {
  copyText(props.getAnswerText());
}

const timeText = computed(() => (props.turn.actionTime ? fmtTime(props.turn.actionTime) : ''));
</script>

<template>
  <div class="action-bar">
    <button
      type="button"
      class="msg-icon-btn"
      title="复制回答"
      aria-label="复制回答"
      @click="copyAnswer"
    >
      <span v-html="ICON_COPY" />
    </button>
    <span v-if="timeText" class="action-time">{{ timeText }}</span>
  </div>
</template>
