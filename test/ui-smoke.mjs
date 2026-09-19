/**
 * 组件层 UI 冒烟测试。
 *
 * 背景：本文件原本对 public/index.html 的旧版内联脚本做 DOM stub 断言；
 * 阶段 7 删除旧前端后 public/index.html 已是 Vite 单文件构建产物，
 * 旧断言目标不复存在，且「禁止 npm run build」的约束下构建产物永远
 * 覆盖不到新代码。现改用既有依赖（vite ssrLoadModule + @vue/server-renderer）
 * 直接渲染 src 下的组件源码，对渲染出的 HTML 做断言 —— 与旧脚本同为
 * 冒烟粒度：验证关键 UI 结构与状态渲染，不覆盖浏览器内交互。
 *
 * 范围说明：键盘导航、点击展开/收起等交互行为无法在 SSR 中模拟，
 * 由组件内逻辑 + vue-tsc 保证；浏览器级验证按开发文档 §8.9 验收矩阵执行。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { createPinia, setActivePinia } from 'pinia';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';

// 项目根（test/ 的上一级）；注意不能用 dirname(URL('..'))，会多退一层
const root = fileURLToPath(new URL('../', import.meta.url));

let fail = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    fail = 1;
  } else console.log('ok:', msg);
};

// —— SSR 环境垫片 ——
// Composer 的 setup 阶段直接 document.addEventListener；
// MarkdownBlock 的 immediate watch 走 rAF（同步执行，让渲染在本次 renderToString 内完成）。
// App.vue 的 setup 读 location.search 并用 matchMedia 求值桌面断点；
// __mqMatches 由各测试段落赋值，模拟桌面（true）/窄视口（false）。
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  body: {},
};
globalThis.location = { search: '' };
globalThis.__mqMatches = false;
globalThis.window = {
  matchMedia: () => ({
    matches: globalThis.__mqMatches,
    addEventListener() {},
    removeEventListener() {},
  }),
};
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 0;
};
globalThis.cancelAnimationFrame = () => {};

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  const load = (p) => server.ssrLoadModule(p);

  const MarkdownBlock = (await load('/src/components/markdown/MarkdownBlock.vue')).default;
  const WorkProcess = (await load('/src/components/conversation/WorkProcess.vue')).default;
  const ToolCallRow = (await load('/src/components/conversation/ToolCallRow.vue')).default;
  const PermissionSheet = (await load('/src/components/permission/PermissionSheet.vue')).default;
  const SessionRow = (await load('/src/components/sessions/SessionRow.vue')).default;
  const MessageActions = (await load('/src/components/conversation/MessageActions.vue')).default;
  const Composer = (await load('/src/components/composer/Composer.vue')).default;
  const SlashMenu = (await load('/src/components/composer/SlashMenu.vue')).default;
  const ConversationView = (await load('/src/components/conversation/ConversationView.vue')).default;
  const AppComp = (await load('/src/App.vue')).default;
  const { filterSlashCommands, normalizeCommands } = await load('/src/components/composer/slashCommands.ts');
  const { formatRelative } = await load('/src/utils/time.ts');
  const { usePermissionStore } = await load('/src/stores/permission.ts');
  const { useSessionStore } = await load('/src/stores/session.ts');
  const { useConfigStore } = await load('/src/stores/config.ts');
  const { useConversationStore } = await load('/src/stores/conversation.ts');

  /** 渲染单个组件：独立 pinia，setupStores 钩子里预置 store 状态。 */
  async function renderComp(comp, props, setupStores) {
    const pinia = createPinia();
    setActivePinia(pinia);
    if (setupStores) setupStores();
    const app = createSSRApp({ render: () => h(comp, props) });
    app.use(pinia);
    return renderToString(app);
  }

  // ===== 基础渲染（旧冒烟断言的组件层等价物） =====
  const htmlMd = await renderComp(MarkdownBlock, { raw: '## 结论\n第一行' });
  assert(htmlMd.includes('md-h md-h2'), '标题渲染为 md-h2');
  assert(htmlMd.includes('md-p'), '正文渲染为段落');

  // ===== WorkProcess：思考块 =====
  const NOW = 1_000_000 + 12_000; // 固定时钟
  const thoughtBlock = (over = {}) => ({
    type: 'thought',
    id: 'th_1',
    raw: '先检查配置文件',
    streaming: false,
    closed: true,
    replay: false,
    startedAt: NOW - 4000,
    frozenMs: 4000,
    ...over,
  });
  const toolBlock = (over = {}) => ({
    type: 'tool',
    id: 'tool_1',
    toolCallId: 't1',
    title: '终端',
    status: 'completed',
    rawInput: { command: 'ls' },
    expandable: true,
    expanded: false,
    replay: false,
    startedAt: null,
    finishedMs: null,
    output: [],
    waiting: false,
    ...over,
  });
  const makeTurn = (process, over = {}) => ({
    type: 'turn',
    id: 'turn_1',
    sessionId: 's1',
    userMessage: null,
    answer: null,
    process,
    workVisible: true,
    panelVisible: true,
    expanded: true,
    actionsVisible: false,
    actionTime: null,
    status: 'completed',
    settled: true,
    startedAt: null,
    frozenMs: null,
    finishedAt: null,
    stopReason: null,
    toolCount: 0,
    thoughtCount: 0,
    replay: false,
    ...over,
  });

  const htmlThought = await renderComp(WorkProcess, { turn: makeTurn([thoughtBlock()]), now: NOW });
  assert(htmlThought.includes('wr-thought'), '含 ThoughtBlock 的回合渲染出 .wr-thought');
  assert(htmlThought.includes('先检查配置文件'), '思考文本进入渲染');
  assert(htmlThought.includes('stream-in'), '实时思考块带流式淡入');
  assert(htmlThought.includes('已思考 4 秒'), '思考块封口后折叠标题报已思考时长');

  const htmlThoughtReplay = await renderComp(WorkProcess, {
    turn: makeTurn([thoughtBlock({ replay: true, startedAt: null, frozenMs: null })]),
    now: NOW,
  });
  assert(!htmlThoughtReplay.includes('stream-in'), '回放思考块无流式淡入');
  assert(!htmlThoughtReplay.includes('已思考'), '回放思考块无可信计时不报假时长');

  const htmlThinking = await renderComp(WorkProcess, {
    turn: makeTurn([thoughtBlock({ closed: false, frozenMs: null })]),
    now: NOW,
  });
  assert(htmlThinking.includes('思考中…'), '有未闭合思考块时折叠标题显示思考中');

  const htmlMixed = await renderComp(WorkProcess, {
    turn: makeTurn([thoughtBlock(), toolBlock({ title: '读文件' })], { toolCount: 1 }),
    now: NOW,
  });
  assert(
    htmlMixed.includes('已思考 4 秒 · 1 次工具调用'),
    '折叠标题思考段与工具次数并用: ' + (htmlMixed.match(/已思考[^<]*/) || [''])[0]
  );

  // ===== ToolCallRow：耗时 / 等待徽标 / 结构化输出 =====
  const htmlWait = await renderComp(ToolCallRow, {
    block: toolBlock({ status: 'in_progress', waiting: true }),
    now: NOW,
  });
  assert(htmlWait.includes('wr-wait') && htmlWait.includes('等待确认'), 'waiting 的工具行出现等待确认徽标');
  assert(!htmlWait.includes('wr-dur'), '等待确认时不显示运行时长');
  assert(!htmlWait.includes('进行中'), '等待确认时不叠加「进行中」后缀');

  const htmlFrozen = await renderComp(ToolCallRow, { block: toolBlock({ finishedMs: 65_000 }) });
  assert(htmlFrozen.includes('wr-dur') && htmlFrozen.includes('1 分 5 秒'), '完成工具行显示定格耗时');
  assert(htmlFrozen.includes('wr-status') && htmlFrozen.includes('· 已完成'), 'completed 工具行补「· 已完成」状态后缀');

  const htmlRun = await renderComp(ToolCallRow, {
    block: toolBlock({ status: 'in_progress', startedAt: NOW - 30_000 }),
    now: NOW,
  });
  assert(htmlRun.includes('30 秒'), '运行中工具行按 now 起点显示实时耗时');
  assert(htmlRun.includes('· 进行中'), '运行中工具行补「· 进行中」状态后缀');

  const htmlFailRow = await renderComp(ToolCallRow, { block: toolBlock({ status: 'failed' }) });
  assert(htmlFailRow.includes('wr-fail') && !htmlFailRow.includes('wr-status'), 'failed 保留红色失败徽标且不叠加状态后缀');

  const htmlNoClock = await renderComp(ToolCallRow, {
    block: toolBlock({ status: 'in_progress', startedAt: NOW - 30_000 }),
  });
  assert(!htmlNoClock.includes('wr-dur'), '无时钟不显示运行中耗时');

  const htmlOut = await renderComp(ToolCallRow, {
    block: toolBlock({
      expandable: false,
      rawInput: undefined,
      expanded: true,
      output: [{ type: 'terminal', text: 'hello\nworld' }],
    }),
  });
  assert(htmlOut.includes('wr-trig'), '无入参但有输出的工具行可展开');
  assert(htmlOut.includes('wr-out-pre') && htmlOut.includes('hello'), '终端输出进入 pre');

  const htmlOutNone = await renderComp(ToolCallRow, {
    block: toolBlock({ expandable: false, rawInput: undefined, expanded: true, output: [{ type: 'terminal' }] }),
  });
  assert(htmlOutNone.includes('终端输出不可用'), '空终端输出显示安静提示');

  const htmlDiff = await renderComp(ToolCallRow, {
    block: toolBlock({
      expandable: false,
      rawInput: undefined,
      expanded: true,
      output: [{ type: 'diff', path: 'src/a.ts', oldText: 'a\nb', newText: 'a\nb\nc' }],
    }),
  });
  assert(
    htmlDiff.includes('src/a.ts') && htmlDiff.includes('+3') && htmlDiff.includes('−2'),
    'diff 显示路径标题与 +N/−M 行数摘要'
  );
  assert(htmlDiff.includes('wr-out-pre'), 'diff 内容进入 pre');

  const htmlTextOut = await renderComp(ToolCallRow, {
    block: toolBlock({ expanded: true, output: [{ type: 'text', text: '执行完成' }] }),
  });
  assert(htmlTextOut.includes('wr-out-pre') && htmlTextOut.includes('执行完成'), 'text 输出进入 pre');

  const htmlQuiet = await renderComp(ToolCallRow, { block: toolBlock({ expandable: false, rawInput: undefined }) });
  assert(!htmlQuiet.includes('wr-trig') && !htmlQuiet.includes('wr-det'), '无入参且无输出仍是安静行');

  const htmlEsc = await renderComp(ToolCallRow, {
    block: toolBlock({ expanded: true, rawInput: { path: '<img src=x>' } }),
  });
  assert(!htmlEsc.includes('<img'), '入参以文本渲染，不注入 HTML');

  // ===== PermissionSheet：sessionTitle =====
  const permOptions = [
    { optionId: 'allow_once', name: '允许本次', kind: 'allow_once' },
    { optionId: 'reject_once', name: '拒绝本次', kind: 'reject_once' },
  ];
  const htmlPerm = await renderComp(PermissionSheet, {}, () => {
    usePermissionStore().open({
      reqId: 'r1',
      sessionId: 's1',
      turnId: null,
      toolCall: { toolCallId: 't1', title: '写文件', rawInput: { path: 'a.ts' } },
      options: permOptions,
      sessionTitle: '排查会话',
    });
  });
  assert(htmlPerm.includes('会话：排查会话'), '权限面板头部显示归属会话标题');
  assert(htmlPerm.includes('写文件'), '工具标题保留');
  assert(htmlPerm.includes('允许本次') && htmlPerm.includes('拒绝本次'), '允许/拒绝选项保留');
  assert(htmlPerm.includes('暂不处理（交由电脑端决定）'), '「交由电脑端决定」语义保留');

  const htmlPermNoTitle = await renderComp(PermissionSheet, {}, () => {
    usePermissionStore().open({
      reqId: 'r2',
      sessionId: 's1',
      turnId: null,
      toolCall: { toolCallId: 't2', title: '执行' },
      options: permOptions,
    });
  });
  assert(!htmlPermNoTitle.includes('sheet-session'), 'sessionTitle 缺失时不渲染会话行');

  // ===== SessionRow：实时运行徽章 =====
  const baseSession = {
    sessionId: 's1',
    cwd: 'D:\\demo',
    title: '排查',
    status: 'completed',
    updatedAt: '2026-09-18T10:00:00Z',
  };
  const htmlLive = await renderComp(SessionRow, { session: baseSession }, () => {
    useSessionStore().markLive('s1', 'running');
  });
  assert(htmlLive.includes('pill-run') && htmlLive.includes('运行中'), 'liveStatus=running 显示运行中徽章');
  assert(htmlLive.includes('live-dot'), '运行徽章带低噪声脉动点');
  assert(!htmlLive.includes('已完成'), '实时运行覆盖快照 completed 显示');

  const htmlEnded = await renderComp(SessionRow, { session: baseSession }, () => {
    useSessionStore().markLive('s1', 'ended');
  });
  assert(htmlEnded.includes('已完成') && !htmlEnded.includes('live-dot'), 'ended 回退快照显示');

  const htmlNoLive = await renderComp(SessionRow, { session: baseSession });
  assert(htmlNoLive.includes('已完成'), '无实时记录回退快照显示');

  const htmlOverride = await renderComp(
    SessionRow,
    { session: { ...baseSession, status: 'in_progress' } },
    () => {
      useSessionStore().markLive('s1', 'running');
    }
  );
  assert((htmlOverride.match(/>运行中</g) || []).length === 1, '实时徽章覆盖快照 in_progress 而不重复');

  // A3/A4：行时间改相对格式；官方两种宽度都无摘要 → 摘要行移除
  const htmlRelative = await renderComp(SessionRow, {
    session: { ...baseSession, updatedAt: new Date(Date.now() - 30_000).toISOString() },
  });
  assert(htmlRelative.includes('刚刚'), '会话行时间改用相对时间（刚刚）');
  const htmlNoDesc = await renderComp(SessionRow, {
    session: { ...baseSession, description: '这是一段摘要' },
  });
  assert(!htmlNoDesc.includes('task-desc') && !htmlNoDesc.includes('这是一段摘要'), '会话行不再渲染摘要行');

  // ===== 斜杠命令 =====
  const rawCmds = [
    { name: '/plan', description: '规划任务' },
    '/run',
    { command: '/exec cmd', description: '执行命令' },
    { value: '/other' },
    42,
    { nope: 1 },
    { name: '/plan', description: '重复项' },
  ];
  const names = normalizeCommands(rawCmds).map((c) => c.name);
  assert(
    JSON.stringify(names) === JSON.stringify(['/plan', '/run', '/exec cmd', '/other']),
    '命令元素 string / {name|command|value} 形态都归一化且去重: ' + JSON.stringify(names)
  );
  assert(filterSlashCommands(rawCmds, '/').length === 4, '裸斜杠列出全部命令');
  assert(filterSlashCommands(rawCmds, '/R').map((c) => c.name).join() === '/run', '前缀过滤大小写不敏感');
  assert(filterSlashCommands(rawCmds, 'run').length === 0, '草稿无斜杠不出现命令');

  const htmlSlash = await renderComp(SlashMenu, { items: filterSlashCommands(rawCmds, '/'), activeIndex: 1 });
  assert(htmlSlash.includes('slash-menu'), '命令菜单渲染 slash-menu');
  assert(htmlSlash.includes('class="active slash-item"') && htmlSlash.includes('aria-selected="true"'), '菜单项带键盘高亮与选中语义');
  assert(htmlSlash.includes('/plan') && htmlSlash.includes('规划任务'), '菜单渲染命令名与描述');

  const htmlComposer = await renderComp(Composer, {}, () => {
    const cfg = useConfigStore();
    cfg.setCommands('s1', rawCmds);
    cfg.setViewed('s1');
    cfg.setModel('m1', 'Model One');
    cfg.absorbFor('s1', [
      { id: 'autopilot', currentValue: 'off', options: [{ value: 'off', name: '自动' }, { value: 'on', name: '完全访问' }] },
      { id: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'Model One' }] },
      { id: 'effortLevel', currentValue: 'high', options: [{ value: 'high', name: '高' }] },
      { id: 'mode', currentValue: 'vibe', options: [{ value: 'vibe', name: 'Vibe' }, { value: 'spec', name: 'Spec' }] },
    ]);
  });
  // SSR 无法键入 '/'：菜单显隐依赖草稿，这里验证空闲态不弹菜单（预置 commands 非空）
  assert(!htmlComposer.includes('slash-menu'), '无斜杠草稿不弹命令菜单（commands 非空）');
  assert(htmlComposer.includes('aria-label="发送"'), 'composer 发送按钮保留');
  assert(htmlComposer.includes('placeholder="继续输入以排队后续修改"'), 'composer 占位文案对齐官方（C2）');
  assert(htmlComposer.includes('model-dot'), '模型按钮文字前带状态绿点（C7）');
  assert(htmlComposer.includes('aria-label="选择模型"') && htmlComposer.includes('>Model One<'), '模型按钮与当前模型名保留');
  assert(htmlComposer.includes('aria-label="思考程度"'), '思考程度按钮保留');
  assert(htmlComposer.includes('aria-label="模式"') && htmlComposer.includes('Vibe'), 'mode 配置项出现模式按钮并显示当前值');

  const htmlComposerNoMode = await renderComp(Composer, {}, () => {
    const cfg = useConfigStore();
    cfg.absorbFor(null, [{ id: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'Model One' }] }]);
  });
  assert(!htmlComposerNoMode.includes('aria-label="模式"'), '无 mode 配置项时隐藏模式按钮');

  // ===== ConversationView：顶栏标题实时跟随 renameSession =====
  {
    const pinia = createPinia();
    setActivePinia(pinia);
    const sessions = useSessionStore();
    sessions.setSessions([{ sessionId: 's1', cwd: 'D:\\demo', title: '旧标题', updatedAt: '' }]);
    sessions.setActive('s1');
    const renderView = async () => {
      const app = createSSRApp({ render: () => h(ConversationView) });
      app.use(pinia);
      return renderToString(app);
    };
    const html1 = await renderView();
    assert(html1.includes('旧标题'), '顶栏标题来自当前会话');
    sessions.renameSession('s1', '新标题');
    const html2 = await renderView();
    assert(html2.includes('新标题') && !html2.includes('旧标题'), 'renameSession 后顶栏标题实时更新');
    // A2：移动顶栏保留返回入口（embedded 才切换为桌面顶栏）
    assert(html1.includes('aria-label="返回会话列表"'), '移动顶栏保留返回按钮');
  }

  // ===== formatRelative：官方相对时间语义 =====
  {
    const nowMs = Date.now();
    assert(formatRelative(nowMs - 30_000) === '刚刚', 'formatRelative 30s 前 → 刚刚');
    assert(formatRelative(nowMs - 90_000) === '1分钟', 'formatRelative 90s 前 → 1分钟');
    assert(formatRelative(nowMs - 2 * 3_600_000) === '2小时', 'formatRelative 2h 前 → 2小时');
    assert(formatRelative(nowMs - 3 * 86_400_000) === '3天', 'formatRelative 3d 前 → 3天');
    const fallback = formatRelative(nowMs - 30 * 86_400_000);
    assert(/\d{1,2}\/\d{1,2}/.test(fallback), 'formatRelative 30d 前回退日期格式: ' + fallback);
    assert(formatRelative('not-a-date') === '', 'formatRelative 非法输入 → 空串');
    assert(formatRelative(nowMs + 60_000) === '刚刚', 'formatRelative 未来时间夹到刚刚');
    assert(formatRelative(null) === '' && formatRelative(undefined) === '', 'formatRelative 空输入 → 空串');
  }

  // ===== MessageActions：复制 + 绝对时间（B3；赞/踩/分叉占位已按用户要求移除） =====
  {
    const turnForActions = makeTurn([], {
      actionsVisible: true,
      actionTime: new Date().toISOString(),
    });
    const htmlActions = await renderComp(MessageActions, {
      turn: turnForActions,
      getAnswerText: () => '答案',
    });
    assert(htmlActions.includes('aria-label="复制回答"'), '操作栏保留复制按钮');
    assert(!htmlActions.includes('暂未开放') && !htmlActions.includes('msg-op-btn'), '赞/踩/分叉占位按钮已移除');
    assert(htmlActions.includes('action-time'), '操作栏保留绝对时间戳');
  }

  // ===== App：桌面双栏壳（matchMedia 模拟）与窄视口单列（A1） =====
  {
    const renderApp = async () => {
      const pinia = createPinia();
      setActivePinia(pinia);
      const vueApp = createSSRApp({ render: () => h(AppComp) });
      vueApp.use(pinia);
      return renderToString(vueApp);
    };
    globalThis.__mqMatches = true;
    const htmlDesk = await renderApp();
    assert(
      htmlDesk.includes('shell-split') && htmlDesk.includes('shell-side') && htmlDesk.includes('shell-main'),
      '桌面 matchMedia 模拟下渲染双栏壳类'
    );
    assert(htmlDesk.includes('side-head') && htmlDesk.includes('新建会话'), '桌面侧栏为紧凑导航行（新建会话 + 会话数副标题）');
    assert(!htmlDesk.includes('Kiro 遥控'), '桌面侧栏不再渲染移动大标题头部');
    assert(htmlDesk.includes('conv-folder') && htmlDesk.includes('aria-label="更多操作"'), '桌面主区顶栏为文件夹图标+溢出占位');
    assert(!htmlDesk.includes('返回会话列表'), '桌面双栏不渲染返回按钮');
    assert(htmlDesk.includes('从左侧选择一个会话，或新建会话'), '桌面无活动会话时渲染空状态');
    assert(htmlDesk.includes('conv-empty-conn'), '空状态带连接状态');

    // 回归：新建会话后 sessionId 已设置但列表尚未包含该会话（等 sessions.list），
    // 空状态判据若依赖 sessions.active（列表成员资格）会永远停留在空状态。
    {
      const piniaNew = createPinia();
      setActivePinia(piniaNew);
      useConversationStore().openSession('new-s1');
      const vueAppNew = createSSRApp({ render: () => h(AppComp) });
      vueAppNew.use(piniaNew);
      const htmlNew = await renderToString(vueAppNew);
      assert(!htmlNew.includes('从左侧选择一个会话，或新建会话'), '新建会话（列表未含）后主区立即渲染对话体');
      assert(htmlNew.includes('>新会话</span>'), '列表查不到标题时顶栏回退「新会话」');
    }

    globalThis.__mqMatches = false;
    const htmlNarrow = await renderApp();
    assert(!htmlNarrow.includes('shell-split'), '窄视口不渲染双栏壳');
    assert(htmlNarrow.includes('Kiro 遥控'), '窄视口保留移动大标题头部');
    assert(!htmlNarrow.includes('已连接到当前桌面窗口'), '窄视口未连接时不出现桌面连接副标题');
    globalThis.__mqMatches = false;
  }

  // ===== CSS 契约：新类就位与 reduced-motion 降级 =====
  const readCss = (f) => fs.readFileSync(path.join(root, 'src/assets/styles', f), 'utf8');
  const convCss = readCss('conversation.css');
  const compCss = readCss('composer.css');
  const sheetsCss = readCss('sheets.css');
  const layoutCss = readCss('layout.css');
  assert(
    convCss.includes('.wr-thought') && convCss.includes('.wr-dur') && convCss.includes('.wr-wait') && convCss.includes('.wr-out-pre'),
    'conversation.css 新类（wr-thought/wr-dur/wr-wait/wr-out-*）就位'
  );
  assert(compCss.includes('.slash-menu') && compCss.includes('.slash-item'), 'composer.css slash 菜单类就位');
  assert(compCss.includes('prefers-reduced-motion'), 'slash 菜单动画带 reduced-motion 降级');
  assert(sheetsCss.includes('.sheet-session'), 'sheets.css 会话标题行类就位');
  assert(layoutCss.includes('.live-dot') && layoutCss.includes('prefers-reduced-motion'), 'layout.css 脉动点类含 reduced-motion 降级');
  // —— UI 对齐阶段新契约（A1/A2/A3/B2/B3/B6/C1/C7） ——
  assert(
    layoutCss.includes('.shell-split') && layoutCss.includes('.shell-side') && layoutCss.includes('.shell-main'),
    'layout.css 双栏壳类就位'
  );
  assert(layoutCss.includes('.side-head') && layoutCss.includes('.side-new-btn'), 'layout.css 侧栏紧凑导航类就位');
  assert(layoutCss.includes('.conv-folder') && layoutCss.includes('.conv-empty'), 'layout.css 桌面顶栏图标与空状态类就位');
  assert(layoutCss.includes('.pill-run') && layoutCss.includes('70,191,114'), '运行中胶囊为绿色语义（官方同款）');
  assert(convCss.includes('.wr-status'), 'conversation.css 工具行状态后缀类就位');
  assert(!convCss.includes('.msg-op-btn'), 'conversation.css 已删除赞/踩/分叉占位样式类');
  assert(convCss.includes('.shell-main #msgs'), 'conversation.css 双栏消息列近满宽规则就位');
  assert(compCss.includes('.model-dot'), 'composer.css 模型绿点类就位');
  assert(compCss.includes('.send-btn.busy') && compCss.includes('#363636'), 'composer.css 发送按钮深色方块与取消态就位');
  assert(compCss.includes('.shell-split .composer-inner'), 'composer.css 双栏 composer 近满宽规则就位');
} finally {
  await server.close();
}

console.log(fail ? '\n=== 冒烟测试存在失败 ===' : '\n=== 冒烟测试全部通过 ===');
process.exitCode = fail;
