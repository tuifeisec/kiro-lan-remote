<script setup lang="ts">
/**
 * 应用根组件。
 *
 * 只做四件事：
 *   1. 读取 URL 的 key 并启动连接（启动顺序在这里显式定义）；
 *   2. 组合两个视图（列表页 / 会话页）与全局覆盖层（toast、权限面板、目录弹层）；
 *   3. 桌面（≥960px）切换为双栏外壳：左侧栏（列表紧凑变体）+ 右侧常驻主区；
 *      <960px 保持原有 ui.view 单列切换；
 *   4. 承载不属于任何视图的全局键盘处理。
 *
 * 业务动作全部来自 app（bootstrap），组件自身不直接发送 WebSocket 命令。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useApp } from './app/bootstrap.ts';
import { useFocusTrap } from './composables/useFocusTrap';
import SessionListView from './components/sessions/SessionListView.vue';
import ConversationView from './components/conversation/ConversationView.vue';
import PermissionSheet from './components/permission/PermissionSheet.vue';
import ToastHost from './components/layout/ToastHost.vue';

const app = useApp();
const { ui } = app;

/**
 * 桌面双栏断点（≥960px，官方 991px 实测双栏、移动单列的本地落点）。
 * setup 内同步求值（SSR 环境无 window 时恒为单列），变化监听挂载后注册、
 * 卸载时清理，避免泄漏。
 */
const isDesktop = ref(
  typeof window !== 'undefined' && window.matchMedia('(min-width: 960px)').matches
);

let mq: MediaQueryList | null = null;
function onMqChange(e: MediaQueryListEvent): void {
  isDesktop.value = e.matches;
}

/** 访问密钥来自 URL 查询参数；页面本身不含数据，鉴权发生在 WebSocket 握手阶段。 */
const key = new URLSearchParams(location.search).get('key') || '';

const cwdInput = ref<HTMLInputElement | null>(null);
const cwdPanel = ref<HTMLElement | null>(null);

const cwdSheetVisible = computed(() => ui.cwdSheetOpen);

// 模态弹层：焦点进入层内、Tab 循环、关闭后还给「新建会话」按钮
useFocusTrap(cwdSheetVisible, cwdPanel);

function confirmCwd(): void {
  const value = ui.cwdInput.trim();
  ui.cwdSheetOpen = false;
  void app.createSession(value);
}

function cancelCwd(): void {
  ui.cwdSheetOpen = false;
}

/** Escape 取消新建目录弹层（等同点取消按钮，不代答任何决策）。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui.cwdSheetOpen) cancelCwd();
}

watch(cwdSheetVisible, (v) => {
  if (!v) return;
  // 打开后把光标放到已有内容的末尾（焦点由 useFocusTrap 负责移入）
  setTimeout(() => {
    const el = cwdInput.value;
    if (!el) return;
    el.setSelectionRange(el.value.length, el.value.length);
  }, 60);
});

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  mq = window.matchMedia('(min-width: 960px)');
  isDesktop.value = mq.matches;
  mq.addEventListener('change', onMqChange);
  // 启动顺序：先注册订阅与重连处理，再建连接（start 内部保证该顺序）
  app.start(key);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  if (mq) mq.removeEventListener('change', onMqChange);
  mq = null;
});
</script>

<template>
  <!-- 桌面双栏：左侧栏常驻，右侧对话主区常驻（view 切换逻辑由 compact/embedded 接管） -->
  <div v-if="isDesktop" class="app shell-split">
    <aside class="shell-side">
      <SessionListView compact />
    </aside>
    <main class="shell-main">
      <ConversationView embedded />
    </main>
  </div>

  <!-- 移动/窄视口：保持原有单列切换 -->
  <template v-else>
    <SessionListView />
    <ConversationView />
  </template>

  <!-- 权限面板与会话页无关：它由服务端决定何时弹出 -->
  <PermissionSheet />

  <!-- 新建会话的工作目录 -->
  <div
    class="sheet"
    :class="{ show: cwdSheetVisible }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cwd-sheet-title"
    @click.self="cancelCwd"
  >
    <div ref="cwdPanel" class="sheet-panel" tabindex="-1">
      <h3 class="sheet-title" id="cwd-sheet-title">新建会话</h3>
      <div class="sheet-desc">指定 agent 的工作目录。留空则使用 Kiro 的默认工作区。</div>
      <input
        ref="cwdInput"
        v-model="ui.cwdInput"
        class="field"
        type="text"
        aria-labelledby="cwd-sheet-title"
        placeholder="d:\项目\路径"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        @keydown.enter="confirmCwd"
      >
      <div class="opts">
        <button class="opt opt-allow" type="button" @click="confirmCwd">创建会话</button>
        <button class="opt opt-ghost" type="button" @click="cancelCwd">取消</button>
      </div>
    </div>
  </div>

  <ToastHost />
</template>
