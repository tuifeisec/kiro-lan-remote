/**
 * 工具调用行模型（纯函数）。
 * 迁移自 public/index.html 的 toolOp / inputFields / clip / toolCls / TOOL_KIND。
 *
 * 设计约束：这里只产出**可渲染的数据**，不产出 HTML。
 * 工具参数来自模型输出，必须由模板用 textContent 绑定渲染，
 * 禁止拼成 HTML 字符串（原实现用 textContent + pre 保证了这一点）。
 */

import { toolCls, TOOL_KIND, type ToolVisualState } from '../protocol/types.ts';

/** 命令类字段的候选键（顺序即优先级）。 */
const OP_CMD_KEYS = ['command', 'cmd'];

/** 文件类字段的候选键。 */
const OP_FILE_KEYS = ['path', 'filePath', 'file_path', 'target'];

/**
 * 工具名 / 代码类字段的候选键。
 * MCP 工具（如 fetch_cloud_config）的 rawInput 带 toolName；
 * 代码执行类（如 ctx_execute）带 code —— 取首个非空行做操作对象，
 * 否则这类工具只能渲染成无差别的「工具调用」安静行。
 */
const OP_NAME_KEYS = ['toolName'];
const OP_CODE_KEYS = ['code'];

/** code 首行作为操作对象时的截断上限（行内截断，与 CLIP_LIMIT 语义不同）。 */
const OP_CODE_LINE_LIMIT = 120;

/**
 * 字段 → 中文标签。
 * 只列「操作对象」相关字段，避免把全量参数铺开让「要放行什么」淹没在噪声里。
 */
export const INPUT_LABELS: Record<string, string> = {
  path: '路径',
  filePath: '路径',
  file_path: '路径',
  target: '目标',
  command: '命令',
  cwd: '工作目录',
  pattern: '模式',
  query: '查询',
  url: '网址',
  content: '内容',
  text: '内容',
  toolName: '工具',
  language: '语言',
  code: '代码',
};

/** 权限选项 kind → 中文。kind 已实测为 allow_once / allow_always / reject_once / reject_always。 */
export const PERM_TEXT: Record<string, string> = {
  allow_once: '允许本次',
  allow_always: '始终允许',
  reject_once: '拒绝本次',
  reject_always: '始终拒绝',
};

/** 单值截断上限，避免超长内容撑爆详情区与权限面板。 */
const CLIP_LIMIT = 300;

const strOf = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

function firstKey(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const s = strOf(obj[k]);
    if (s) return s;
  }
  return null;
}

/** 工具行的「操作对象」展示数据。 */
export type ToolOp =
  | { kind: 'cmd'; text: string }
  | { kind: 'file'; name: string; dir: string; full: string };

/**
 * 从工具参数里抽出「这一步在干什么」。
 *
 * 只认命令类与文件类字段是刻意的：否则协议内部字段会淹没真正的操作对象。
 * 取不到就返回 null —— 界面只显示标题 + 状态，不拼假信息。
 */
export function toolOp(raw: unknown): ToolOp | null {
  let o: unknown = raw;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== 'object') return null;

  const obj = o as Record<string, unknown>;

  const cmd = firstKey(obj, OP_CMD_KEYS);
  if (cmd) return { kind: 'cmd', text: cmd };

  const p = firstKey(obj, OP_FILE_KEYS);
  if (p) {
    const seg = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    const name = seg.pop() || p;
    const dir = seg.length ? seg.join('/') + '/' : '';
    return { kind: 'file', name, dir, full: p };
  }

  const tn = firstKey(obj, OP_NAME_KEYS);
  if (tn) return { kind: 'cmd', text: tn };

  const code = firstKey(obj, OP_CODE_KEYS);
  if (code) {
    const first = code
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? '';
    const text = first.length > OP_CODE_LINE_LIMIT ? first.slice(0, OP_CODE_LINE_LIMIT) + ' …' : first;
    return { kind: 'cmd', text };
  }

  const q = strOf(obj.query) || strOf(obj.pattern) || strOf(obj.url);
  return q ? { kind: 'cmd', text: q } : null;
}

/** 单值截断。 */
export function clip(v: unknown): string {
  const s = String(v);
  return s.length > CLIP_LIMIT ? s.slice(0, CLIP_LIMIT) + ' …（已截断）' : s;
}

export interface InputField {
  label: string;
  value: string;
}

/**
 * 从工具参数提取展示字段。
 * 下划线开头的键（如 _meta）一律跳过 —— 那是协议实现细节，不是操作对象。
 */
export function inputFields(raw: unknown): InputField[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object') return [{ label: '参数', value: clip(raw) }];

  const obj = raw as Record<string, unknown>;
  const out: InputField[] = [];
  const seen: Record<string, true> = {};

  for (const k of Object.keys(INPUT_LABELS)) {
    if (obj[k] === undefined || obj[k] === null) continue;
    seen[k] = true;
    out.push({ label: INPUT_LABELS[k], value: clip(obj[k]) });
  }

  for (const k of Object.keys(obj)) {
    if (seen[k] || k.charAt(0) === '_') continue;
    const v = obj[k];
    if (v === undefined || v === null || typeof v === 'object') continue;
    out.push({ label: k, value: clip(v) });
  }

  return out;
}

/**
 * 是否可展开详情。
 *
 * 判据用**原始 rawInput**（不是 toolOp 的结果）：raw = {foo:1} 提不出操作对象
 * 但仍是可展开按钮；raw = ''/null/undefined 才是安静行。
 */
export function isExpandable(raw: unknown): boolean {
  return !(raw === undefined || raw === null || raw === '');
}

/** 工具行标题：优先 Kiro 的 title，其次协议 kind 的中文名，最后通用兜底。 */
export function toolTitle(title: string | undefined, toolKind: string | undefined): string {
  return title || (toolKind && TOOL_KIND[toolKind]) || '工具调用';
}

export type { ToolVisualState };
export { toolCls };
