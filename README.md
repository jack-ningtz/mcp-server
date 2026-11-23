# 今日待办 MCP App

把「今日待办」接入 WorkBuddy：既能在**对话里直接说**让 AI 管理待办，也能打开一个可交互的面板直接点选。

## 组成

| 文件 | 作用 |
|---|---|
| `server.js` | 本地 MCP Server（stdio），注册工具 + 提示词 + 挂载 `ui://daily-todo/board` 交互面板 |
| `widget.html` | 面板 UI（新增 / 勾选 / 删除 / 剩余计数 / 筛选 / 清除已完成），跟随明暗主题、手机可用 |
| `todos.json` | 本地数据文件（首次运行自动生成） |
| `server-http.js` / `oauth-provider.js` / `store.js` | 云端 HTTP MCP + OAuth 2.1（供连接器/Buddy 应用远程调用） |
| `render.yaml` | Render 免费 HTTPS 托管的一键部署配置 |
| `set-domain.js` | 拿到公网域名后自动回填连接器与 Buddy 应用配置 |

工具清单：`show_todo_board`、`list_todos`、`add_todo`、`toggle_todo`、`delete_todo`、`clear_done_todos`。

## 提示词（Prompts）

MCP Server 声明了 `prompts` 能力，内置 4 条可被客户端列出、在对话中调用的提示词模板。每条提示词都对模型写明了「先调哪个工具、如何处理结果」的规则，形成「提示词 → 工具」链路：

| 提示词 | 作用 |
|---|---|
| `morning_plan` | 晨间规划：列出待办并按优先级分组排序，最后打开面板 |
| `daily_review` | 每日复盘：统计完成率、总结并询问是否清理已完成（不擅自清除） |
| `quick_capture` | 快速记录：把一句话里的多件事拆成多条待办（参数 `text`，必填） |
| `status_report` | 一句话速报：文字告诉用户还剩几件事、分别是什么 |

说明：提示词能否在界面里直接点选，取决于 WorkBuddy 是否暴露 MCP prompts 入口；无论界面是否展示，强化后的工具描述都会持续影响模型对工具的调用判断。

## 运行身份与数据

- **身份**：MCP Server 由 WorkBuddy 桌面端以**当前已登录的 WorkBuddy 账号**拉起，无需二次输入账号密码。
- **数据**：采用本地运行模式，待办保存在本机 `todos.json`。浏览器端网页（另一个交付物）使用 WorkBuddy 账号单点登录，数据存云数据库、按账号隔离。

> 说明：本地 stdio 进程无法完成浏览器内的 OAuth 跳转，因此 MCP 侧使用本地存储；网页侧使用云端存储 + WorkBuddy 账号 SSO。两者独立。

## 接入 WorkBuddy

配置已合并进 `C:\Users\Administrator\.workbuddy\mcp.json`（保留了原有条目）：

```json
"daily-todo": {
  "command": "node",
  "args": ["D:/WorkBuddyDemo/mcp-server/server.js"],
  "description": "今日待办 MCP App（对话内交互面板 + 新增/勾选/删除/计数）"
}
```

## 启用步骤

1. 彻底重启 WorkBuddy。
2. 打开连接器管理页，找到 `daily-todo`，点「信任」启用，状态变绿。
3. 在对话里试：
   - 「打开今日待办」→ 出现交互面板
   - 「添加一个待办：下午三点开会」
   - 「我还有几件事没做？」→ AI 调用 `list_todos` 回答
   - 「把 下午三点开会 标记完成」
   - 面板里可直接输入新增、点方框勾选、点 × 删除

## 自检

```bash
cd D:/WorkBuddyDemo/mcp-server
node test-client.js          # MCP 协议 + 工具 CRUD
node widget-render-test.js   # 面板渲染 + XSS 转义
```

已通过：工具清单、UI 资源 MIME（`text/html;profile=mcp-app`）、新增 trim、剩余计数、勾选、删除、空白拦截；prompts 的列出、参数占位符替换、必填参数校验；面板在 SDK 不可用时仍能渲染 todos.json 快照、筛选交互、恶意文本转义。两个测试都使用临时数据文件（环境变量 `TODO_DATA_FILE`），不会改动真实 `todos.json`。

## 机制要点（改造自己的应用时参考）

- 工具在 `_meta.ui.resourceUri` 声明界面资源；资源的 MIME 必须是 `text/html;profile=mcp-app`。
- 工具结果用 `structuredContent` 推数据给面板，用 `content[].text` 给模型读。
- 面板通过 `@modelcontextprotocol/ext-apps` 的 `App.callServerTool()` 反向调用工具；因从 esm.sh 加载脚本，CSP 需放行 `resourceDomains` / `connectDomains`。
- **打开面板时，`server.js` 会把 `todos.json` 的当前快照注入 `widget.html` 的 `INITIAL` 常量**。这样即使 SDK 连接失败或工具结果推送早于连接建立，面板也能立即渲染数据（状态显示「快照模式」），连接成功后主动拉一次最新数据覆盖。注入前对 `< > &` 做了 Unicode 转义，防止任务文本里的 `</script>` 破坏页面。
- 面板数据提取 `extractData()` 兼容 `structuredContent`、包裹的 `result` 及 JSON 字符串多种形态。
- 没有 MCP 宿主的普通浏览器里会自动降级为内置数据的预览模式，方便单独调试 UI。
