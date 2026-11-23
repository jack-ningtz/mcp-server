/* ============================================================
 * 今日待办 — 云端 MCP Server（Streamable HTTP + OAuth 2.1）
 *
 * 用于公网部署，供 WorkBuddy 连接器 / Buddy 应用远程调用。
 * - 传输：StreamableHTTPServerTransport（有状态会话 + SSE 恢复）
 * - 鉴权：OAuth 2.1（authorize/token/register/revoke）+ Bearer + introspect
 * - 数据：按 OAuth token 的 userId 隔离（data/users/<id>.json）
 * - 域名：PUBLIC_URL=auto 时从每个请求的 Host/X-Forwarded-Proto 动态推导，
 *         适配"部署后才分配域名"的发布平台（issuer 始终与访问域名一致）
 *
 * 环境变量：
 *   PORT            服务端口（发布平台注入）
 *   HOST            绑定地址（默认 0.0.0.0）
 *   PUBLIC_URL      固定公网地址；设为 auto 或未设置时动态推导
 *   OAUTH_STRICT    1 开启严格 resource 校验
 *   TODO_DATA_DIR   待办数据目录（默认 data/users）
 *   OAUTH_STATE_FILE OAuth 状态文件（默认 .oauth-state.json）
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { authorizationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/authorize.js');
const { tokenHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/token.js');
const { clientRegistrationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/register.js');
const { revocationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/revoke.js');
const { InMemoryEventStore } = require('@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js');
const {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { PersistentAuthProvider } = require('./oauth-provider.js');
const store = require('./store.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const FIXED_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DYNAMIC = !FIXED_URL || FIXED_URL === 'auto';
const STRICT = process.env.OAUTH_STRICT === '1';
const SCOPES = ['mcp:tools', 'todo.read', 'todo.write'];

/** 从请求推导公网根地址（动态域名模式） */
function baseUrlOf(req) {
  if (!DYNAMIC) return FIXED_URL;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

const UI_MIME = 'text/html;profile=mcp-app';
const BOARD_URI = 'ui://daily-todo/board';
const WIDGET_TEMPLATE = fs.readFileSync(path.join(__dirname, 'widget.html'), 'utf8');
const INITIAL_MARKER = '/*__INITIAL_DATA__*/null';

/* ---------------- 工具 / 资源 / 提示词定义 ---------------- */
const boardMeta = { ui: { resourceUri: BOARD_URI } };

const TOOLS = [
  {
    name: 'show_todo_board',
    description: '打开今日待办的可交互面板，展示全部任务、剩余计数与进度，可直接勾选/删除/新增。用户说“打开待办”“待办清单”“打开面板”等想看界面时用。只想文字回答用 list_todos。',
    inputSchema: { type: 'object', properties: {} },
    _meta: boardMeta,
  },
  {
    name: 'list_todos',
    description: '以文字列出当前用户全部待办及剩余数量。用户问“有哪些待办”“还剩几件事”时用。返回每条 id 供后续勾选/删除。',
    inputSchema: { type: 'object', properties: {} },
    _meta: boardMeta,
  },
  {
    name: 'add_todo',
    description: '新增一条待办。用户说“添加待办：买牛奶”“记一下要做XX”时用。内容取用户原话、去首尾空格，空白不添加。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '任务内容，不能为空' } },
      required: ['text'],
    },
    _meta: boardMeta,
  },
  {
    name: 'toggle_todo',
    description: '勾选完成或取消完成一条待办。用户说“把XX标记完成”“XX做完了”时用。只有任务名时先 list_todos 找 id。done=true 完成，false 未完成，省略则反转。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        done: { type: 'boolean', description: 'true 完成，false 未完成，省略反转' },
      },
      required: ['id'],
    },
    _meta: boardMeta,
  },
  {
    name: 'delete_todo',
    description: '永久删除一条待办。仅当用户明确说“删除XX”“不要XX了”时用，不要在标记完成时误用。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的任务 id' } },
      required: ['id'],
    },
    _meta: boardMeta,
  },
  {
    name: 'clear_done_todos',
    description: '清除所有已完成的待办（批量）。仅当用户明确要求“清除已完成”时用，不可撤销，操作前先确认。',
    inputSchema: { type: 'object', properties: {} },
    _meta: boardMeta,
  },
];

