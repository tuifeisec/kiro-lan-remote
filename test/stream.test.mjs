// 验证流式相关的行为：用户消息分片合并、工具行操作对象提取、
// 回复正文的合帧写入与代码块横向滚动保持。
// 复用 ui-smoke 的 DOM stub 与事件注入路径。
import fs from 'node:fs';

const BS = String.fromCharCode(92);
const html = fs.readFileSync('public/index.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

class El {
  constructor(tag){
    this.tagName = tag; this.children = []; this.parentElement = null;
    this.style = {}; this.attrs = {}; this._cls = new Set(); this._h = {};
    this._inner = ''; this.textContent = ''; this.value = ''; this.scrollLeft = 0;
    this.hidden = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
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
  set innerHTML(v){
    this._inner = v;
    // 极简解析：把生成的 HTML 还原成节点树，使 querySelector/classList 的断言
    // 覆盖真实结构（否则只能对字符串做断言，类名与层级错误会被漏掉）。
    this.children = [];
    if (v === '') return;
    const stack = [this];
    const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(v))){
      if (m[4] !== undefined){
        const txt = m[4];
        const top = stack[stack.length - 1];
        if (txt.trim()) top.textContent += txt;
        continue;
      }
      const tag = m[1].toLowerCase();
      const selfClose = m[3] === '/' || ['br', 'img', 'hr', 'input'].includes(tag);
      if (m[0].charAt(1) === '/'){
        if (stack.length > 1) stack.pop();
        continue;
      }
      const node = new El(tag);
      for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.attrs[a[1]] = a[2] ?? '';
      if (node.attrs.class) node.className = node.attrs.class;
      if (node.attrs.id) node.id = node.attrs.id;
      const parent = stack[stack.length - 1];
      parent.children.push(node);
      node.parentElement = parent;
      if (!selfClose) stack.push(node);
    }
  }
  get innerHTML(){ return this._inner; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return this.attrs[k] ?? null; }
  addEventListener(t, f){ (this._h[t] = this._h[t] || []).push(f); }
  dispatch(type, ev){ (this._h[type] || []).forEach(fn => fn(ev)); }
  click(){ this.dispatch('click', { stopPropagation(){}, target: this, closest: () => null }); }
  appendChild(c){ if (c.parentElement) c.parentElement.removeChild(c); this.children.push(c); c.parentElement = this; return c; }
  removeChild(c){ const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentElement = null; return c; }
  remove(){ if (this.parentElement) this.parentElement.removeChild(this); }
  insertBefore(c, r){ if (c.parentElement) c.parentElement.removeChild(c); const i = this.children.indexOf(r); i < 0 ? this.children.push(c) : this.children.splice(i, 0, c); c.parentElement = this; return c; }
  insertAdjacentHTML(_, h){ this._inner += h; }
  selectAll(p){ const o = []; const w = n => n.children.forEach(c => { if (p(c)) o.push(c); w(c); }); w(this); return o; }
  byClass(c){ return this.selectAll(n => n._cls.has(c)); }
  byTag(t){ return this.selectAll(n => n.tagName === t); }
  querySelector(s){
    if (/^\[.*\]$/.test(s)){ const a = s.slice(1, -1); const k = a.indexOf('=') < 0 ? null : a.split('=')[0]; const w = n => { for (const c of n.children){ if (k && c.attrs[k] !== undefined) return c; const r = w(c); if (r) return r; } return null; }; return w(this); }
    const c = s.replace(/^\./, '');
    const w = n => { for (const k of n.children){ if (k._cls.has(c)) return k; const r = w(k); if (r) return r; } return null; };
    return w(this);
  }
  querySelectorAll(s){
    if (/^\[.*\]$/.test(s)){ const k = s.slice(1, -1).split('=')[0]; return this.selectAll(n => n.attrs[k] !== undefined); }
    const c = s.replace(/^\./, ''); return this.selectAll(n => n._cls.has(c));
  }
  focus(){} setSelectionRange(){}
  getBoundingClientRect(){ return { top: 0, bottom: 0 }; }
}

const byId = new Map();
for (const m of html.matchAll(/id="([^"]+)"/g)) byId.set(m[1], new El('div'));

