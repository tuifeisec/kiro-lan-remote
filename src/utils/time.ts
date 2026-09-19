/**
 * 时间格式化。
 * 迁移自 public/index.html 的 fmtTime / fmtDuration，行为保持一致。
 */

/**
 * 会话时间戳：今天只给 HH:MM，更早给 M/D HH:MM。
 *
 * 与迁移前唯一的行为差异：非法日期返回空串而不是 "NaN/NaN NaN:NaN"。
 * `updatedAt` 由 Kiro 下发，格式不受本项目控制，这里不信任它的可解析性。
 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hh;
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hh;
}

/**
 * 列表用相对时间（对齐官方：刚刚 / 2分钟 / 2小时 / 3天）。
 *
 * 阈值：<60s 刚刚、<60m N分钟、<24h N小时、<7d N天，更早回退 fmtTime
 * 的日期格式（今天 HH:MM，更早 M/D HH:MM）。
 * 输入不可解析或在未来（时钟偏差）按「刚刚」处理，不显示负数。
 */
export function formatRelative(input: string | number | null | undefined): string {
  if (input == null || input === '') return '';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(t)) return '';

  const diff = Math.max(0, Date.now() - t);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + '分钟';

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '小时';

  const days = Math.floor(hours / 24);
  if (days < 7) return days + '天';

  return fmtTime(new Date(t).toISOString());
}

/**
 * 时长文案（对齐官方「已工作 20 秒 / 2 分 49 秒 / 2 时 14 分」的措辞）。
 * 不足 1 秒显示「不足 1 秒」，不显示误导性的「0 秒」；负数与异常区间一律夹到 0。
 */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return '不足 1 秒';
  if (s < 60) return s + ' 秒';

  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return m + ' 分 ' + rest + ' 秒';

  const h = Math.floor(m / 60);
  return h + ' 时 ' + (m % 60) + ' 分';
}
