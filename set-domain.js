#!/usr/bin/env node
/* 部署拿到公网域名后，一键把占位符 YOUR_DOMAIN 替换成真实地址。
 * 用法：
 *   node set-domain.js https://daily-todo-mcp.onrender.com
 *   node set-domain.js daily-todo-mcp.onrender.com
 */
const fs = require('fs');
const path = require('path');

const raw = (process.argv[2] || '').trim();
if (!raw) {
  console.error('用法：node set-domain.js https://你的域名');
  process.exit(1);
}

let domain = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
if (!domain || /\s/.test(domain)) {
  console.error('域名不合法：' + raw);
  process.exit(1);
}
const origin = 'https://' + domain;
const serverUrl = origin + '/mcp';

const root = path.resolve(__dirname, '..');
const patch = (rel, fn) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.warn('跳过（文件不存在）：' + rel);
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  fn(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('已更新：' + rel);
};

patch('connector/daily-todo/connector-meta.json', (d) => {
  d.server_auth.data.mcp_oauth.server_url = serverUrl;
});

patch('connector/daily-todo/mcp.json', (d) => {
  d.mcpServers['daily-todo'].url = serverUrl;
});

patch('buddy-app/app-config.json', (d) => {
  const list = d['模块1_创建应用']['可信Origin'];
  if (!list.includes(origin)) list.push(origin);
});

console.log('\n完成。MCP 地址：' + serverUrl);
console.log('提醒：服务端 PUBLIC_URL 必须与 ' + origin + ' 完全一致（render.yaml 已设为 auto，会自动推导）。');
