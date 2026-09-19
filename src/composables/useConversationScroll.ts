/**
 * 会话滚动控制。
 * 迁移自 public/index.html 的 nearBottom / updateJump / scrollBottom。
 *
 * 语义（产品契约，不可简化）：
 *   - 打开会话默认**贴底跟随最新内容**（对齐官方远程页）；
 *   - 用户上翻阅读历史时，新事件**不得**强制拉到底部；
 *   - 只有接近底部（阈值 8px）时才自动跟随；
 *   - 离开底部后显示「回到底部」按钮；点按钮 = 重新贴底跟随。
 *
 * 「跟随」的判据是 pinned 标志而不是单次 nearBottom：
 * 重放/流式期间内容高度不断增长，仅靠 scrollTop 判断会在内容
 * 插入的瞬间误判为「离开底部」。pinned 由用户滚动意图（滚轮/
 * 触摸/按下）解除，程序赋值 scrollTop 不触发这些事件，不会误解除。
 */

import { onUnmounted, ref, type Ref } from 'vue';

/** 贴底判定阈值：小于该距离视为「跟随中」。 */
const NEAR_BOTTOM_PX = 8;

export function useConversationScroll(scroller: Ref<HTMLElement | null>) {
  const jumpVisible = ref(false);
  const pinned = ref(true);
  /**
   * 已经绑过监听的那个 scroller 元素。
   *
   * 不能用一个 boolean 表示「绑过了」：桌面双栏下无活动会话时
   * `conv-scroller` 会被 v-else 卸载，再次进入会话拿到的是**新的** DOM 元素，
   * 用 boolean 判断会跳过重绑，导致该元素既没有滚动意图监听、也没有
   * ResizeObserver —— 表现为上翻被强制拉底、回到底部按钮不出现。
   */
  let boundEl: HTMLElement | null = null;
  let scrollRafId: number | null = null;
  let followRafId: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function scheduleScrollMeasure(): void {
    if (scrollRafId !== null) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      updateJump();
    });
  }

  function scheduleFollow(): void {
    if (!pinned.value || followRafId !== null) return;
    followRafId = requestAnimationFrame(() => {
      followRafId = null;
      scrollBottom(false);
    });
  }

  function nearBottom(): boolean {
    const el = scroller.value;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  function updateJump(): void {
    jumpVisible.value = !nearBottom();
  }

  function scrollBottom(force = false): void {
    const el = scroller.value;
    if (!el) return;
    if (force || pinned.value || nearBottom()) el.scrollTop = el.scrollHeight;
    updateJump();
  }

  /** 「回到底部」按钮：平滑滚动并恢复贴底跟随。 */
  function scrollToBottomSmooth(): void {
    const el = scroller.value;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinned.value = true;
    jumpVisible.value = false;
  }

  /**
   * 打开/切换会话：贴底跟随最新内容。
   * 重放与流式渲染会分多帧改变高度，这里只置 pinned，
   * 由内容变化 watcher 持续把视图按在底部。
   */
  function pinToLatest(): void {
    pinned.value = true;
    jumpVisible.value = false;
    scrollBottom(true);
  }

  /**
   * 绑定用户滚动意图监听：滚轮 / 触摸 / 鼠标按下（含滚动条拖拽）
   * 都视为主动离开底部。程序赋值 scrollTop 不触发这些事件。
   *
   * 幂等：同一元素重复调用直接返回；元素被替换（会话视图重建）时
   * 先解绑旧元素与旧 observer，再绑新元素。
   */
  function bindScrollIntent(): void {
    const el = scroller.value;
    if (!el || el === boundEl) return;
    unbindScrollIntent();
    boundEl = el;
    const detach = () => {
      pinned.value = false;
      scheduleScrollMeasure();
    };
    el.addEventListener('wheel', detach, { passive: true });
    el.addEventListener('touchstart', detach, { passive: true });
    el.addEventListener('pointerdown', detach);

    const content = el.querySelector<HTMLElement>('#msgs');
    if (content && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (pinned.value) scheduleFollow();
        else scheduleScrollMeasure();
      });
      resizeObserver.observe(content);
    }
  }

  /** 解绑当前元素上的监听与 observer（元素被替换或组件卸载时调用）。 */
  function unbindScrollIntent(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    boundEl = null;
  }

  onUnmounted(() => {
    if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
    if (followRafId !== null) cancelAnimationFrame(followRafId);
    unbindScrollIntent();
    scrollRafId = null;
    followRafId = null;
  });

  return {
    jumpVisible,
    pinned,
    nearBottom,
    updateJump,
    scheduleScrollMeasure,
    scrollBottom,
    scrollToBottomSmooth,
    pinToLatest,
    bindScrollIntent,
  };
}
