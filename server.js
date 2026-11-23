/* ============================================================
 * 今日待办 — 本地 MCP Server（stdio）
 *
 * 暴露待办工具供 WorkBuddy 在对话里直接调用，并挂载一个
 * 可交互的 MCP App 面板（ui://daily-todo/board）。
 *
 * 运行身份：由 WorkBuddy 桌面端以当前 WorkBuddy 账号身份拉起。
 * 数据存储：本地 JSON 文件（本地运行模式，无需浏览器 OAuth）。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const UI_MIME = 'text/html;profile=mcp-app';
const BOARD_URI = 'ui://daily-todo/board';
const WIDGET_TEMPLATE = fs.readFileSync(path.join(__dirname, 'widget.html'), 'utf8');
const INITIAL_MARKER = '/*__INITIAL_DATA__*/null';
// 允许通过环境变量指定数据文件（测试用），默认使用同目录 todos.json
const DATA_FILE = process.env.TODO_DATA_FILE || path.join(__dirname, 'todos.json');

/* ---------------- 本地数据存储 ---------------- */
function loadTodos() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveTodos(todos) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(todos, null, 2), 'utf8');
}

function uid() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function snapshot() {
  const todos = loadTodos().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const remaining = todos.filter(t => !t.done).length;
  return { todos, remaining, done: todos.length - remaining };
}

/* ---------------- 工具实现 ---------------- */
function addTodo(text) {
  const clean = (text || '').trim();
  if (!clean) return { error: '任务内容不能为空' };
  const todos = loadTodos();
  todos.unshift({ id: uid(), text: clean, done: false, createdAt: Date.now() });
  saveTodos(todos);
  return snapshot();
}

function toggleTodo(id, done) {
  const todos = loadTodos();
  const item = todos.find(t => t.id === id);
  if (!item) return { error: '未找到该任务' };
  item.done = typeof done === 'boolean' ? done : !item.done;
  saveTodos(todos);
  return snapshot();
}

function deleteTodo(id) {
  const todos = loadTodos();
  const next = todos.filter(t => t.id !== id);
  if (next.length === todos.length) return { error: '未找到该任务' };
  saveTodos(next);
  return snapshot();
}

function clearDone() {
  const todos = loadTodos().filter(t => !t.done);
  saveTodos(todos);
  return snapshot();
}

/* ---------------- MCP Server ---------------- */
const server = new Server(
  { name: 'daily-todo', version: '1.1.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

const boardMeta = { ui: { resourceUri: BOARD_URI } };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'show_todo_board',
      description: '打开今日待办的可交互面板，展示全部任务、剩余计数与进度，用户可直接在面板上勾选/删除/新增。当用户说“打开待办”“看看今日待办”“待办清单”“打开面板”等想查看界面的意图时使用。注意：用户只是想知道“有哪些待办/还剩几件”时用 list_todos 即可，不必打开面板。',
      inputSchema: { type: 'object', properties: {} },
      _meta: boardMeta,
    },
    {
      name: 'list_todos',
      description: '以文字列出当前全部待办任务及剩余未完成数量。当用户问“有哪些待办”“还剩几件事”“说说我的待办”等只需文字回答、不需要界面时使用。返回内容包含每条任务的 id，供后续勾选/删除使用。',
      inputSchema: { type: 'object', properties: {} },
      _meta: boardMeta,
    },
    {
      name: 'add_todo',
      description: '新增一条待办任务。当用户说“添加一个待办：买牛奶”“记一下要做XX”“提醒我XX”等要把新事项记下来的意图时使用。任务内容来自用户原话，去掉首尾空格；空白内容不会添加。不要自作主张添加用户没说过的事。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '任务内容，取自用户描述，不能为空' } },
        required: ['text'],
      },
      _meta: boardMeta,
    },
    {
      name: 'toggle_todo',
      description: '勾选完成或取消完成一条待办。当用户说“把XX标记完成”“XX做完了”“取消完成XX”等改变完成状态的意图时使用。优先用 list_todos 返回的任务 id；如果用户只给了任务名称，先用 list_todos 找到对应 id 再调用。done=true 标记完成，done=false 标记未完成，省略则反转当前状态。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id，来自 list_todos 或面板' },
          done: { type: 'boolean', description: 'true 标记完成，false 标记未完成；省略则反转' },
        },
        required: ['id'],
      },
      _meta: boardMeta,
    },
    {
      name: 'delete_todo',
      description: '永久删除一条待办任务。仅当用户明确说“删除XX”“去掉XX”“不要XX了”等删除意图时使用，不要在标记完成时误用此工具。如果用户只给了任务名称，先用 list_todos 找到对应 id 再调用。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '要删除的任务 id' } },
        required: ['id'],
      },
      _meta: boardMeta,
    },
    {
      name: 'clear_done_todos',
      description: '清除所有已完成的待办任务（批量）。仅当用户明确要求“清除已完成”“清理做完的”时使用，不要自行调用。不可撤销，操作前如有必要先向用户确认。',
      inputSchema: { type: 'object', properties: {} },
      _meta: boardMeta,
    },
  ],
}));

