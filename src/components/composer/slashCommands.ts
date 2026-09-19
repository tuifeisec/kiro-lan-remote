/**
 * 斜杠命令菜单的数据模型（纯函数）。
 *
 * 协议层的 commands 数组元素形态未定：可能是字符串，
 * 也可能是 { name | command | value, description? } 形状的对象。
 * 这里统一归一化为 { name, description }，组件层不再做防御。
 */

export interface SlashCommand {
  name: string;
  /** 服务端带来的说明；缺失为 null（界面不占位）。 */
  description: string | null;
}

const firstString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** 单个命令元素 → 归一化形态；无可用名称时返回 null（渲染层跳过）。 */
export function normalizeCommand(raw: unknown): SlashCommand | null {
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s ? { name: s, description: null } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const description = firstString(o.description);
  for (const key of ['name', 'command', 'value'] as const) {
    const name = firstString(o[key]);
    if (name) return { name, description };
  }
  return null;
}

/** 批量归一化 + 按名称去重（重复 key 会让 Vue 列表告警，也纯粹是噪声）。 */
export function normalizeCommands(raw: unknown[]): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const item of raw) {
    const c = normalizeCommand(item);
    if (!c || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

/**
 * 按草稿前缀过滤命令。
 * 草稿不以 '/' 开头时返回空数组（菜单只在斜杠场景出现）；
 * '/' 后的查询词按大小写不敏感的前缀匹配。
 * 命令名可能自带 '/' 前缀（如 '/plan'），匹配前先剥掉，两种数据形态都可用。
 */
export function filterSlashCommands(raw: unknown[], draft: string): SlashCommand[] {
  if (!draft.startsWith('/')) return [];
  const query = draft.slice(1).trimStart().toLowerCase();
  return normalizeCommands(raw).filter((c) => c.name.replace(/^\//, '').toLowerCase().startsWith(query));
}
