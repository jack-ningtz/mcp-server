/* ============================================================
 * HTTP MCP + OAuth 端到端测试
 * 真实走：动态注册 → 授权码流(PKCE) → token → 带token调工具 → 用户隔离
 * 前置：先启动 server-http.js（PUBLIC_URL=http://127.0.0.1:3100 PORT=3100）
 * ============================================================ */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { InMemoryOAuthClientProvider } = require('@modelcontextprotocol/sdk/examples/client/simpleOAuthClientProvider.js');

const BASE = 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } }

/**
 * 模拟浏览器完成授权：客户端 provider 收到 authorize URL 后，
 * 我们带上用户身份访问 /oauth/user 设置 cookie，再跟随跳转到 redirect_uri。
 * 返回 code。
 */
async function simulateBrowserAuthorization(authorizeUrl, userId) {
  const url = new URL(authorizeUrl);
  // 1) 先设置登录 cookie（模拟 WorkBuddy SSO 登录态）
  const loginUrl = new URL('/oauth/user', BASE);
  loginUrl.searchParams.set('id', userId);
  const loginRes = await fetch(loginUrl.toString(), { redirect: 'manual' });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  ok(!!cookie, `浏览器登录设置 cookie (${userId})`);

  // 2) 带 cookie 访问 authorize，SDK 会生成 code 并 302 到 redirect_uri
  const authRes = await fetch(url.toString(), {
    redirect: 'manual',
    headers: { Cookie: cookie },
  });
  ok(authRes.status === 302, `authorize 返回 302 (${authRes.status})`);
  const location = authRes.headers.get('location');
  const code = new URL(location).searchParams.get('code');
  ok(!!code, `拿到授权码 code (${userId})`);
  return code;
}

async function connectAs(userId) {
  let authUrlForTest = null;
  const provider = new InMemoryOAuthClientProvider(
    new URL('/oauth/callback', BASE),
    {
      client_name: `daily-todo-test-${userId}`,
      redirect_uris: [`${BASE}/oauth/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp:tools todo.read todo.write',
      token_endpoint_auth_method: 'none',
    },
    (authorizeUrl) => { authUrlForTest = authorizeUrl.toString(); }
  );

  const client = new Client({ name: 'http-oauth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE), { authProvider: provider });

  try {
    await client.connect(transport);
  } catch (e) {
    // 第一次连接会触发授权跳转，transport 抛出重定向错误属正常
    if (!authUrlForTest) throw e;
  }

  if (authUrlForTest) {
    // 手动完成授权：拿到 code 后交给 provider 走 token 交换
    const code = await simulateBrowserAuthorization(authUrlForTest, userId);
    // 直接调用 token 端点换 token（模拟客户端回调处理）
    const clientInfo = provider.clientInformation();
    const codeVerifier = provider.codeVerifier();
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${BASE}/oauth/callback`,
      client_id: clientInfo.client_id,
      code_verifier: codeVerifier,
    });
    const tokenRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    ok(tokenRes.ok, `token 端点换 token (${userId})`);
    const tokens = await tokenRes.json();
    provider.saveTokens(tokens);
    ok(!!tokens.access_token, `拿到 access_token (${userId})`);

    // 重新连接，这次带 token
    const transport2 = new StreamableHTTPClientTransport(new URL('/mcp', BASE), { authProvider: provider });
    await client.connect(transport2);
  }

  return { client, provider };
}

(async () => {
  console.log('== 元数据与鉴权 ==');
  const health = await (await fetch(`${BASE}/health`)).json();
  ok(health.ok === true, '健康检查');

  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
  });
  ok(unauth.status === 401, `无 token 被拒 401 (得到 ${unauth.status})`);

  console.log('\n== 用户 A 连接并新增待办 ==');
  const A = await connectAs('alice');
  const add = await A.client.callTool({ name: 'add_todo', arguments: { text: 'A的任务' } });
  ok(add.structuredContent && add.structuredContent.todos.length === 1, 'A 新增 1 条');
  const listA1 = await A.client.callTool({ name: 'list_todos', arguments: {} });
  const idA = listA1.structuredContent.todos[0].id;

  console.log('\n== 用户 B 连接，应看不到 A 的数据 ==');
  const B = await connectAs('bob');
  const listB = await B.client.callTool({ name: 'list_todos', arguments: {} });
  ok(listB.structuredContent.todos.length === 0, 'B 初始为空（数据隔离）');
  await B.client.callTool({ name: 'add_todo', arguments: { text: 'B的任务' } });

  console.log('\n== 回到 A，仍只有自己的数据 ==');
  const listA2 = await A.client.callTool({ name: 'list_todos', arguments: {} });
  ok(listA2.structuredContent.todos.length === 1, 'A 仍只有 1 条（未被 B 污染）');
  ok(listA2.structuredContent.todos[0].text === 'A的任务', 'A 数据内容正确');

  console.log('\n== 勾选 / 删除 / 空白拦截 ==');
  const toggled = await A.client.callTool({ name: 'toggle_todo', arguments: { id: idA, done: true } });
  ok(toggled.structuredContent.todos[0].done === true, '勾选完成');
  const blank = await A.client.callTool({ name: 'add_todo', arguments: { text: '   ' } });
  ok(blank.isError === true, '空白任务被拦截');
  const deleted = await A.client.callTool({ name: 'delete_todo', arguments: { id: idA } });
  ok(deleted.structuredContent.todos.length === 0, '删除成功');

  console.log('\n== 面板资源 / 提示词 ==');
  const res = await A.client.readResource({ uri: 'ui://daily-todo/board' });
  ok(res.contents[0].mimeType === 'text/html;profile=mcp-app', '面板资源 MIME 正确');
  const prompts = await A.client.listPrompts();
  ok(prompts.prompts.length === 4, '提示词 4 条');

  await A.client.close();
  await B.client.close();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