const captured = { sent: [] };
class FakeWS {
  constructor(){ this.readyState = 0; FakeWS.last = this; }
  send(d){ captured.sent.push(d); }
  close(){ this.readyState = 3; }
}
const dots = [byId.get('connDot'), new El('span')];
globalThis.location = { search: '?key=k', protocol: 'http:', host: '127.0.0.1:8790' };
globalThis.WebSocket = FakeWS;
globalThis.document = {
  getElementById: id => byId.get(id) || null,
  querySelectorAll: sel => sel === '.dot' ? dots : [],
  addEventListener(){},
  createElement: t => new El(t),
  body: new El('body'),
};
globalThis.window = globalThis;
const rafQueue = [];
globalThis.requestAnimationFrame = fn => { rafQueue.push(fn); return rafQueue.length; };
const runRaf = () => { while (rafQueue.length) rafQueue.shift()(); };

new Function(js)();

let fail = 0;
const assert = (c, m) => { if (!c){ console.error('FAIL:', m); fail = 1; } else console.log('ok:', m); };
const send = o => FakeWS.last.onmessage({ data: JSON.stringify(o) });
const lastId = () => JSON.parse(captured.sent[captured.sent.length - 1]).id;
const turns = () => byId.get('msgs').children.filter(n => n._cls.has('turn'));

// 进入会话页
FakeWS.last.readyState = 1;
FakeWS.last.onopen();
await new Promise(r => setTimeout(r, 0));
send({ type: 'res', id: lastId(), ok: true, result: { sessions: [
  { sessionId: 's1', cwd: 'D:' + BS + 'demo', title: '排查', status: 'completed', updatedAt: '2026-09-18T10:00:00Z' },
]}});
await new Promise(r => setTimeout(r, 0));
byId.get('sessionList').children[0].children[1].children[0].children[0].click();
await new Promise(r => setTimeout(r, 0));
send({ type: 'res', id: lastId(), ok: true, result: {} });
await new Promise(r => setTimeout(r, 0));

// ---- 用户消息分片合并：同 messageId 应合成一个气泡 ----
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '第一段', messageId: 'm1' } });
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '第二段', messageId: 'm1' } });
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '第三段', messageId: 'm1' } });
assert(turns().length === 1, '同 messageId 的多片只开一个回合，实际 ' + turns().length);
let bubbles = byId.get('msgs').byClass('user-bubble');
assert(bubbles.length === 1 && bubbles[0].textContent === '第一段第二段第三段',
  '分片累加成一条完整消息，实际 ' + JSON.stringify(bubbles.map(b => b.textContent)));

// 不同 messageId 才开新回合
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '另一条', messageId: 'm2' } });
assert(turns().length === 2, '不同 messageId 开新回合');

// 回复到达后关闭合并窗口：后续无 messageId 的 user 帧不与上一条合并
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '回答' } });
runRaf();
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '新问题' } });
assert(turns().length === 3, '回复之后的 user 帧开新回合（未被并进上一条）');
bubbles = byId.get('msgs').byClass('user-bubble');
assert(bubbles.some(b => b.textContent === '新问题'), '新问题成为独立气泡');

// ---- 本页发送后的回显去重：手机已显示过的内容不再重复出现 ----
byId.get('input').value = '帮我排查时区问题';
byId.get('sendBtn').onclick();
await new Promise(r => setTimeout(r, 0));
const beforeEcho = turns().length;
const nBefore = byId.get('msgs').byClass('user-bubble').length;
// Kiro 把手机发出的那句回显回来（分两片，拼接后与原文一致）
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '帮我排查', messageId: 'e1' } });
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '时区问题', messageId: 'e1' } });
assert(turns().length === beforeEcho, '回显不再新增回合，实际 ' + turns().length + ' vs ' + beforeEcho);
assert(byId.get('msgs').byClass('user-bubble').length === nBefore, '回显不再新增气泡');

// 回显消耗完毕后，真实的新消息仍正常显示
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '换个话题' } });
assert(turns().length === beforeEcho + 1, '回显消耗完后新消息正常开回合');

// ---- 合帧：同一帧内的多个 chunk 只重渲染一次 ----
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '## 标题' } });
assert(rafQueue.length === 1, '首个 chunk 只排一次渲染');
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '\n正文' } });
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '\n更多' } });
assert(rafQueue.length === 1, '同帧后续 chunk 不再重复排队');
runRaf();
const md = turns()[turns().length - 1].byClass('md').pop();
assert(md.innerHTML.includes('md-h2'), '合帧后仍正确渲染标题');
assert(md.innerHTML.includes('正文') && md.innerHTML.includes('更多'), '合帧未丢失内容');

