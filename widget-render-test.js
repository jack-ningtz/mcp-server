/* 验证 MCP 面板在“SDK 连接失败”情况下仍能用注入快照渲染 todos.json 数据。
 * jsdom 不支持 <script type="module">，因此把模块脚本取出、stub 掉 CDN import，
 * 作为普通 async 函数执行，从而真实地跑 setData/render 逻辑。 */
const { JSDOM, VirtualConsole } = require('jsdom');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } }

function renderInJsdom(html) {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('module script not found');
  let script = m[1];
  // stub：让 CDN import 抛错，进入 catch（模拟 SDK 不可用），消除 top-level await
  script = script.replace(
    /const \{ App \} = await import\([^;]+\);/,
    "throw new Error('offline-test');"
  );
  const bootScript = `(async function(){ ${script} })();`;
  const page = html.replace(/<script type="module">[\s\S]*?<\/script>/, `<script>${bootScript}</script>`);
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  return new JSDOM(page, { runScripts: 'dangerously', virtualConsole: vc, url: 'https://local.test/' });
}

(async () => {
  // 独立临时数据文件，写入一条已知数据，不碰真实 todos.json
  const tmpFile = path.join(os.tmpdir(), 'daily-todo-render-test-' + process.pid + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify([
    { id: 't_fixture', text: '下午三点开会', done: false, createdAt: 1795139099700 }
  ], null, 2), 'utf8');
  const c = new Client({ name: 'widget-render-test', version: '1.0.0' });
  const t = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'server.js')],
    stderr: 'pipe',
    env: { ...process.env, TODO_DATA_FILE: tmpFile },
  });
  await c.connect(t);
  const r = await c.readResource({ uri: 'ui://daily-todo/board' });
  const html = r.contents[0].text;
  await c.close();

  console.log('\n== 面板渲染（SDK 不可用，纯注入快照）==');
  const dom = renderInJsdom(html);
  await new Promise(res => setTimeout(res, 100));
  const d = dom.window.document;
  ok(d.querySelectorAll('.item').length === 1, '渲染出 1 条待办');
  ok(d.querySelector('.item .text')?.textContent === '下午三点开会', '文本正确');
  ok(d.getElementById('remaining').textContent === '1 项待完成', '剩余计数正确');
  ok(d.getElementById('empty').hidden === true, '空状态隐藏');
  ok(!/NaN/.test(d.getElementById('fill').style.width), '进度条数值合法');
  ok(/快照模式|预览模式/.test(d.getElementById('liveText').textContent), 'SDK 不可用时显示快照模式');

  d.querySelectorAll('.filter')[2].click();
  await new Promise(res => setTimeout(res, 20));
  ok(d.querySelectorAll('.item').length === 0, '筛选已完成为空');
  ok(d.getElementById('emptyText').textContent.includes('已完成'), '空态文案随筛选变化');
  d.querySelectorAll('.filter')[0].click();
  await new Promise(res => setTimeout(res, 20));
  ok(d.querySelectorAll('.item').length === 1, '切回全部恢复显示');

  console.log('\n== XSS 转义 ==');
  const evil = { todos: [{ id: 'x', text: '</script><img src=x onerror=alert(1)>', done: false, createdAt: 1 }], remaining: 1, done: 0 };
  const safe = JSON.stringify(evil).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const tmpl = fs.readFileSync(path.join(__dirname, 'widget.html'), 'utf8');
  const evilHtml = tmpl.replace('/*__INITIAL_DATA__*/null', safe);
  const dom2 = renderInJsdom(evilHtml);
  await new Promise(res => setTimeout(res, 100));
  const d2 = dom2.window.document;
  ok(d2.querySelectorAll('img').length === 0, '注入的 img 标签未被执行');
  ok((d2.querySelector('.item .text')?.textContent || '').includes('onerror'), '恶意文本作为纯文本显示');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
