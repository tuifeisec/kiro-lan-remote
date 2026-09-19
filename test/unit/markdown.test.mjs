// 验证 src/utils/markdown.ts 的块级排版与安全转义。
//
// 断言逐条对应 test/md-render.test.mjs —— 那份测试是从旧 public/index.html
// 抽出脚本跑的，这里改为直接测新纯函数。同一组断言通过，即证明迁移等价。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../../src/utils/markdown.ts';

test('代码块：语言标签 + 复制按钮 + 块内容保留', () => {
  const h = renderMarkdown('```js\nconst a = 1;\n```');
  assert.ok(h.includes('class="md-codeblock"'), '包在 md-codeblock 容器里');
  assert.ok(h.includes('<span class="md-codeblock-lang">js</span>'), '语言名取自围栏信息串');
  assert.ok(h.includes('data-copy'), '代码块带复制按钮');
  assert.ok(h.indexOf('const a = 1;') > 0, '代码内容保留');
});

test('未闭合围栏：流式中途也按代码块渲染', () => {
  const h = renderMarkdown('说明文字\n\n```bash\nls -la\n');
  assert.ok(h.includes('class="md-codeblock"'), '未闭合围栏按代码块渲染');
  assert.ok(h.includes('ls -la'), '未闭合围栏的正文保留');
});

test('围栏信息串带属性时只显示第一个 token', () => {
  assert.ok(renderMarkdown('```js title="x"\nfoo\n```').includes('>js</span>'));
});

test('四反引号围栏包裹三反引号：不得提前闭合', () => {
  const h = renderMarkdown('````\n```js\nfoo\n```\n````');
  assert.ok(h.includes('```js') && h.includes('foo'), '内层三反引号整体保留');
  assert.equal((h.match(/md-codeblock"/g) || []).length, 1, '只产出单个代码块');
});

test('引用块：连续 > 行合并', () => {
  assert.ok(
    renderMarkdown('> 第一行\n> 第二行').includes(
      '<div class="md-quote">第一行<br>第二行</div>'
    )
  );
});

test('嵌套列表挂在父条目的 li 内', () => {
  assert.ok(
    renderMarkdown('- 一级\n  - 二级\n- 另一个一级').includes(
      '<ul><li>一级<ul><li>二级</li></ul></li><li>另一个一级</li></ul>'
    )
  );
});

test('ol 与 ul 分开成两个列表', () => {
  const h = renderMarkdown('1. 甲\n2. 乙\n- 丙');
  assert.ok(h.includes('<ol><li>甲</li><li>乙</li></ol>'));
  assert.ok(h.includes('<ul><li>丙</li></ul>'));
});

test('表格分隔行只认第 2 行：数据行整行 - 不被吞掉', () => {
  const h = renderMarkdown('| A | B |\n| --- | --- |\n| - | x |');
  assert.ok(h.includes('<td>-</td>'), '数据行里的 - 单元格未被误判为分隔行');
  assert.ok(!h.includes('<th>---</th>'), '分隔行本身不出现在表头');
});

test('行内代码保留 md-code', () => {
  assert.ok(renderMarkdown('前 `code` 后').includes('<code class="md-code">code</code>'));
});

test('CRLF 输入正常解析列表', () => {
  assert.ok(renderMarkdown('- a\r\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
});

test('安全：代码块内容被转义', () => {
  assert.ok(!renderMarkdown('```\n<script>alert(1)</script>\n```').includes('<script>'));
});

test('安全：引用块内容被转义', () => {
  assert.ok(!renderMarkdown('> <img src=x onerror=1>').includes('<img'));
});

test('安全：链接只允许 http/https', () => {
  const h = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!h.includes('href="javascript:'), 'javascript: 协议不得成为链接');
  const ok = renderMarkdown('[doc](https://example.com/a)');
  assert.ok(ok.includes('href="https://example.com/a"'), 'https 链接保留');
  assert.ok(ok.includes('rel="noopener noreferrer"'), '外链带 noopener');
});

test('安全：模型原文中的裸标签被转义', () => {
  const h = renderMarkdown('<div onclick="x">hi</div>');
  assert.ok(!h.includes('<div onclick'), '裸标签被转义');
  assert.ok(h.includes('&lt;div'), '转义为实体');
});

test('安全：escapeHtml 覆盖五个字符', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('空输入返回空串', () => {
  assert.equal(renderMarkdown(''), '');
});

test('标题层级映射到 md-h1..md-h6', () => {
  assert.ok(renderMarkdown('## 标题').includes('class="md-h md-h2"'));
  assert.ok(renderMarkdown('# 标题').includes('class="md-h md-h1"'));
});

test('粗体渲染为 strong', () => {
  assert.ok(renderMarkdown('**加粗**').includes('<strong>加粗</strong>'));
});

test('水平分隔线', () => {
  assert.ok(renderMarkdown('a\n\n---\n\nb').includes('<div class="md-hr"></div>'));
});