// ---- 工具行：从 rawInput 提取操作对象 ----
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 't1', title: '终端', status: 'in_progress', rawInput: { command: 'ls -la "D:/proxy"' } } });
const t = turns()[turns().length - 1];
let cmds = t.byClass('wr-cmd');
assert(cmds.length === 1 && cmds[0].textContent.includes('ls -la'), '终端命令显示在工具行上，实际 ' + JSON.stringify(cmds.map(c => c.textContent)));

send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 't2', title: '读取', status: 'completed', rawInput: { path: 'D:/proxy/api/stats.go' } } });
const t2 = turns()[turns().length - 1];
const paths = t2.byClass('wr-path').map(p => p.textContent);
assert(paths.includes('stats.go'), '文件名显示在工具行上，实际 ' + JSON.stringify(paths));
assert(paths.includes('D:/proxy/api/'), '所在目录显示在文件名之后，实际 ' + JSON.stringify(paths));

// 取不到操作对象时只显示标题 + 状态，不猜
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 't3', title: '思考', status: 'completed' } });
const t3 = turns()[turns().length - 1];
const lastTool = t3.byClass('wr-tool').pop();
assert(lastTool.byClass('wr-cmd').length === 0 && lastTool.byClass('wr-path').length === 0, '无入参时不编造操作对象');

// ---- 代码块横向滚动在重渲染后保持 ----
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '\n```bash\nvery-long-command\n```' } });
runRaf();
const block = turns()[turns().length - 1].byClass('md-pre').pop();
block.scrollLeft = 123;
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '\n尾注' } });
runRaf();
const block2 = turns()[turns().length - 1].byClass('md-pre').pop();
assert(block2.scrollLeft === 123, '重渲染后代码块横向位置保持，实际 ' + block2.scrollLeft);

// ---- 工作过程：叙述与工具行交错，回合结束后收缩 ----
// 独立开一个回合，避免继承前面用例的气泡合并窗口
send({ type: 'event', sessionId: 's1', event: { kind: 'user-text', text: '清点一下', messageId: 'z1' } });

// ① 尚无工具调用：文本按结论正文展平，且不凭空建过程面板
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '我先看一下。' } });
runRaf();
let zTurn = turns()[turns().length - 1];
assert(zTurn.byClass('assistant').length === 1, '无工具调用时文本直接作为结论正文');
assert(zTurn.byClass('wr-panel').length === 0, '无工具调用时不建过程面板');

// ② 工具调用到达：此前那段文本被降级进面板
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'z_t1', title: '终端', status: 'completed', rawInput: { command: 'ls -la' } } });
const zRows = zTurn.querySelector('.wr-rows');
assert(zRows && zRows.byClass('wr-text').length === 1, '动手前的说明被搬进过程面板');
assert(zTurn.byClass('assistant').length === 0, '面板外的展平回复块已撤除');
assert(zRows.byClass('wr-tool').length === 1, '面板内有工具调用行');
assert(zTurn.querySelector('.wr-panel')._cls.has('open'), '过程进行中面板展开');

// ③ 工具之后再来一段文本：成为第二个叙述块，仍属过程
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '目录里有 3 个文件。' } });
runRaf();
assert(zRows.byClass('wr-text').length === 2, '工具之后的文本成为新的叙述块，实际 ' + zRows.byClass('wr-text').length);
assert(zTurn.byClass('assistant').length === 0, '过程进行中叙述不展平到面板外');

// ④ 叙述与下一次工具调用落在同一帧（增量尚未渲染就被切断）：不得丢字
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '这段还没渲染就被切断。' } });
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'z_t2', title: '终端', status: 'completed', rawInput: { command: 'pwd' } } });
const zTexts = zRows.byClass('wr-text').map(n => n.innerHTML);
assert(zTexts.some(h => h.includes('这段还没渲染就被切断')), '同帧切断的叙述不丢字，实际 ' + JSON.stringify(zTexts));
assert(zRows.byClass('wr-tool').length === 2, '第二个工具行已追加，实际 ' + zRows.byClass('wr-tool').length);

// ⑤ 工具之后的收尾叙述：这才是本回合的结论，收尾时应被提升
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '结论：需要补上 TZ。' } });
runRaf();
assert(zRows.byClass('wr-text').length === 3, '收尾叙述自成一个块，实际 ' + zRows.byClass('wr-text').length);

