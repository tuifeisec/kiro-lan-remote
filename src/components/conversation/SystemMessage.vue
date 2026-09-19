<script setup lang="ts">
/**
 * 回合外的系统提示（载入中、错误、权限超时等）。
 *
 * 用插值渲染 —— 提示文本包含来自服务端的错误消息，不得当作 HTML。
 */
import type { SystemBlock } from '../../domain/messageModel.ts';

defineProps<{ block: SystemBlock }>();
</script>

<template>
  <!-- stream-in：实时新增提示淡入；回放历史不播（原实现 addMsg 的 animateLive 判据）。
       错误提示必须以 alert 通知辅助技术；普通提示只在轮询语义下播报。 -->
  <div
    class="msg"
    :class="[block.level, { 'stream-in': !block.replay }]"
    :role="block.level === 'err' ? 'alert' : 'status'"
  >{{ block.text }}</div>
</template>
