/**
 * 路径处理。
 * 迁移自 public/index.html 的 normCwd / wsName，行为保持一致。
 */

/**
 * 路径归一：统一分隔符、去尾部斜杠、转小写。
 * Windows 下 `d:\x` 与 `d:/x` 是同一目录，分组键必须把它们合并。
 */
export function normCwd(p: string | null | undefined): string {
  return (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 工作区显示名：取路径最后一段；无 cwd 时给占位。 */
export function wsName(cwd: string | null | undefined): string {
  if (!cwd) return '(未指定目录)';
  const t = cwd.replace(/[\\/]+$/, '');
  const parts = t.split(/[\\/]/);
  return parts[parts.length - 1] || t;
}

/**
 * 拆出文件名的所在目录，目录统一为正斜杠且带尾斜杠。
 * 迁移自 toolOp 中文件路径的展示逻辑。
 */
export function splitPath(p: string): { name: string; dir: string; full: string } {
  const seg = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  const name = seg.pop() || p;
  const dir = seg.length ? seg.join('/') + '/' : '';
  return { name, dir, full: p };
}