// ⑥ 收尾：下一条用户消息是本页发送的，会走 newTurn→finishTurn
byId.get('input').value = '收尾测试';
byId.get('sendBtn').onclick();
await new Promise(r => setTimeout(r, 0));
send({ type: 'res', id: lastId(), ok: true, result: {} });
await new Promise(r => setTimeout(r, 0));
const flat = zTurn.byClass('assistant');
assert(flat.length === 1, '收尾后最后一段叙述提升为展平正文，实际 ' + flat.length);
const flatMd = flat[0].byClass('md')[0];
assert(flatMd && flatMd.innerHTML.includes('结论：需要补上 TZ'), '提升的正是最后一段叙述，实际 ' + (flatMd ? flatMd.innerHTML : 'null'));
assert(zTurn.querySelector('.wr-panel')._cls.has('open') === false, '收尾后过程面板默认收缩');
assert(zRows.byClass('wr-text').length === 2, '中间叙述留在折叠区内，实际 ' + zRows.byClass('wr-text').length);
assert(zRows.byClass('wr-tool').length === 2, '工具行留在折叠区内，实际 ' + zRows.byClass('wr-tool').length);
// 节点是「移动」而非「复制」：全回合不该出现重复副本
assert(zTurn.byClass('md').length === 3, '移动叙述块后无残留副本，实际 ' + zTurn.byClass('md').length);

// ---- 收尾竞态：prompt 响应早于最后一批分片到达，迟到文本必须仍然可见 ----
// 分片与响应走两条独立的写出路径，响应可能先到；此时面板已收起，
// 若迟到的那段仍被塞进折叠区，用户就「看不到完整结果」，直到发下一条消息
// 触发 newTurn→promoteProc 才把它捞出来。
// 必须用本页发送来构造这个回合：只有它的收尾不依赖「下一条用户消息」，
// 因此收尾前后 curTurn 始终是同一个回合（用户没发新消息时正是如此）。
byId.get('input').value = '竞态收尾';
byId.get('sendBtn').onclick();
await new Promise(r => setTimeout(r, 0));
const raceTurn = turns()[turns().length - 1];
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'r_t1', title: '终端', status: 'completed', rawInput: { command: 'ls' } } });
// 面板由首个工具调用创建，必须在这之后再取 rows 引用（它在整个回合内保持有效）
const raceRows = raceTurn.querySelector('.wr-rows');
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '结论前半段。' } });
runRaf();   // 这一段此刻还在面板里（回合未收尾）

// 响应到达：回合正式收尾，面板收起，前半段被提升为结论
send({ type: 'res', id: lastId(), ok: true, result: {} });
await new Promise(r => setTimeout(r, 0));
assert(raceTurn.querySelector('.wr-panel')._cls.has('open') === false, '收尾后面板已收起');

// 收尾之后才到达的剩余分片：必须落到面板外的结论正文里，而不是折叠区内
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '结论后半段。' } });
runRaf();
// 注意：byClass('assistant') 拿到的是外层容器，DOM 桩不会把子节点的
// innerHTML 聚合上来，因此要取容器内的 .md 叶子块来断言内容
const htmlOf = n => n.byClass('md').map(m => m.innerHTML).join('');
const late = raceTurn.byClass('assistant');
assert(late.length >= 1, '收尾后迟到的分片应落到面板外（可见），实际 0');
const lateText = late.map(htmlOf).join('');
assert(lateText.includes('结论后半段'), '迟到分片出现在面板外，实际 ' + JSON.stringify(late.map(htmlOf)));
assert(!raceRows.byClass('wr-text').map(m => m.innerHTML).join('').includes('结论后半段'),
  '迟到分片不得落进已收起的面板');

// 面板外文本应保持连贯：提升出来的前半段与迟到的后半段同处结论区
assert(lateText.includes('结论前半段'), '收尾时提升的前半段与迟到分片同处结论区，实际 ' + JSON.stringify(lateText));

