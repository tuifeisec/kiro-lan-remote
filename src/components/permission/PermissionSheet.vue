<script setup lang="ts">
/**
 * 权限确认面板（底部优先，移动端为 sheet）。
 *
 * 不可违背的契约：
 *   - 「暂不处理（交由电脑端决定）」必须保留 —— 弹层是全屏遮罩，
 *     若只能允许/拒绝，用户想回到电脑上处理时会被困在遮罩里；
 *   - 关闭弹层**不等于**拒绝或允许：没有遮罩关闭、Escape 被拦截；
 *   - 权限帧不带参数，需要回查同一 toolCallId 的 tool-call 事件的 rawInput，
 *     否则界面上只剩「Write File」四个字，用户无从判断该不该放行；
 *   - 入参一律用文本渲染，禁止当 HTML 插入。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useApp } from '../../app/bootstrap.ts';
import { PERM_TEXT, inputFields } from '../../domain/toolModel';
import { useFocusTrap } from '../../composables/useFocusTrap';

const app = useApp();
const { permission, conversation } = app;

const sheetEl = ref<HTMLElement | null>(null);

// 弹层是 aria-modal，焦点必须留在层内；打开时进入、关闭时还给触发元素
useFocusTrap(computed(() => permission.isOpen), sheetEl);

const cur = computed(() => permission.current);
const tool = computed(() => cur.value?.toolCall ?? {});

const title = computed(() => tool.value.title || tool.value.toolCallId || '未知操作');

/**
 * 权限帧自带 rawInput（若有）；否则回查 conversation 的 toolInputs 缓存。
 */
const rawInput = computed(() => {
  const t = tool.value;
  if (t.rawInput !== undefined) return t.rawInput;
  const id = t.toolCallId;
  return id ? conversation.state.toolInputs.get(id) : undefined;
});

const fields = computed(() => inputFields(rawInput.value));

/** rawInput 存在但提不出字段时，回退展示原始内容（截断到 1500 字符）。 */
const rawText = computed(() => {
  if (rawInput.value === undefined || fields.value.length) return '';
  const s =
    typeof rawInput.value === 'string' ? rawInput.value : JSON.stringify(rawInput.value, null, 2);
  return s.length > 1500 ? s.slice(0, 1500) + '\n…（已截断）' : s;
});

/** 选项按 kind 上色：放行分两级，拒绝为危险色。 */
function optionClass(kind: string | undefined): string {
  const k = kind || '';
  if (k === 'allow_once') return 'opt opt-allow';
  if (k === 'allow_always') return 'opt opt-allow-soft';
  if (k.indexOf('allow') === 0) return 'opt opt-allow';
  if (k.indexOf('reject') === 0 || k.indexOf('deny') === 0) return 'opt opt-deny';
  return 'opt';
}

function optionText(kind: string | undefined, name: string | undefined, optionId: string): string {
  return (kind && PERM_TEXT[kind]) || name || optionId;
}

function answer(optionId: string): void {
  if (permission.isResolving) return;
  void app.resolvePermission(optionId);
}

/** 「暂不处理」：optionId = null，协议层等价于「无决策、保持静默」，不是拒绝。 */
function defer(): void {
  if (permission.isResolving) return;
  void app.resolvePermission(null);
}

// Escape 不关闭权限弹层（避免误触变成隐式决策）
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && permission.isOpen) e.preventDefault();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div class="sheet" :class="{ show: permission.isOpen }" role="dialog" aria-modal="true" aria-labelledby="perm-sheet-title">
    <div ref="sheetEl" class="sheet-panel" tabindex="-1" :aria-busy="permission.isResolving ? 'true' : 'false'">
      <h3 class="sheet-title" id="perm-sheet-title">Kiro 请求执行操作</h3>
      <div class="sheet-desc">请确认是否允许。拒绝不会中断会话，但该步骤会被跳过。</div>

      <div class="sheet-box">
        <!-- 请求归属会话的标题：多会话等待时用户需要知道是哪个会话在请求；缺失不占位 -->
        <div v-if="cur?.sessionTitle" class="sheet-session">会话：{{ cur.sessionTitle }}</div>
        <div><b>{{ title }}</b></div>
        <div v-for="(f, i) in fields" :key="i" class="k">{{ f.label }}：{{ f.value }}</div>
        <pre v-if="rawText">{{ rawText }}</pre>
        <div v-if="tool.kind" class="k">类型：{{ tool.kind }}</div>
      </div>

      <div class="opts">
        <button
          v-for="o in cur?.options ?? []"
          :key="o.optionId"
          type="button"
          :class="optionClass(o.kind)"
          :disabled="permission.isResolving"
          @click="answer(o.optionId)"
        >
          {{ optionText(o.kind, o.name, o.optionId) }}
        </button>
        <button type="button" class="opt opt-ghost" :disabled="permission.isResolving" @click="defer">暂不处理（交由电脑端决定）</button>
        <!-- 提交中必须给出明确状态，不能只靠按钮变灰让用户猜 -->
        <div v-if="permission.isResolving" class="opt-status" role="status">
          <span class="spin" /> 正在提交决定…
        </div>
      </div>
    </div>
  </div>
</template>
