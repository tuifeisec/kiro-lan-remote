<script setup lang="ts">
/**
 * 斜杠命令菜单：composer 输入 '/' 时在输入框上方弹出的选项列表。
 *
 * 只负责渲染与选择上报：过滤、键盘导航、插入逻辑都在 Composer
 * （菜单的显隐依赖输入框草稿，状态必须留在草稿的持有者那里）。
 * 选中项不换背景，用 active 类 + aria-selected 表达（与 ConfigPop 一致）。
 */
import type { SlashCommand } from './slashCommands';

defineProps<{
  /** 过滤后的命令项（已归一化）。 */
  items: SlashCommand[];
  /** 键盘当前高亮的下标。 */
  activeIndex: number;
}>();

const emit = defineEmits<{ (e: 'choose', name: string): void }>();
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="斜杠命令">
    <button
      v-for="(c, i) in items"
      :key="c.name"
      type="button"
      class="slash-item"
      :class="{ active: i === activeIndex }"
      role="option"
      :aria-selected="i === activeIndex ? 'true' : 'false'"
      @click="emit('choose', c.name)"
    >
      <span class="slash-name">{{ c.name }}</span>
      <span v-if="c.description" class="slash-desc">{{ c.description }}</span>
    </button>
  </div>
</template>
