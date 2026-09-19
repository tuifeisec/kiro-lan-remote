// 验证 renderMarkdown 的块级排版：代码块（语言/复制/未闭合）、引用块、
// 嵌套列表、表格分隔行、行内代码与块内代码的样式隔离。
//
// 直接从 public/index.html 抽出脚本在 DOM stub 里跑，复用 ui-smoke 的脚手架思路，
// 只对渲染结果做断言 —— 不引入新依赖。
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

class El {
  constructor(tag){
    this.tagName = tag; this.children = []; this.parentElement = null;
    this.style = {}; this.attrs = {}; this._cls = new Set(); this._h = {};
    this._inner = ''; this.textContent = ''; this.value = ''; this.scrollLeft = 0;
    this.classList = {
      add: (...c) => c.forEach(x => this._cls.add(x)),
      remove: (...c) => c.forEach(x => this._cls.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !this._cls.has(c) : !!f; on ? this._cls.add(c) : this._cls.delete(c); return on; },
      contains: c => this._cls.has(c),
    };
  }
  set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(){ return [...this._cls].join(' '); }
  set id(v){ this._id = v; byId.set(v, this); }
  get id(){ return this._id; }
  set innerHTML(v){ this._inner = v; }
  get innerHTML(){ return this._inner; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return this.attrs[k] ?? null; }
  addEventListener(t, f){ (this._h[t] = this._h[t] || []).push(f); }
  click(){ (this._h.click || []).forEach(fn => fn({ stopPropagation(){}, target: this, closest: () => null })); }
  appendChild(c){ this.children.push(c); c.parentElement = this; return c; }
  insertBefore(c, r){ const i = this.children.indexOf(r); i < 0 ? this.children.push(c) : this.children.splice(i, 0, c); c.parentElement = this; return c; }
  insertAdjacentHTML(_, h){ this._inner += h; }
  selectAll(p){ const o = []; const w = n => n.children.forEach(c => { if (p(c)) o.push(c); w(c); }); w(this); return o; }
  byClass(c){ return this.selectAll(n => n._cls.has(c)); }
  querySelector(s){ const c = s.replace(/^\./, ''); const w = n => { for (const k of n.children){ if (k._cls.has(c)) return k; const r = w(k); if (r) return r; } return null; }; return w(this); }
  querySelectorAll(s){ const c = s.replace(/^\./, ''); return this.selectAll(n => n._cls.has(c)); }
  focus(){} setSelectionRange(){}
}
const byId = new Map();
for (const m of html.matchAll(/id="([^"]+)"/g)) byId.set(m[1], new El('div'));

globalThis.location = { search: '?key=k', protocol: 'http:', host: '127.0.0.1:8790' };
globalThis.WebSocket = class { constructor(){ this.readyState = 0; } send(){} close(){} };
globalThis.document = {
  getElementById: id => byId.get(id) || null,
  querySelectorAll: () => [],
  addEventListener(){},
  createElement: t => new El(t),
  body: new El('body'),
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = fn => fn();

// 暴露 renderMarkdown 供断言：脚本是 IIFE，在闭合括号前插入一行导出。
const injected = js.slice(0, js.lastIndexOf('})();')) +
  '\n;globalThis.__renderMarkdown = renderMarkdown;\n' + js.slice(js.lastIndexOf('})();'));
new Function(injected)();

const md = globalThis.__renderMarkdown;
let fail = 0;
const assert = (c, m) => { if (!c){ console.error('FAIL:', m); fail = 1; } else console.log('ok:', m); };

// ---- 代码块：语言标签 + 复制按钮 + 块内 code 不带行内样式 ----
let h = md('```js\nconst a = 1;\n```');
assert(h.includes('class="md-codeblock"'), '代码块包在 md-codeblock 容器里');
assert(h.includes('<span class="md-codeblock-lang">js</span>'), '语言名取自围栏信息串');
assert(h.includes('data-copy'), '代码块带复制按钮');
assert(h.indexOf('const a = 1;') > 0, '代码内容保留');

// ---- 未闭合围栏：流式中途也按代码块渲染 ----
h = md('说明文字\n\n```bash\nls -la\n');
assert(h.includes('class="md-codeblock"'), '未闭合围栏按代码块渲染');
assert(h.includes('ls -la'), '未闭合围栏的正文保留');

// ---- 围栏信息串带属性时只显示第一个 token ----
h = md('```js title="x"\nfoo\n```');
assert(h.includes('>js</span>'), '信息串只显示语言 token');

// ---- 四反引号围栏包裹三反引号：不得提前闭合 ----
h = md('````\n```js\nfoo\n```\n````');
assert(h.includes('```js') && h.includes('foo'), '四反引号围栏内的三反引号整体保留');
assert((h.match(/md-codeblock"/g) || []).length === 1, '四反引号围栏只产出单个代码块');

// ---- 引用块 ----
h = md('> 第一行\n> 第二行');
assert(h.includes('<div class="md-quote">第一行<br>第二行</div>'), '连续 > 行合并为引用块');

// ---- 嵌套列表 ----
h = md('- 一级\n  - 二级\n- 另一个一级');
assert(h.includes('<ul><li>一级<ul><li>二级</li></ul></li><li>另一个一级</li></ul>'), '嵌套列表挂在父条目的 li 内');

// ---- 有序的无序混排 ----
h = md('1. 甲\n2. 乙\n- 丙');
assert(h.includes('<ol><li>甲</li><li>乙</li></ol>') && h.includes('<ul><li>丙</li></ul>'), 'ol 与 ul 分开成两个列表');

// ---- 表格分隔行只认第 2 行：数据行整行 '-' 不被吞掉 ----
h = md('| A | B |\n| --- | --- |\n| - | x |');
assert(h.includes('<td>-</td>'), '数据行里的 - 单元格未被误判为分隔行');
assert(!h.includes('<th>---</th>'), '分隔行本身不出现在表头');

// ---- 行内代码 ----
h = md('前 `code` 后');
assert(h.includes('<code class="md-code">code</code>'), '行内代码保留 md-code');

// ---- CRLF 归一化 ----
h = md('- a\r\n- b');
assert(h.includes('<ul><li>a</li><li>b</li></ul>'), 'CRLF 输入正常解析列表');

// ---- 转义：脚本注入不可执行 ----
h = md('```\n<script>alert(1)</script>\n```');
assert(!h.includes('<script>'), '代码块内容被转义');
h = md('> <img src=x onerror=1>');
assert(!h.includes('<img'), '引用块内容被转义');

console.log(fail ? '\n=== 渲染测试存在失败 ===' : '\n=== 渲染测试全部通过 ===');
process.exit(fail);