// 收尾后到达的新工具调用：不回填已定稿的结论，也不把面板重新弹开。
// 反例（本页曾经的缺陷）：此处把回合当作「重返进行态」，于是把后面的文本
// 又送进已收起的面板 —— 用户看到的总结会凭空消失，只剩一条折叠线。
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'r_t2', title: '读取', status: 'completed', rawInput: { path: 'a/b.txt' } } });
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '这个回合还没完。' } });
runRaf();
assert(raceTurn.byClass('assistant').map(htmlOf).join('').includes('这个回合还没完'),
  '定稿后迟到的工具调用不再把后续叙述藏回折叠面板（结果必须可见）');
assert(!raceRows.byClass('wr-text').map(m => m.innerHTML).join('').includes('这个回合还没完'),
  '该叙述不落进折叠面板');
assert(raceTurn.querySelector('.wr-panel')._cls.has('open') === false,
  '定稿后迟到的工具调用不把面板重新弹开');
assert(raceRows.byClass('wr-tool').map(m => m.id).includes('tool_r_t2'),
  '该工具行仍记入过程面板（留痕，但不干扰结果）');
assert(raceTurn.byClass('assistant').map(htmlOf).join('').includes('结论前半段'),
  '已定稿的结论仍在可见区');
// 迟到的分片必须接在同一块里：若另起一块，一条完整回复会被裂成两段，
// 操作条的复制按钮只取最后一块，用户复制到的是半句话。
const ansMds = raceTurn.byClass('assistant').map(a => a.byClass('md')).flat();
assert(ansMds.length === 1, '迟到的分片接在同一结论块内，不裂成多块，实际 ' + ansMds.length);
const joined = ansMds.map(m => m.innerHTML).join('');
assert(joined.indexOf('结论前半段') >= 0 && joined.indexOf('结论后半段') > joined.indexOf('结论前半段'),
  '结论前半段与后半段在同一块内且顺序正确，实际 ' + JSON.stringify(joined));

// ---- 回归：结论之后又出现工具调用，收尾时结论必须仍被提升到面板外 ----
// 成因：提升判据若只看「当前正在写入的叙述块」，该引用会被后续工具调用清空，
// 收尾时便无块可提升 —— 整段结论留在折叠区，界面上只剩一个收起的「工作过程」，
// 要等用户发下一条消息才被捞出来（表现为「结果全丢进工作过程里」）。
byId.get('input').value = '结论后再工具';
byId.get('sendBtn').onclick();
await new Promise(r => setTimeout(r, 0));
const pTurn = turns()[turns().length - 1];
const pRid = lastId();
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '我来看一下。' } });
runRaf();
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'p_t1', title: '终端', status: 'completed', rawInput: { command: 'ls' } } });
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '结论：需要补上 TZ。' } });
runRaf();
// 结论之后 agent 又做了一次收尾校验：此时「当前叙述块」被工具调用清空
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'p_t2', title: '终端', status: 'completed', rawInput: { command: 'grep TZ' } } });
runRaf();
send({ type: 'res', id: pRid, ok: true, result: {} });
await new Promise(r => setTimeout(r, 0));
const pVis = pTurn.byClass('assistant').map(htmlOf).join('');
assert(pVis.includes('结论：需要补上 TZ'), '结论之后又有工具调用时，收尾仍把结论提升到面板外，实际 ' + JSON.stringify(pVis));
assert(pTurn.byClass('assistant').length === 1, '此时只提升最后一段，实际 ' + pTurn.byClass('assistant').length);
// 中间叙述仍留在折叠区内
const pRows = pTurn.querySelector('.wr-rows');
assert(pRows.byClass('wr-text').map(m => m.innerHTML).join('').includes('我来看一下'),
  '中间叙述留在折叠区内');
assert(pTurn.querySelector('.wr-panel')._cls.has('open') === false, '收尾后过程面板默认收缩');

// ---- 回归：回合以工具调用收尾、其后无文本，动手前的说明不得被困在折叠区 ----
// 否则用户什么都看不到（唯一的一段文字被关进收起的面板里）。
byId.get('input').value = '只说不做的回合';
byId.get('sendBtn').onclick();
await new Promise(r => setTimeout(r, 0));
const qTurn = turns()[turns().length - 1];
const qRid = lastId();
send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '我先确认容器时区。' } });
runRaf();
send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'q_t1', title: '终端', status: 'completed', rawInput: { command: 'date' } } });
runRaf();
send({ type: 'res', id: qRid, ok: true, result: {} });
await new Promise(r => setTimeout(r, 0));
const qVis = qTurn.byClass('assistant').map(htmlOf).join('');
assert(qVis.includes('我先确认容器时区'), '回合以工具收尾时，动手前的说明提升为可见正文，实际 ' + JSON.stringify(qVis));
assert(qTurn.querySelector('.wr-rows').byClass('wr-text').length === 0,
  '该说明已移出折叠区，实际 ' + qTurn.querySelector('.wr-rows').byClass('wr-text').length);

