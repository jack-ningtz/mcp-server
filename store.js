/* ============================================================
 * 待办存储层 — 按用户隔离
 * 每个 userId 一个独立 JSON 文件：data/users/<safeId>.json
 * stdio 模式用 'local' 用户；HTTP 模式用 OAuth token 的 userId。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.TODO_DATA_DIR || path.join(__dirname, 'data', 'users');
const LEGACY_FILE = process.env.TODO_DATA_FILE || path.join(__dirname, 'todos.json');

function safeId(userId) {
  return String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function fileFor(userId) {
  return path.join(DATA_DIR, safeId(userId) + '.json');
}

function loadTodos(userId) {
  const file = fileFor(userId);
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    // 迁移：stdio 老用户的 todos.json
    if (safeId(userId) === 'local') {
      try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
        return Array.isArray(legacy) ? legacy : [];
      } catch (_) { /* ignore */ }
    }
    return [];
  }
}

function saveTodos(userId, todos) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fileFor(userId);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(todos, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function uid() {
  return 't_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function snapshot(userId) {
  const todos = loadTodos(userId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const remaining = todos.filter(t => !t.done).length;
  return { todos, remaining, done: todos.length - remaining };
}

function addTodo(userId, text) {
  const clean = (text || '').trim();
  if (!clean) return { error: '任务内容不能为空' };
  const todos = loadTodos(userId);
  todos.unshift({ id: uid(), text: clean, done: false, createdAt: Date.now() });
  saveTodos(userId, todos);
  return snapshot(userId);
}

function toggleTodo(userId, id, done) {
  const todos = loadTodos(userId);
  const item = todos.find(t => t.id === id);
  if (!item) return { error: '未找到该任务' };
  item.done = typeof done === 'boolean' ? done : !item.done;
  saveTodos(userId, todos);
  return snapshot(userId);
}

function deleteTodo(userId, id) {
  const todos = loadTodos(userId);
  const next = todos.filter(t => t.id !== id);
  if (next.length === todos.length) return { error: '未找到该任务' };
  saveTodos(userId, next);
  return snapshot(userId);
}

function clearDone(userId) {
  saveTodos(userId, loadTodos(userId).filter(t => !t.done));
  return snapshot(userId);
}

module.exports = {
  loadTodos, saveTodos, snapshot, addTodo, toggleTodo, deleteTodo, clearDone,
  fileFor, DATA_DIR,
};
