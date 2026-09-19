/**
 * 流式文本的合帧刷新。
 * 迁移自 public/index.html 的 queueRender / flushAssistant。
 *
 * 每个 chunk 都整段重渲染 markdown 会在长回复里产生大量重复解析与布局，
 * 在手机上表现为滚动卡顿。这里把同一帧内的多个 chunk 合成一次渲染。
 *
 * 关键边界：
 *   - 工具状态、权限状态、回合完成事件**不经过**这里，它们必须立即反映；
 *   - 回合结束时调用 flush() 强制渲染，避免最后一批增量丢失；
 *   - 组件卸载时取消未执行的帧，避免对已卸载组件写入。
 */

import { onUnmounted, ref, type Ref } from 'vue';

export function useStreamFlush(render: () => void) {
  const pending = ref(false);
  let rafId: number | null = null;

  function flush(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pending.value = false;
    render();
  }

  function schedule(): void {
    if (pending.value) return;
    pending.value = true;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      pending.value = false;
      render();
    });
  }

  onUnmounted(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });

  return { pending, schedule, flush };
}

/**
 * 代码块横向滚动的保持。
 *
 * 重渲染会整体替换 innerHTML，使每个代码块的 scrollLeft 归零。
 * 按**索引**保存/恢复：流式追加代码块时，前 n 个块的索引是稳定的。
 */
export function withHScroll<T extends HTMLElement | null>(el: T, fn: () => void): void {
  const pres = el ? Array.from(el.querySelectorAll<HTMLElement>('.md-pre')) : [];
  const pos = pres.map((p) => p.scrollLeft);
  fn();
  if (!el) return;
  const next = Array.from(el.querySelectorAll<HTMLElement>('.md-pre'));
  for (let i = 0; i < pos.length && i < next.length; i++) next[i].scrollLeft = pos[i];
}

/** 供模板使用的只读 ref 类型别名。 */
export type ReadonlyRef<T> = Readonly<Ref<T>>;