// ---- 回归：折叠标题报「时长 · 工具调用次数」 ----
// 面板默认收起，标题若只有时长，用户不展开就无从判断这一步做了多少事。
{
  byId.get('input').value = '统计次数';
  byId.get('sendBtn').onclick();
  await new Promise(r => setTimeout(r, 0));
  const cTurn = turns()[turns().length - 1];
  const cRid = lastId();
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'c1', title: '终端', status: 'completed', rawInput: { command: 'ls' } } });
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'c2', title: '读取', status: 'completed', rawInput: { path: 'a.txt' } } });
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'c3', title: '终端', status: 'completed', rawInput: { command: 'pwd' } } });
  // 同一行的执行中变化不是新调用，不得重复计数
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call-update', toolCallId: 'c3', status: 'completed' } });
  runRaf();
  const lbl = cTurn.querySelector('.work-btn').children[0].textContent;
  assert(/3 次工具调用$/.test(lbl), '折叠标题统计到 3 次工具调用，实际 ' + JSON.stringify(lbl));
  assert(/^已工作 \d+ 秒/.test(lbl), '本页发起的回合标题同时带时长，实际 ' + JSON.stringify(lbl));
  send({ type: 'res', id: cRid, ok: true, result: {} });
  await new Promise(r => setTimeout(r, 0));
}

// ---- 回归：回放（session.load）结束后，末回合的总结必须被提升为可见正文 ----
// 回放逐条重建历史时，每个回合靠「下一条用户消息」收尾（见 newTurn→finishTurn），
// 末回合没有下一条消息，因此永远不会收尾 —— 它的结论会一直留在折叠面板里，
// 界面上看不到结果。载入完成即是这个末回合的天然边界。
{
  byId.get('backBtn').onclick();
  await new Promise(r => setTimeout(r, 0));
  send({ type: 'res', id: lastId(), ok: true, result: { sessions: [
    { sessionId: 's1', cwd: 'D:' + BS + 'demo', title: '排查', status: 'completed', updatedAt: '2026-09-18T10:00:00Z' },
  ]}});
  await new Promise(r => setTimeout(r, 0));
  byId.get('sessionList').children[0].children[1].children[0].children[0].click();
  await new Promise(r => setTimeout(r, 0));
  const lRid = lastId();
  for (const e of [
    { kind: 'user-text', text: '查时区', replay: true },
    { kind: 'assistant-text', text: '我先看一下容器。', replay: true },
    { kind: 'tool-call', toolCallId: 'h_t1', title: '终端', status: 'completed', rawInput: { command: 'date' }, replay: true },
    { kind: 'assistant-text', text: '当前是 UTC。', replay: true },
    { kind: 'tool-call', toolCallId: 'h_t2', title: '读取', status: 'completed', rawInput: { path: 'docker-compose.yml' }, replay: true },
    { kind: 'assistant-text', text: '总结：compose 里补 TZ 即可。', replay: true },
  ]) send({ type: 'event', sessionId: 's1', event: e });
  runRaf();
  send({ type: 'res', id: lRid, ok: true, result: {} });
  await new Promise(r => setTimeout(r, 0));
  const rTurn = turns()[turns().length - 1];
  const rVis = rTurn.byClass('assistant').map(htmlOf).join('');
  assert(rVis.includes('总结：compose 里补 TZ'), '回放结束后末回合的总结提升为可见正文，实际 ' + JSON.stringify(rVis));
  assert(rTurn.querySelector('.wr-panel')._cls.has('open') === false, '回放结束后末回合面板收起');
  assert(!rTurn.querySelector('.wr-rows').byClass('wr-text').map(m => m.innerHTML).join('').includes('总结：compose'),
    '总结不在折叠面板内');
  assert(rTurn.querySelector('.wr-rows').byClass('wr-text').map(m => m.innerHTML).join('').includes('我先看一下容器'),
    '过程的中间叙述留在折叠面板内');
  assert(/2 次工具调用$/.test(rTurn.querySelector('.work-btn').children[0].textContent),
    '回放回合的标题统计到 2 次工具调用，实际 ' + JSON.stringify(rTurn.querySelector('.work-btn').children[0].textContent));
}

