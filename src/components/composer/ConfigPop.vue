<script setup lang="ts">
/**
 * 配置选择面板（权限模式 / 模型 / 思考程度共用）。
 *
 * 三个面板都由 Kiro 下发的 select 型配置驱动（options[{value,name,description}]
 * + currentValue），因此共用一套渲染，差别只在面板宽度与项的高度（由 CSS 类决定）。
 *
 * 选中项不换背景，只在右侧放一个对勾 —— 与原实现一致。
 */
import { onMounted, ref } from 'vue';
import type { ConfigOption, ConfigOptionItem } from '../../protocol/types';
import { PERM_ICON, SVG_CHECK } from '../../assets/icons';

const props = defineProps<{
  option: ConfigOption;
  /** 列表项 class（pop-item-mode / pop-item-model / pop-item-thought），决定项高与排版。 */
  itemClass: string;
  /** 面板自身 class（pop-mode / pop-model / pop-thought），决定宽度与弹出方向。 */
  panelClass: string;
  /** 权限项渲染「标题 + 说明」两行并带图标；其余单行。 */
  labelRender?: boolean;
  /** effortLevel 用 listbox/option 语义，其余用 menuitemradio。 */
  useOption?: boolean;
}>();

const emit = defineEmits<{
  (e: 'choose', value: string, name: string): void;
  (e: 'close'): void;
}>();

const root = ref<HTMLElement | null>(null);
const items: ConfigOptionItem[] = ((props.option.options as ConfigOptionItem[]) ?? []).slice();

function itemEls(): HTMLButtonElement[] {
  const root0 = root.value;
  if (!root0) return [];
  return Array.from(root0.querySelectorAll<HTMLButtonElement>('.pop-item'));
}

function focusAt(index: number): void {
  const els = itemEls();
  if (!els.length) return;
  const i = Math.max(0, Math.min(index, els.length - 1));
  els[i].focus();
}

/** 当前项常在列表下方（模型十余项）。不滚过去的话，打开面板看到的是一屏无关选项。 */
function focusCurrent(): void {
  const els = itemEls();
  const idx = els.findIndex((el) => el.dataset.value === props.option.currentValue);
  const target = idx >= 0 ? els[idx] : els[0];
  target?.scrollIntoView({ block: 'nearest' });
  target?.focus();
}

onMounted(() => {
  focusCurrent();
});

/**
 * 键盘模型：面板已声明 menu/listbox 角色，必须支持箭头键导航，
 * 否则鼠标和键盘的可用性不一致（Escape 由触发按钮所在容器处理）。
 */
function onKeydown(e: KeyboardEvent): void {
  const els = itemEls();
  if (!els.length) {
    if (e.key === 'Escape') emit('close');
    return;
  }
  const cur = els.indexOf(document.activeElement as HTMLButtonElement);
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusAt(cur < 0 ? 0 : cur + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      focusAt(cur < 0 ? els.length - 1 : cur - 1);
      break;
    case 'Home':
      e.preventDefault();
      focusAt(0);
      break;
    case 'End':
      e.preventDefault();
      focusAt(els.length - 1);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      emit('close');
      break;
    default:
      // Enter/Space 交给原生按钮的点击行为
      break;
  }
}
</script>

<template>
  <div
    ref="root"
    class="pop show"
    :class="panelClass"
    :role="useOption ? 'listbox' : 'menu'"
    @click.stop
    @keydown="onKeydown"
  >
    <button
      v-for="o in items"
      :key="o.value"
      type="button"
      class="pop-item"
      :class="itemClass"
      :data-value="o.value"
      :role="useOption ? 'option' : 'menuitemradio'"
      :aria-selected="useOption ? o.value === option.currentValue : undefined"
      :aria-checked="!useOption ? o.value === option.currentValue : undefined"
      @click="emit('choose', o.value, o.name || o.value)"
    >
      <span
        v-if="itemClass === 'pop-item-mode'"
        style="flex: 0 0 auto; display: block; margin-top: 2px"
        v-html="PERM_ICON[o.value] || ''"
      />
      <span v-if="labelRender" class="col">
        <span>{{ o.name || o.value }}</span>
        <span v-if="o.description" class="desc">{{ o.description }}</span>
      </span>
      <span v-else class="lbl">{{ o.name || o.value }}</span>
      <span v-if="o.value === option.currentValue" class="tick" v-html="SVG_CHECK" />
    </button>
  </div>
</template>
