/**
 * 安全 Markdown 渲染（纯函数，无 DOM 依赖）。
 *
 * 迁移自 public/index.html 的 escapeHtml / renderMarkdown / codeBlockHtml，
 * 算法与输出结构保持逐字节一致 —— test/md-render.test.mjs 的断言依赖这些结构。
 *
 * 安全边界（必须保持）：
 *   1. 先摘出代码块与行内代码，再对剩余文本整体 escapeHtml；
 *   2. 只在**已转义**的文本上做替换，因此模型输出无法注入标签；
 *   3. 链接只允许 http / https，杜绝 javascript: 等协议；
 *   4. 代码内容在最后一步重新转义还原。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 代码块复制按钮图标。与 assets/icons.ts 的 ICON_COPY 同源，这里内联以避免循环依赖。 */
const ICON_COPY =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

interface Fence {
  lang: string;
  code: string;
}

/**
 * 代码块 HTML：标题行（语言名 + 复制按钮）+ <pre>。
 * 不做语法高亮，只作标识 —— 避免引入高亮库。
 */
function codeBlockHtml(b: Fence | undefined): string {
  if (!b) return '';
  const lang = b.lang || '';
  // 信息串可能带属性（```js title="x"），标题行只显示第一个 token
  const name = lang.split(/\s+/)[0];
  return (
    '<div class="md-codeblock">' +
    '<div class="md-codeblock-bar">' +
    '<span class="md-codeblock-lang">' + escapeHtml(name) + '</span>' +
    '<button type="button" class="msg-icon-btn" data-copy title="复制代码" aria-label="复制代码">' +
    ICON_COPY +
    '</button>' +
    '</div>' +
    '<pre class="md-pre"><code>' + escapeHtml(b.code) + '</code></pre>' +
    '</div>'
  );
}

/** 列表节点（支持按缩进嵌套）。 */
interface ListNode {
  type: 'ul' | 'ol';
  indent: number;
  container: ListNode[];
  items: Array<{ text: string; subs: ListNode[] }>;
}

