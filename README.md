# kiro-lan-remote

通过局域网浏览器远程查看和操作本机 Kiro Agent 会话的独立网关。

项目运行在 Windows 本机上：Node.js 服务端连接本机 Kiro Agent Mux，手机或局域网内其他浏览器通过 WebSocket 连接服务端，完成会话列表、实时对话、历史回放、取消任务、权限确认和断线恢复。

> **安全提示**：这个项目可以驱动本机 Kiro Agent 读写文件、执行命令。默认只适合可信局域网使用。请使用随机访问密钥，并在不使用时停止服务。

## 功能

- 局域网浏览器访问 Kiro Agent 会话
- 多会话列表与工作区分组
- 实时流式回答、思考过程和工具调用展示
- 工具输出、diff 和终端输出查看
- 新建会话、发送消息、取消当前任务
- 权限请求转交手机端确认
- `session.load` 历史回放
- 断线后的 `events.resume` 增量恢复
- 回放帧与实时帧隔离，避免其他连接的历史加载污染当前页面
- Vue 3 + Pinia 状态投影架构
- Vite 单文件构建，运行时只需要一个 HTML 产物

## 环境要求

- Windows 10 或更高版本
- Node.js 20 或更高版本
- 本机已安装并运行 Kiro
- 当前用户有权限读取 Kiro 扩展宿主进程信息

## 安装

```powershell
npm install
```

## 构建

服务端通过 `public/index.html` 提供前端页面。修改 `src/` 后需要重新构建：

```powershell
npm run build
```

构建会生成单文件产物：

```text
public/index.html
```

## 启动

直接启动：

```powershell
npm start
```

服务端会自动发现 Kiro 扩展宿主和本地 Agent Mux，并在控制台输出访问地址，例如：

```text
http://192.168.x.x:8790/?key=<access-key>
```

### 自定义配置

可通过环境变量覆盖默认配置：

```powershell
$env:PORT = "8790"
$env:HOST = "0.0.0.0"
$env:ACCESS_KEY = "请替换为随机密钥"
npm start
```

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8790` | HTTP/WebSocket 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ACCESS_KEY` | 启动时随机生成 | 浏览器 WebSocket 访问密钥；建议显式设置随机值 |
| `PERMISSION_POLICY` | `ask` | 权限策略：`ask`、`allow-once`、`allow-always`、`reject` |
| `AUTO_DISCOVER` | `true` | 是否自动发现 Kiro Agent Mux |
| `KIRO_MUX_PORT` | 空 | 手动指定 Mux 端口 |
| `KIRO_MUX_TOKEN` | 空 | 手动指定 Mux token |
| `MODEL_ID` | 空 | 新建会话使用的模型 ID |

如果手动指定 Mux：

```powershell
$env:KIRO_MUX_PORT = "64155"
$env:KIRO_MUX_TOKEN = "你的 mux token"
npm start
```

## 开发

启动 Vite 开发服务：

```powershell
npm run dev
```

开发服务默认监听 `5174`，并将 `/ws` 与 `/healthz` 代理到 `8790` 后端。正式运行仍应使用 `npm run build` 后的 `npm start`。

## 测试与检查

```powershell
# TypeScript / Vue 类型检查
npm run typecheck

# 单元测试
npm run test:unit

# 构建并检查单文件运行产物
npm run test:contract

# 集成投影测试
node --test test/integration/projection.test.mjs

# 权限与断线补发契约测试
node --test test/contract-perm-resume.test.mjs
```

当前代码包含以下主要验证范围：

- 事件路由与会话过滤
- replay / resume 语义
- 回合收尾与幂等性
- 工具调用和耗时投影
- Markdown 渲染与安全转义
- 权限请求队列
- 断线事件补发
- Vue 组件 SSR 冒烟渲染

## 项目结构

```text
kiro-lan-remote/
├─ discover.ps1              # 发现 Kiro 扩展宿主和 Mux 端口
├─ memscan.ps1               # 只读扫描进程内存中的 Mux token 候选
├─ server.mjs                # HTTP/WebSocket 网关
├─ index.html                # Vite 源入口
├─ public/index.html         # Vite 生成的单文件运行产物
├─ lib/
│  ├─ discover.mjs           # Mux 发现逻辑
│  ├─ miniws.mjs             # 极简 WebSocket 实现
│  └─ muxClient.mjs          # ACP/Mux 客户端和事件归一化
├─ src/
│  ├─ app/                   # 应用启动和业务动作编排
│  ├─ components/            # Vue UI 组件
│  ├─ composables/           # WebSocket、滚动、剪贴板等组合逻辑
│  ├─ domain/                # 事件路由、回合和消息领域模型
│  ├─ protocol/              # 浏览器端协议类型与解析守卫
│  ├─ stores/                # Pinia 状态
│  └─ utils/                 # Markdown、路径、时间等工具
├─ test/                     # 单元、集成、契约和组件测试
├─ package.json
├─ tsconfig.json
└─ vite.config.ts
```

## 协议与权限说明

服务端以 observer 角色连接本机 Kiro Agent Mux。浏览器端命令通过服务端转发，Kiro 下发的 `session/update` 会先在服务端归一化，再由前端事件 reducer 投影到 Pinia 状态。

历史回放帧只投递给发起对应 `session.load` 的浏览器连接，不写入断线补发缓冲；实时事件仍按会话广播，由前端按 `sessionId` 过滤。权限请求默认进入手机端 FIFO 队列，由用户选择后转交 Kiro。

## 许可证

本项目使用 [MIT License](LICENSE)。
