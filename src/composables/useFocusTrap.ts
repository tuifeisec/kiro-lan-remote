/**
 * 弹层焦点管理。
 *
 * 两个弹层（权限确认、新建会话）都是 `aria-modal="true"` 的模态层，
 * 但都只挂载一次、由外部状态控制显隐，因此焦点必须在**开关变化**时管理，
 * 而不是在 onMounted 里做一次。
 *
 * 契约：
 *   - 打开：记录打开前的焦点 → 把焦点移进弹层 → Tab/Shift+Tab 在层内循环；
 *   - 关闭：把焦点还给打开它的那个元素（除非它已不在文档里）；
 *   - 卸载：移除监听，避免遗留闭包。
 *
 * 不做的事：不改动 Escape 语义（由各弹层自己决定能否关闭）。
 */
import { nextTick, onUnmounted, watch, type Ref } from 'vue';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(isOpen: Ref<boolean>, container: Ref<HTMLElement | null>) {
  let lastActive: HTMLElement | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFocusTimer(): void {
    if (focusTimer !== null) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
  }

  function focusables(): HTMLElement[] {
    const root = container.value;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) {
      // 层内没有可聚焦元素时，把焦点留在弹层容器上，不让它落到遮罩后面
      e.preventDefault();
      container.value?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !container.value?.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function detach(): void {
    clearFocusTimer();
    document.removeEventListener('keydown', onKeydown, true);
  }

  watch(isOpen, async (open) => {
    if (open) {
      lastActive = (document.activeElement as HTMLElement | null) ?? null;
      await nextTick();
      // 等过渡/渲染稳定后再聚焦，避免聚焦到尚未布局完成的节点。
      // 定时器必须在关闭/卸载时清掉：否则 60ms 内被关掉的弹层
      // 仍会执行并抢走焦点（此时元素可能已不可见）。
      clearFocusTimer();
      focusTimer = setTimeout(() => {
        focusTimer = null;
        if (!isOpen.value) return;
        const items = focusables();
        (items[0] ?? container.value)?.focus();
      }, 60);
      document.addEventListener('keydown', onKeydown, true);
      return;
    }
    detach();
    const target = lastActive;
    lastActive = null;
    if (target && document.contains(target)) target.focus();
  });

  onUnmounted(detach);
}
