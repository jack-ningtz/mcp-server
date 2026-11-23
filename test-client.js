const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  // 用独立临时数据文件，避免污染真实 todos.json
  const tmpFile = path.join(os.tmpdir(), 'daily-todo-test-' + process.pid + '.json');
  fs.writeFileSync(tmpFile, '[]', 'utf8');
  const client = new Client({ name: 'todo-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [require('path').join(__dirname, 'server.js')],
    stderr: 'pipe',
    env: { ...process.env, TODO_DATA_FILE: tmpFile },
  });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('TOOLS:', tools.tools.map(t => t.name).join(', '));
  const names = tools.tools.map(t => t.name);
  const required = ['show_todo_board', 'list_todos', 'add_todo', 'toggle_todo', 'delete_todo', 'clear_done_todos'];
  required.forEach(n => { if (!names.includes(n)) throw new Error('missing tool: ' + n); });

  const board = tools.tools.find(t => t.name === 'show_todo_board');
  if (!board._meta?.ui?.resourceUri) throw new Error('board tool missing ui resourceUri');

  const res = await client.listResources();
  const r = res.resources.find(x => x.uri.includes('daily-todo/board'));
  if (!r) throw new Error('board resource missing');
  if (r.mimeType !== 'text/html;profile=mcp-app') throw new Error('wrong MIME: ' + r.mimeType);

  const html = await client.readResource({ uri: r.uri });
  if (!html.contents[0].text.includes('今日待办')) throw new Error('widget html missing');

  // 清空后测试增删改
  await client.callTool({ name: 'clear_done_todos', arguments: {} });
  await client.callTool({ name: 'add_todo', arguments: { text: '  测试任务  ' } });
  let out = await client.callTool({ name: 'list_todos', arguments: {} });
  let s = out.structuredContent;
  if (s.todos[0].text !== '测试任务') throw new Error('trim/add failed');
  if (s.remaining !== 1) throw new Error('remaining count wrong');

  const id = s.todos[0].id;
  out = await client.callTool({ name: 'toggle_todo', arguments: { id, done: true } });
  if (out.structuredContent.remaining !== 0) throw new Error('toggle failed');

  out = await client.callTool({ name: 'delete_todo', arguments: { id } });
  if (out.structuredContent.todos.length !== 0) throw new Error('delete failed');

  // 空白任务不添加
  out = await client.callTool({ name: 'add_todo', arguments: { text: '   ' } });
  if (!out.isError) throw new Error('blank task should be rejected');

  // ---- prompts ----
  const pl = await client.listPrompts();
  console.log('PROMPTS:', pl.prompts.map(p => p.name).join(', '));
  const pnames = pl.prompts.map(p => p.name);
  ['morning_plan', 'daily_review', 'quick_capture', 'status_report'].forEach(n => {
    if (!pnames.includes(n)) throw new Error('missing prompt: ' + n);
  });
  const qc = pl.prompts.find(p => p.name === 'quick_capture');
  if (!qc.arguments?.some(a => a.name === 'text' && a.required)) throw new Error('quick_capture missing required arg');

  // 参数占位符替换
  const rendered = await client.getPrompt({ name: 'quick_capture', arguments: { text: '买牛奶、写周报' } });
  if (!rendered.messages?.[0]?.content?.text?.includes('买牛奶、写周报')) throw new Error('prompt arg substitution failed');

  // 必填参数缺失应报错
  let missingRejected = false;
  try { await client.getPrompt({ name: 'quick_capture', arguments: {} }); }
  catch (_) { missingRejected = true; }
  if (!missingRejected) throw new Error('missing required arg should be rejected');

  // 无参数提示词可渲染
  const morning = await client.getPrompt({ name: 'morning_plan' });
  if (!morning.messages?.[0]?.content?.text?.includes('list_todos')) throw new Error('morning_plan content unexpected');

  console.log('ALL MCP CHECKS PASSED');
  await client.close();
  try { fs.unlinkSync(tmpFile); } catch (_) {}
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
