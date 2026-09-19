<script setup lang="ts">
/**
 * 全局 toast。单例、短暂、不过度抢焦点。
 *
 * 注意：toast 不用于承载正文错误、权限状态或取消状态 ——
 * 那些必须落在对话流里（SystemMessage / 回合状态），否则会被用户错过。
 */
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
</script>

<template>
  <div class="toast" :class="{ show: ui.toastVisible }" role="status">{{ ui.toastText }}</div>
</template>