// ---- 回归：点击任一回合的折叠线，只切换它自己的面板 ----
// 反例：点击处理器若读全局 curWork（指向最新回合），历史回合会纹丝不动，
// 而最新回合反而莫名展开。
{
  byId.get('input').value = '折叠线归属';
  byId.get('sendBtn').onclick();
  await new Promise(r => setTimeout(r, 0));
  const n1 = lastId();
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'f1', title: '终端', status: 'completed', rawInput: { command: 'ls' } } });
  send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '甲结论。' } });
  runRaf();
  send({ type: 'res', id: n1, ok: true, result: {} });
  await new Promise(r => setTimeout(r, 0));
  const older = turns()[turns().length - 2];
  byId.get('input').value = '再来一个';
  byId.get('sendBtn').onclick();
  await new Promise(r => setTimeout(r, 0));
  const n2 = lastId();
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'f2', title: '终端', status: 'completed', rawInput: { command: 'pwd' } } });
  send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '乙结论。' } });
  runRaf();
  send({ type: 'res', id: n2, ok: true, result: {} });
  await new Promise(r => setTimeout(r, 0));
  const newest = turns()[turns().length - 1];
  const oldPanel = older.querySelector('.wr-panel');
  const newPanel = newest.querySelector('.wr-panel');
  assert(!oldPanel._cls.has('open') && !newPanel._cls.has('open'), '两个回合的面板都默认收起');
  older.querySelector('.work-btn').click();
  assert(oldPanel._cls.has('open'), '点击历史回合的折叠线展开的是它自己的面板');
  assert(!newPanel._cls.has('open'), '最新回合的面板未被误开');
  older.querySelector('.work-btn').click();
  assert(!oldPanel._cls.has('open'), '再次点击可收起');
}

// ---- 回归：收尾必须幂等 —— 重复收尾不得把过程叙述逐块搬进结论区 ----
// 一个回合会被收尾多次：本页发送在 prompt 响应时收一次，下一条消息的
// newTurn 又收一次（外部驱动的回合只有这条边界）。若每次再提升一块，
// 面板里的「我先看一下」会冒充结论排到真正的总结前面。
{
  byId.get('input').value = '幂等收尾';
  byId.get('sendBtn').onclick();
  await new Promise(r => setTimeout(r, 0));
  const iTurn = turns()[turns().length - 1];
  const iRid = lastId();
  send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '我先看容器。' } });
  runRaf();
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'i1', title: '终端', status: 'completed', rawInput: { command: 'date' } } });
  runRaf();
  send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '当前 UTC。' } });
  runRaf();
  send({ type: 'event', sessionId: 's1', event: { kind: 'tool-call', toolCallId: 'i2', title: '读取', status: 'completed', rawInput: { path: 'dc.yml' } } });
  runRaf();
  send({ type: 'event', sessionId: 's1', event: { kind: 'assistant-text', text: '总结：补 TZ 即可。' } });
  runRaf();
  send({ type: 'res', id: iRid, ok: true, result: {} });
  await new Promise(r => setTimeout(r, 0));
  const afterFirst = iTurn.byClass('assistant').map(htmlOf).join('');
  assert(afterFirst.includes('总结：补 TZ'), '首次收尾提升结论');
  assert(!afterFirst.includes('我先看容器'), '首次收尾不把过程叙述当结论');

  // 下一条消息触发二次收尾（newTurn→finishTurn）
  byId.get('input').value = '下一轮';
  byId.get('sendBtn').onclick();
  await new Promise(r => setTimeout(r, 0));
  const afterSecond = iTurn.byClass('assistant').map(htmlOf).join('');
  assert(afterSecond === afterFirst, '二次收尾不改变结论区，实际 ' + JSON.stringify(afterSecond));
  assert(!afterSecond.includes('我先看容器'), '二次收尾不把过程叙述搬进结论区');
  assert(iTurn.querySelector('.wr-rows').byClass('wr-text').length === 2,
    '中间叙述仍在折叠区内，实际 ' + iTurn.querySelector('.wr-rows').byClass('wr-text').length);
}

console.log(fail ? '\n=== 流式测试存在失败 ===' : '\n=== 流式测试全部通过 ===');
process.exit(fail);