function toolResult(data, errorText) {
  const s = data && data.todos ? data : snapshot();
  if (errorText) {
    return {
      content: [{ type: 'text', text: errorText }],
      structuredContent: s,
      _meta: boardMeta,
      isError: true,
    };
  }
  const remaining = s.remaining;
  const summary = remaining === 0
    ? '今日待办已全部完成，共 ' + s.todos.length + ' 项。'
    : '还有 ' + remaining + ' 项待完成，' + s.done + ' 项已完成。';
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: s,
    _meta: boardMeta,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  switch (name) {
    case 'show_todo_board':
    case 'list_todos':
      return toolResult(snapshot());
    case 'add_todo': {
      const r = addTodo(args.text);
      return r.error ? toolResult(snapshot(), r.error) : toolResult(r);
    }
    case 'toggle_todo': {
      const r = toggleTodo(args.id, args.done);
      return r.error ? toolResult(snapshot(), r.error) : toolResult(r);
    }
    case 'delete_todo': {
      const r = deleteTodo(args.id);
      return r.error ? toolResult(snapshot(), r.error) : toolResult(r);
    }
    case 'clear_done_todos':
      return toolResult(clearDone());
    default:
      throw new Error('未知工具：' + name);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: BOARD_URI, name: '今日待办面板', mimeType: UI_MIME }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === BOARD_URI) {
    // 打开面板时把当前待办快照直接注入 HTML，面板无需等待 SDK 连接即可渲染
    // 转义 < > & 防止任务文本中的 </script> 破坏内联脚本
    const safeJson = JSON.stringify(snapshot())
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const html = WIDGET_TEMPLATE.includes(INITIAL_MARKER)
      ? WIDGET_TEMPLATE.replace(INITIAL_MARKER, safeJson)
      : WIDGET_TEMPLATE;
    return {
      contents: [{
        uri: BOARD_URI,
        text: html,
        mimeType: UI_MIME,
        _meta: {
          ui: {
            csp: {
              resourceDomains: ['https://esm.sh'],
              connectDomains: ['https://esm.sh'],
            },
            permissions: {},
            prefersBorder: true,
          },
        },
      }],
    };
  }
  throw new Error('未知资源：' + req.params.uri);
});

/* ---------------- 提示词（MCP prompts） ----------------
 * 提示词是可被客户端列出、由用户选择后注入对话的模板。
 * 每条 message 的 content.text 就是注入给模型的指令，
 * 其中引导模型去调用上面已有的 tools，形成“提示词 → 工具”的链路。
 * --------------------------------------------------- */
const PROMPTS = [
  {
    name: 'morning_plan',
    description: '晨间规划：查看今日全部待办，按优先级给出执行顺序建议，并打开面板方便逐项勾选。',
    arguments: [],
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: '请帮我规划今天：\n' +
          '1. 先调用 list_todos 获取全部待办（含 id 与完成状态）。\n' +
          '2. 用简洁的中文，把未完成任务按“紧急且重要 → 重要不紧急 → 其他”分成三组，给出建议的执行顺序；已完成任务一句话带过即可。\n' +
          '3. 如果任务为空，提示我添加今天要做的事。\n' +
          '4. 最后调用 show_todo_board 打开面板，方便我边做边勾选。\n' +
          '不要虚构任务，只基于 list_todos 返回的内容。',
      },
    }],
  },
  {
    name: 'daily_review',
    description: '每日复盘：统计今日完成与剩余，给出鼓励和明天的提醒，并清理已完成项。',
    arguments: [],
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: '请帮我做今日复盘：\n' +
          '1. 调用 list_todos 获取当前待办，统计已完成、未完成的数量与完成率。\n' +
          '2. 用温和鼓励的中文总结：肯定已完成的部分，列出未完成的部分。\n' +
          '3. 如果全部完成，明确祝贺；如果还有未完成，挑最重要的 1-2 件提醒我明天优先处理。\n' +
          '4. 询问我是否要调用 clear_done_todos 清除已完成项——在我确认之前不要自行清除。\n' +
          '不要虚构数据，只基于工具返回的结果。',
      },
    }],
  },
  {
    name: 'quick_capture',
    description: '快速记录：把一段文字拆解成多条待办一次性记下来（适合一句话里有多件事）。',
    arguments: [{
      name: 'text',
      description: '要记录的原始内容，例如“下午开会、买牛奶、写周报”',
      required: true,
    }],
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: '请把下面这段内容拆解成一条条待办，并逐条调用 add_todo 记录下来：\n\n{{text}}\n\n' +
          '要求：\n' +
          '- 按逗号、顿号、分号或换行切分；每条保持原意，不要合并或改写措辞。\n' +
          '- 忽略空白项，不要添加内容里没有的事项。\n' +
          '- 全部添加完成后，调用 list_todos 复核，并用中文简要列出已记录的任务。',
      },
    }],
  },
  {
    name: 'status_report',
    description: '一句话速报：不问界面，直接用文字告诉我还剩几件事、分别是什么。',
    arguments: [],
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: '调用 list_todos，然后用一句简洁的中文告诉我：还剩几项待完成、分别是什么。' +
          '如果都已做完，就说今天的任务全部完成了。不要打开面板，也不要虚构任务。',
      },
    }],
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map(p => ({
    name: p.name,
    description: p.description,
    ...(p.arguments && p.arguments.length ? { arguments: p.arguments } : {}),
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params || {};
  const prompt = PROMPTS.find(p => p.name === name);
  if (!prompt) throw new Error('未知提示词：' + name);

  // 校验必填参数
  for (const a of prompt.arguments || []) {
    if (a.required && !(args[a.name] !== undefined && String(args[a.name]).trim() !== '')) {
      throw new Error('缺少必填参数：' + a.name);
    }
  }

  // 用 {{arg}} 占位符替换；未提供的可选参数替换为空串
  const messages = prompt.messages.map(m => ({
    role: m.role,
    content: {
      type: 'text',
      text: String(m.content.text).replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const v = args[key];
        return v === undefined || v === null ? '' : String(v);
      }),
    },
  }));

  return { description: prompt.description, messages };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[daily-todo] MCP server started');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