const PROMPTS = [
  {
    name: 'morning_plan', description: '晨间规划：查看今日全部待办，按优先级给出执行顺序建议，并打开面板。',
    arguments: [],
    text: '请帮我规划今天：\n1. 调用 list_todos 获取全部待办。\n2. 把未完成任务按“紧急且重要 → 重要不紧急 → 其他”分组，给出执行顺序。\n3. 任务为空就提示添加。\n4. 最后调用 show_todo_board 打开面板。只基于工具返回内容，不虚构。',
  },
  {
    name: 'daily_review', description: '每日复盘：统计完成与剩余，给出鼓励并询问是否清理已完成。',
    arguments: [],
    text: '请帮我复盘：\n1. 调用 list_todos 统计已完成/未完成与完成率。\n2. 用温和的中文总结，肯定已完成、列出未完成。\n3. 询问是否调用 clear_done_todos 清理——我确认前不要自行清除。不虚构数据。',
  },
  {
    name: 'quick_capture', description: '快速记录：把一段文字拆成多条待办一次记下。',
    arguments: [{ name: 'text', description: '要记录的原始内容', required: true }],
    text: '把下面内容按逗号/顿号/分号/换行拆成一条条待办，逐条调用 add_todo 记录，忽略空白项，完成后调用 list_todos 复核并列出：\n\n{{text}}',
  },
  {
    name: 'status_report', description: '一句话速报：文字告诉我还剩几件事。',
    arguments: [],
    text: '调用 list_todos，用一句中文告诉我还剩几项、分别是什么。不要打开面板，不要虚构。',
  },
];

function toolResult(data, errorText) {
  const s = data && data.todos ? data : { todos: [], remaining: 0, done: 0 };
  if (errorText) {
    return { content: [{ type: 'text', text: errorText }], structuredContent: s, _meta: boardMeta, isError: true };
  }
  const summary = s.remaining === 0
    ? '今日待办已全部完成，共 ' + s.todos.length + ' 项。'
    : '还有 ' + s.remaining + ' 项待完成，' + s.done + ' 项已完成。';
  return { content: [{ type: 'text', text: summary }], structuredContent: s, _meta: boardMeta };
}

function createMcpServer() {
  const server = new Server(
    { name: 'daily-todo', version: '2.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  function userIdOf(extra) {
    const a = extra && (extra.authInfo || (extra.request && extra.request.auth));
    if (!a) return 'local';
    return a.userId || (a.extra && a.extra.userId) || a.clientId || 'local';
  }

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const uid = userIdOf(extra);
    const { name, arguments: args = {} } = req.params;
    switch (name) {
      case 'show_todo_board':
      case 'list_todos':
        return toolResult(store.snapshot(uid));
      case 'add_todo': {
        const r = store.addTodo(uid, args.text);
        return r.error ? toolResult(store.snapshot(uid), r.error) : toolResult(r);
      }
      case 'toggle_todo': {
        const r = store.toggleTodo(uid, args.id, args.done);
        return r.error ? toolResult(store.snapshot(uid), r.error) : toolResult(r);
      }
      case 'delete_todo': {
        const r = store.deleteTodo(uid, args.id);
        return r.error ? toolResult(store.snapshot(uid), r.error) : toolResult(r);
      }
      case 'clear_done_todos':
        return toolResult(store.clearDone(uid));
      default:
        throw new Error('未知工具：' + name);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: BOARD_URI, name: '今日待办面板', mimeType: UI_MIME }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    if (req.params.uri === BOARD_URI) {
      const uid = userIdOf(extra);
      const safeJson = JSON.stringify(store.snapshot(uid))
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
      const html = WIDGET_TEMPLATE.includes(INITIAL_MARKER)
        ? WIDGET_TEMPLATE.replace(INITIAL_MARKER, safeJson)
        : WIDGET_TEMPLATE;
      return {
        contents: [{
          uri: BOARD_URI, text: html, mimeType: UI_MIME,
          _meta: {
            ui: {
              csp: { resourceDomains: ['https://esm.sh'], connectDomains: ['https://esm.sh'] },
              permissions: {}, prefersBorder: true,
            },
          },
        }],
      };
    }
    throw new Error('未知资源：' + req.params.uri);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(p => ({ name: p.name, description: p.description, ...(p.arguments.length ? { arguments: p.arguments } : {}) })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params || {};
    const p = PROMPTS.find(x => x.name === name);
    if (!p) throw new Error('未知提示词：' + name);
    for (const a of p.arguments) {
      if (a.required && !(args[a.name] !== undefined && String(args[a.name]).trim() !== '')) {
        throw new Error('缺少必填参数：' + a.name);
      }
    }
    const text = p.text.replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] === undefined ? '' : String(args[k]));
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  });

  return server;
}

