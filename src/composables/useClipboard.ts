/**
 * 剪贴板写入。
 * 迁移自 public/index.html 的 copyText。
 *
 * 必须保留 execCommand 回退：本应用通过局域网 http 访问，
 * `navigator.clipboard` 在非安全上下文（非 https/localhost）下不可用，
 * 没有回退就等于「复制」按钮完全失效。
 */

import { useUiStore } from '../stores/ui.ts';

export function useClipboard() {
  const ui = useUiStore();

  function fallbackCopy(text: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      ui.showToast('已复制');
    } catch {
      ui.showToast('复制失败，请手动选择');
    }
    ta.remove();
  }

  function copyText(raw: string): void {
    const text = (raw || '').trim();
    if (!text) return; // 空文本静默返回，不打扰用户

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => ui.showToast('已复制'))
        .catch(() => fallbackCopy(text));
      return;
    }
    fallbackCopy(text);
  }

  return { copyText };
}