export function renderMarkdown(src: string): string {
  if (!src) return '';

  // 围栏代码块整块先摘出：块内的 # * | ` 都不属于 Markdown 语法。
  // 逐行扫描而不是用正则配对，是为了让**未闭合**的围栏也吃到最后一行 ——
  // 流式输出经常停在半个代码块上，若此时按普通文本渲染，围栏闭合的一刻
  // 整段内容会突然变形。
  src = src.replace(/\r\n?/g, '\n');
  const srcLines = src.split('\n');
  const blocks: Fence[] = [];
  const kept: string[] = [];

  for (let li = 0; li < srcLines.length; li++) {
    const open = srcLines[li].match(/^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/);
    // 信息串里再出现反引号说明这是行内代码（```x```），不是围栏
    if (!open || open[2].indexOf('`') >= 0) {
      kept.push(srcLines[li]);
      continue;
    }
    const buf: string[] = [];
    li++;
    for (; li < srcLines.length; li++) {
      const close = srcLines[li].match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
      // 闭合围栏必须同字符且不短于开启围栏：```` 包裹 ``` 的示例要能整体保留
      if (close && close[1].charAt(0) === open[1].charAt(0) && close[1].length >= open[1].length) break;
      buf.push(srcLines[li]);
    }
    // li 此刻指向闭合行（或已越界），外层循环自增后正好跳过它
    blocks.push({ lang: open[2].trim(), code: buf.join('\n') });
    kept.push('\u0000B' + (blocks.length - 1) + '\u0000');
  }
  let text = kept.join('\n');

  const inlines: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlines.push(code);
    return '\u0000I' + (inlines.length - 1) + '\u0000';
  });

  let out = escapeHtml(text);

  // 链接（仅 http/https，避免 javascript: 之类）
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  // 粗体
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // 块级分组：连续文本行并成一个段落（段内 <br>），连续列表项并成 ul/ol
  //（按缩进嵌套）、连续 > 行并成引用块、连续表格行并成 md-table-box；
  // 空行只作段落分隔，块间距交给 .md > * + * 的 16px 外边距。
  const lines = out.split('\n');
  let html = '';
  let para: string[] = [];
  let tableRows: string[][] | null = null;
  let quoteLines: string[] | null = null;
  let lroot: ListNode[] = [];
  let lstack: ListNode[] = [];

  const indentOf = (ws: string): number => ws.replace(/\t/g, '  ').length;

  function flushPara(): void {
    if (para.length) {
      html += '<div class="md-p">' + para.join('<br>') + '</div>';
      para = [];
    }
  }

  function flushQuote(): void {
    if (quoteLines) {
      html += '<div class="md-quote">' + quoteLines.join('<br>') + '</div>';
      quoteLines = null;
    }
  }

  function flushLists(): void {
    if (!lroot.length) return;
    // 先拼好整棵树再落 HTML：条目的子列表必须落在该条目的 <li> 内部，
    // 增量拼字符串做不到这一点，容易把嵌套列表挂到最后一个 </li> 外面去。
    function ser(nodes: ListNode[]): string {
      return nodes
        .map(
          (n) =>
            '<' + n.type + '>' +
            n.items
              .map((it) => '<li>' + it.text + (it.subs.length ? ser(it.subs) : '') + '</li>')
              .join('') +
            '</' + n.type + '>'
        )
        .join('');
    }
    html += ser(lroot);
    lroot = [];
    lstack = [];
  }

  function addItem(type: 'ul' | 'ol', indent: number, itemText: string): void {
    // 关掉所有比当前缩进更深的层级，栈顶即为本次的父级
    while (lstack.length && lstack[lstack.length - 1].indent > indent) lstack.pop();
    const parent = lstack.length ? lstack[lstack.length - 1] : null;
    let container: ListNode[];
    if (!parent) container = lroot;
    else if (indent > parent.indent) container = parent.items[parent.items.length - 1].subs;
    else container = parent.container;

    const last = container[container.length - 1];
    if (last && last.type === type && last.indent === indent) {
      last.items.push({ text: itemText, subs: [] });
      return;
    }
    // 同级换类型（ul → ol）：弹掉旧列表，改为并列的新列表
    if (parent && indent === parent.indent) lstack.pop();
    const node: ListNode = { type, indent, container, items: [{ text: itemText, subs: [] }] };
    container.push(node);
    lstack.push(node);
  }

  const isSepRow = (cells: string[]): boolean =>
    cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')));

  const parseRow = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function flushTable(): void {
    if (!tableRows) return;
    const head = tableRows[0];
    const ths = head.map((c) => '<th>' + c + '</th>').join('');
    const body = tableRows
      .slice(1)
      .map((r) => {
        while (r.length < head.length) r.push('');
        return '<tr>' + r.slice(0, head.length).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
      })
      .join('');
    html +=
      '<div class="md-table-wrap"><div class="md-table-box"><table><thead><tr>' + ths +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
    tableRows = null;
  }

  function flushAll(): void {
    flushPara();
    flushQuote();
    flushLists();
    flushTable();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // 独立成行的代码块占位符直接原样输出，不要再包一层段落
    if (/^\u0000B\d+\u0000$/.test(t)) {
      flushAll();
      html += t;
      continue;
    }
    if (!t) {
      flushAll();
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      html += '<div class="md-h md-h' + h[1].length + '">' + h[2] + '</div>';
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushAll();
      html += '<div class="md-hr"></div>';
      continue;
    }

    // 引用块：块级解析发生在 escapeHtml 之后，源码里的 `>` 此刻已是 `&gt;`
    const q = line.match(/^\s*(?:&gt;|>)\s?(.*)$/);
    if (q) {
      flushPara();
      flushLists();
      flushTable();
      (quoteLines = quoteLines || []).push(q[1]);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      // 表格行：表头下方的 --- 分隔行跳过。只认第 2 行，这样数据行里
      // 恰好全是 '-' 的单元格不会被误判成分隔行整行丢掉。
      flushPara();
      flushQuote();
      flushLists();
      const cells = parseRow(line);
      if (tableRows && tableRows.length === 1 && isSepRow(cells)) continue;
      if (!tableRows) tableRows = [];
      tableRows.push(cells);
      continue;
    }

    const ul = line.match(/^([ \t]*)[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      flushQuote();
      flushTable();
      addItem('ul', indentOf(ul[1]), ul[2]);
      continue;
    }

    const ol = line.match(/^([ \t]*)\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      flushQuote();
      flushTable();
      addItem('ol', indentOf(ol[1]), ol[2]);
      continue;
    }

    // 普通文本行：并入当前段落
    flushQuote();
    flushLists();
    flushTable();
    para.push(t);
  }
  flushAll();
  out = html;

  // 还原代码
  out = out.replace(/\u0000I(\d+)\u0000/g, (_m, i: string) => {
    return '<code class="md-code">' + escapeHtml(inlines[+i]) + '</code>';
  });
  return out.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => codeBlockHtml(blocks[+i]));
}