/* ---------------- Express + OAuth 装配（动态 issuer） ---------------- */
const app = createMcpExpressApp({ host: HOST, allowedHosts: undefined });
// 上方不传 allowedHosts：绑定 0.0.0.0 时 SDK 不启用 host 校验，由部署平台的域名路由接管。

const provider = new PersistentAuthProvider({ mcpServerUrl: null, strictResource: false });

// --- 动态 OAuth 元数据端点（issuer 随访问域名变化） ---
function oauthMetadata(base) {
  return {
    issuer: base + '/',
    authorization_endpoint: base + '/authorize',
    token_endpoint: base + '/token',
    registration_endpoint: base + '/register',
    revocation_endpoint: base + '/revoke',
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: SCOPES,
    revocation_endpoint_auth_methods_supported: ['client_secret_post'],
  };
}
app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(oauthMetadata(baseUrlOf(req))));
app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  const base = baseUrlOf(req);
  res.json({
    resource: base + '/mcp',
    authorization_servers: [base + '/'],
    scopes_supported: SCOPES,
    resource_name: '今日待办',
  });
});

// --- OAuth 流程端点（各 handler 不依赖固定 issuer） ---
app.use('/authorize', authorizationHandler({ provider }));
app.use('/token', express.urlencoded(), tokenHandler({ provider }));
app.use('/register', clientRegistrationHandler({ clientsStore: provider.clientsStore }));
app.use('/revoke', express.urlencoded(), revocationHandler({ provider }));

app.post('/introspect', express.urlencoded(), async (req, res) => {
  res.json(await provider.introspect(req.body.token || ''));
});

// 授权确认页（demo；生产可替换为 WorkBuddy SSO）
app.get('/oauth/user', (req, res) => {
  const uid = String(req.query.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  if (!uid) { res.status(400).send('缺少 id 参数'); return; }
  res.cookie('wb_user', uid, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000, path: '/' });
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>已登录</title>
    <p>已以 <b>${uid}</b> 身份登录。请重新发起连接以完成授权。</p>`);
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'daily-todo', version: '2.0.0', dynamic: DYNAMIC }));
app.get('/whoami', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'missing token' }); return; }
  res.json(await provider.introspect(token));
});

// Bearer 鉴权：resourceMetadataUrl 也从请求动态推导
const authMiddleware = (req, res, next) => {
  const mw = requireBearerAuth({
    verifier: { verifyAccessToken: (t) => provider.verifyAccessToken(t) },
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL('/mcp', baseUrlOf(req))),
    expectedResource: STRICT ? new URL('/mcp', baseUrlOf(req)) : undefined,
  });
  return mw(req, res, next);
};

/* ---------------- 会话管理 ---------------- */
const sessions = new Map();
const IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [sid, s] of sessions) {
    if (s.open === 0 && s.lastActive < cutoff) {
      s.transport.close().catch(() => {});
      sessions.delete(sid);
    }
  }
}, 60 * 1000).unref();

async function mcpHandler(req, res) {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? (sessions.get(sessionId) || {}).transport : undefined;

    if (transport) {
      res.on('close', () => { const s = sessions.get(sessionId); if (s) s.lastActive = Date.now(); });
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && req.body && req.body.method === 'initialize') {
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: new InMemoryEventStore(),
        onsessioninitialized: (sid) => sessions.set(sid, { transport, open: 0, lastActive: Date.now() }),
      });
      transport.onclose = () => { const sid = transport.sessionId; if (sid) sessions.delete(sid); };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
  } catch (err) {
    console.error('[daily-todo] MCP error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

app.post('/mcp', authMiddleware, mcpHandler);
app.get('/mcp', authMiddleware, mcpHandler);
app.delete('/mcp', authMiddleware, mcpHandler);

app.listen(PORT, HOST, () => {
  console.log(`[daily-todo] HTTP MCP listening on http://${HOST}:${PORT}/mcp`);
  console.log(`[daily-todo] OAuth issuer: ${DYNAMIC ? 'dynamic (from Host header)' : FIXED_URL}`);
  console.log(`[daily-todo] scopes: ${SCOPES.join(', ')}`);
});

process.on('SIGINT', async () => {
  for (const { transport } of sessions.values()) { try { await transport.close(); } catch (_) {} }
  process.exit(0);
});
