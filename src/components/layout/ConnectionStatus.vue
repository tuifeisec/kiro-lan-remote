<script setup lang="ts">
/**
 * 连接状态点。列表页与会话页各有一个，共用同一状态源。
 */
const props = defineProps<{ state: 'on' | 'wait' | 'err' | 'off' }>();

const LABELS = {
  on: '已连接',
  wait: '连接中',
  err: '连接异常',
  off: '未连接',
} as const;
</script>

<template>
  <span
    class="connection-status"
    :class="{ attention: props.state === 'err' || props.state === 'off' }"
    role="status"
    :aria-label="LABELS[props.state]"
  >
    <span
      class="dot"
      :class="props.state === 'on' ? 'on' : props.state === 'wait' ? 'wait' : props.state === 'err' ? 'err' : ''"
      aria-hidden="true"
    />
    <span class="connection-status-label">{{ LABELS[props.state] }}</span>
  </span>
</template>
