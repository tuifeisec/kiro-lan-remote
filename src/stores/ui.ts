/**
 * UI store：视图切换、toast、弹层开关等纯界面状态。
 *
 * 这里**不放业务状态**：会话内容在 conversation store，
 * 权限在 permission store，配置在 config store。
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ViewName = 'sessions' | 'chat';

/** 连接状态点：on=已连接 / wait=连接中 / err=异常 / off=未连接。 */
export type DotState = 'on' | 'wait' | 'err' | 'off';

/** composer 里可展开的配置面板。 */
export type PopId = 'autopilot' | 'model' | 'effortLevel';

export const useUiStore = defineStore('ui', () => {
  const view = ref<ViewName>('sessions');
  const dot = ref<DotState>('off');
  /** 由 status.lastError 驱动的错误横幅文案；null 表示恢复安全提示。 */
  const connError = ref<string | null>(null);

  const toastText = ref('');
  const toastVisible = ref(false);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** 新建会话的工作目录弹层。 */
  const cwdSheetOpen = ref(false);
  const cwdInput = ref('');

  /**
   * 当前展开的 composer 配置面板。
   * 放在 store 而非组件内，是为了让 Escape 的优先级链（面板 → 权限 →
   * 目录弹层 → 返回列表）在一处可见 —— 与原实现的模块级 popKey 对应。
   */
  const popOpen = ref<PopId | null>(null);

  /** 用户是否正在上翻阅读历史（离开底部时新事件不强制拉底）。 */
  const jumpVisible = ref(false);

  function showToast(text: string): void {
    toastText.value = text;
    toastVisible.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastVisible.value = false;
      toastTimer = null;
    }, 2200);
  }

  function setView(v: ViewName): void {
    view.value = v;
  }

  function setDot(d: DotState): void {
    dot.value = d;
  }

  function togglePop(id: PopId): void {
    popOpen.value = popOpen.value === id ? null : id;
  }

  function closePop(): void {
    popOpen.value = null;
  }

  return {
    view,
    dot,
    connError,
    toastText,
    toastVisible,
    cwdSheetOpen,
    cwdInput,
    popOpen,
    jumpVisible,
    showToast,
    setView,
    setDot,
    togglePop,
    closePop,
  };
});
