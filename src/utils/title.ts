/**
 * 会话标题清洗。
 * 迁移自 public/index.html 的 cleanTitle，行为保持一致。
 */

/** 会话标题为空时，Kiro 会下发表单形态的 JSON（如 {"chat":0}）。 */
const PLACEHOLDER_KEYS = /^(chat|do|spec|vibe|count)$/;

export function cleanTitle(session: { title?: string | null } | null | undefined): string {
  const t = (session?.title || '').trim();
  if (!t) return '(未命名会话)';

  if (/^\s*\{.*\}\s*$/.test(t)) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const known = Object.keys(o).every((k) => PLACEHOLDER_KEYS.test(k));
      if (known) return '(未命名会话)';
    } catch {
      // 不是合法 JSON，按普通标题处理
    }
  }

  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
