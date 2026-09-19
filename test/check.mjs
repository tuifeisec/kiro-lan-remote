// 当前 Vue 架构契约检查：只验证构建产物边界和关键运行协议，不检查旧版单文件 DOM。
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2] || 'public/index.html';
const h = readFileSync(file, 'utf8');
const errors = [];
const ok = (condition, message) => {
  if (condition) console.log(`OK   ${message}`);
  else {
    errors.push(message);
    console.log(`FAIL ${message}`);
  }
};

console.log('Vue build contract:', file);

const scripts = [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok(scripts.length === 1, '产物包含一个内联脚本');
for (const [i, script] of scripts.entries()) {
  try {
    new vm.Script(script);
    console.log(`OK   script ${i} 可解析`);
  } catch (e) {
    errors.push(`script ${i} 语法错误：${e.message}`);
    console.log(`FAIL script ${i} 语法错误：${e.message}`);
  }
}

ok((h.match(/<div id="app"><\/div>/g) || []).length === 1, '保留 Vue 挂载点 #app');
ok(!/<script\b[^>]*\bsrc=/i.test(h), '脚本已内联，没有外部 JS 资源');
ok(!/<link\b[^>]*\bhref=/i.test(h), '没有外部 CSS/字体资源');
ok(h.includes('Kiro 遥控'), '构建产物包含当前 Vue 应用标题');
ok(h.includes('/ws?key='), '浏览器 WebSocket 仍使用 /ws?key= 协议');
ok(h.includes('session.load'), '构建产物包含会话加载命令');
ok(h.includes('session.prompt'), '构建产物包含消息发送命令');
ok(h.includes('session.cancel'), '构建产物包含取消命令');
ok(h.includes('permission-request'), '构建产物包含权限请求事件');
ok(h.includes('turnEnd'), '构建产物包含回合结束处理');

const gone = [
  ['旧 wsBar DOM', 'id="wsBar"'],
  ['旧 renderWsBar 函数', 'function renderWsBar('],
  ['旧 composer 发送按钮', 'id="sendBtn"'],
  ['旧页面根入口', 'id="listView"'],
];
for (const [label, marker] of gone) ok(!h.includes(marker), `不包含${label}`);

const files = readdirSync('public');
ok(files.length === 1 && files[0] === 'index.html', 'public/ 只保留单文件构建产物');

console.log(`\nRESULT: ${errors.length ? 'FAIL' : 'PASS'}`);
process.exit(errors.length ? 1 : 0);
