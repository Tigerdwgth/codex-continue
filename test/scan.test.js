'use strict';
// test/scan.test.js — codex-continue 核心测试（ps 扫描 + 会话日志检测 + 写 tty）
const test = require('node:test');
const assert = require('node:assert');
const {
  createScanner, listCodexProcesses, findSessionLog, detectError, parseLstart,
} = require('../lib/scan');

const PS_SAMPLE = `  PID LSTART TTY  COMMAND
 18548 Wed Aug 26 22:18:16 2026 ttys011 codex
 39018 Mon Aug 24 10:00:00 2026 ttys018 codex resume 01a04000-0000-0000-0000-000000000001
  1134 Mon Aug 24 04:00:00 2026 ??     /Users/gsj/.vscode/extensions/openai.chatgpt/bin/macos-aarch64/codex -c features.code_mode_host=true app-server
 26463 Tue Aug 25 08:00:00 2026 ttys025 codex resume 01a04000-0000-0000-0000-000000000002
  6691 Mon Aug 24 05:00:00 2026 ??     /Users/gsj/.vscode-server/extensions/openai.chatgpt/bin/macos-aarch64/codex-code-mode-host
 94051 Tue Aug 25 20:00:00 2026 ttys022 codex
`;

test('listCodexProcesses 解析 ps，只留交互式 codex', () => {
  const procs = listCodexProcesses(() => PS_SAMPLE);
  assert.strictEqual(procs.length, 4);
  const tui = procs.find((p) => p.pid === 18548);
  assert.strictEqual(tui.tty, 'ttys011');
  assert.strictEqual(tui.sessionId, null);
  const resume = procs.find((p) => p.pid === 39018);
  assert.strictEqual(resume.sessionId, '01a04000-0000-0000-0000-000000000001');
  assert.ok(!procs.some((p) => p.command.includes('code-mode-host')));
  assert.ok(!procs.some((p) => p.tty === '??'));
});

test('parseLstart 解析 macOS ps lstart 格式', () => {
  const t = parseLstart('Wed Aug 26 22:18:16 2026');
  const d = new Date(t);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7);
  assert.strictEqual(d.getDate(), 26);
  assert.strictEqual(d.getHours(), 22);
  assert.strictEqual(parseLstart('garbage'), null);
});

// —— 会话日志 mock ——
function errLine(tsMs, msg) {
  return JSON.stringify({
    timestamp: new Date(tsMs).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_complete', error: { message: msg || 'exceeded retry limit, last status: 429 Too Many Requests, request id: abc' } },
  }) + '\n';
}

function makeDirTree() {
  const T = (h) => new Date(2026, 7, 26, h, 0, 0).getTime();
  const files = new Map();
  const set = (p, content, mtimeMs) => files.set(p, { size: Buffer.byteLength(content), content, mtimeMs });
  const ROOT = '/fake/.codex/sessions';
  set(`${ROOT}/2026/08/26/a.jsonl`, '', T(8));
  set(`${ROOT}/2026/08/26/b.jsonl`, '', T(10));
  set(`${ROOT}/2026/08/26/c.jsonl`, '', T(12));

  const readdirSync = (dir) => {
    if (dir === ROOT) return [{ name: '2026', isDirectory: () => true, isFile: () => false }];
    if (dir.endsWith('2026')) return [{ name: '08', isDirectory: () => true, isFile: () => false }];
    if (dir.endsWith('08')) return [{ name: '26', isDirectory: () => true, isFile: () => false }];
    return [...files.keys()].filter((p) => path.dirname(p) === dir).map((p) => ({ name: path.basename(p), isDirectory: () => false, isFile: () => true }));
  };
  const statSync = (p) => ({ size: files.get(p)?.size || 0, mtimeMs: files.get(p)?.mtimeMs || 0 });
  const readFileSync = (p, o) => {
    const f = files.get(p);
    if (!f) return '';
    const { start = 0, end = f.size } = o || {};
    return f.content.slice(start, end);
  };
  return { readdirSync, statSync, readFileSync, files, ROOT };
}

const path = require('node:path');

test('findSessionLog：resume 按 session id 匹配', () => {
  const allLogs = [
    { path: '/x/rollout-x-01a04000-0000-0000-0000-000000000001.jsonl', mtimeMs: 1 },
    { path: '/x/rollout-y-01a04000-0000-0000-0000-000000000002.jsonl', mtimeMs: 2 },
  ];
  const hit = findSessionLog({ sessionId: '01a04000-0000-0000-0000-000000000002', startTimeMs: 0 }, allLogs, new Set());
  assert.ok(hit.path.includes('000000000002'));
});

test('detectError 只统计能解析 timestamp 的错误行，返回最近错误时间', () => {
  const ts = new Date(2026, 7, 26, 11, 30, 0).getTime();
  const content = '{"x":1}\n' + errLine(ts) + '{"y":2}\n';
  const statSync = () => ({ size: Buffer.byteLength(content) });
  const readFileSync = () => content;
  const { hit, lastErrorTime, newSize } = detectError(logPath('/x'), 0, [/exceeded retry limit, last status: 429 too many requests/i], readFileSync, statSync);
  assert.strictEqual(hit, true);
  assert.strictEqual(lastErrorTime, ts);
  assert.strictEqual(newSize, Buffer.byteLength(content));
});

function logPath() { return '/fake/rollout.jsonl'; }

test('detectError 无法解析 timestamp 的错误行不计（避免误触发）', () => {
  const content = 'exceeded retry limit, last status: 429 Too Many Requests\n'; // 非 JSON 行
  const statSync = () => ({ size: Buffer.byteLength(content) });
  const readFileSync = () => content;
  const { hit } = detectError(logPath(), 0, [/exceeded retry limit, last status: 429 too many requests/i], readFileSync, statSync);
  assert.strictEqual(hit, false);
});

test('detectError 忽略普通消息行（agent_message 文本提到关键词不算错误）', () => {
  const ts = new Date(2026, 7, 26, 11, 30, 0).getTime();
  const content = JSON.stringify({
    timestamp: new Date(ts).toISOString(), type: 'event_msg',
    payload: { type: 'agent_message', message: { content: 'user said: model at capacity is a common issue' } },
  }) + '\n';
  const statSync = () => ({ size: Buffer.byteLength(content) });
  const readFileSync = () => content;
  const { hit } = detectError(logPath(), 0, [/model at capacity/i], readFileSync, statSync);
  assert.strictEqual(hit, false, 'agent_message 不应算错误');
});

test('scan 全流程：窗口内错误 → 写 tty continue + \\n', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => ERR_TS + 60_000, // 错误后 1 分钟，窗口内
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (dev, data) => writes.push({ dev, data }) },
  });
  assert.strictEqual(scanner.scan(), 1);
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0].dev, '/dev/ttys011');
  assert.strictEqual(writes[0].data, 'continue');
  assert.strictEqual(writes[1].data, '\n');
});

test('scan：历史错误（超过窗口）不触发 —— 没报错不再发 continue', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => ERR_TS + 20 * 60_000, // 错误后 20 分钟，超过窗口
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 0, '历史错误不触发');
  assert.strictEqual(writes.length, 0);
});

test('scan：日志无错误时不触发', () => {
  const { readdirSync, statSync, readFileSync } = makeDirTree();
  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 20:00:00 2026 ttys011 codex\n`,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 0);
  assert.strictEqual(writes.length, 0);
});

test('scan：错误不再增长不重复触发；冷却内新错误也不触发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const BASE = new Date(2026, 7, 26, 11, 30, 0).getTime();
  const err1 = errLine(BASE, 'model at capacity');
  files.set(errLog, { size: Buffer.byteLength(err1), content: err1, mtimeMs: BASE });

  const writes = [];
  const t = { value: BASE + 60_000 };
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => t.value,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  scanner.scan(); // 触发，lastAt = BASE+60s
  assert.strictEqual(writes.length, 2);
  scanner.scan(); // 日志没变，不重复
  assert.strictEqual(writes.length, 2);
  // 日志增长出新错误（错误时间 BASE+70s）但距上次触发仅 15s（冷却内）→ 不触发，lastSize 前进
  const err2 = err1 + errLine(BASE + 70_000, 'model at capacity');
  files.set(errLog, { size: Buffer.byteLength(err2), content: err2, mtimeMs: BASE + 70_000 });
  t.value = BASE + 75_000;
  scanner.scan();
  assert.strictEqual(writes.length, 2, '冷却内不触发');
  // 冷却过后（距上次 90s）日志再出现新错误 → 触发
  const err3 = err2 + errLine(BASE + 140_000, 'exceeded retry limit, last status: 429 Too Many Requests, request id: zzz');
  files.set(errLog, { size: Buffer.byteLength(err3), content: err3, mtimeMs: BASE + 140_000 });
  t.value = BASE + 150_000;
  scanner.scan();
  assert.strictEqual(writes.length, 4, '冷却过后新错误触发');
});

test('scan：发送后日志增长（codex 响应）→ 正常，不静默', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const BASE = new Date(2026, 7, 26, 11, 30, 0).getTime();
  const err1 = errLine(BASE, 'model at capacity');
  files.set(errLog, { size: Buffer.byteLength(err1), content: err1, mtimeMs: BASE });

  const writes = [];
  const t = { value: BASE + 60_000 };
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => t.value,
    cooldownMs: 30000,
    enterDelayMs: 0,
    verifyWindow: 15_000,
    silence: 60_000,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  scanner.scan(); // 触发，进入验证
  assert.strictEqual(writes.length, 2);
  // codex 响应了（日志增长），验证通过，不静默
  const err2 = err1 + '{"timestamp":"' + new Date(BASE + 65_000).toISOString() + '","type":"event_msg","payload":{"type":"agent_message","message":{"content":"working..."}}}\n';
  files.set(errLog, { size: Buffer.byteLength(err2), content: err2, mtimeMs: BASE + 65_000 });
  t.value = BASE + 80_000; // 超过验证窗口
  scanner.scan();
  assert.strictEqual(writes.length, 2, '响应后不重复发');
  // 日志不再增长，不应触发也不应静默误判（无新错误）
  scanner.scan();
  assert.strictEqual(writes.length, 2);
});

test('scan：发送后日志不增长（codex 冻结/无响应）→ 静默跳过，不再发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const BASE = new Date(2026, 7, 26, 11, 30, 0).getTime();
  const err1 = errLine(BASE, 'model at capacity');
  files.set(errLog, { size: Buffer.byteLength(err1), content: err1, mtimeMs: BASE });

  const writes = [];
  const t = { value: BASE + 60_000 };
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => t.value,
    cooldownMs: 30000,
    enterDelayMs: 0,
    verifyWindow: 15_000,
    silence: 60_000,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  scanner.scan(); // 触发，进入验证
  assert.strictEqual(writes.length, 2);
  // 日志没增长，过了验证窗口 → 冻结静默
  t.value = BASE + 90_000; // 发送后 30s > 验证窗口 15s
  scanner.scan();
  assert.strictEqual(writes.length, 2, '静默后不重复发');
  // 静默期内即使有新错误也不发
  const err2 = err1 + errLine(BASE + 100_000, 'exceeded retry limit, last status: 429 Too Many Requests, request id: x');
  files.set(errLog, { size: Buffer.byteLength(err2), content: err2, mtimeMs: BASE + 100_000 });
  t.value = BASE + 120_000; // 静默期内（60s 静默从 BASE+90s 开始）
  scanner.scan();
  assert.strictEqual(writes.length, 2, '静默期内不发');
});

test('scan：进程消失后状态清理', () => {
  const { readdirSync, statSync, readFileSync } = makeDirTree();
  let ps = ` 1000 Wed Aug 26 20:00:00 2026 ttys011 codex\n`;
  const scanner = createScanner({
    execPs: () => ps,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: () => {} },
  });
  scanner.scan();
  ps = ` 2000 Wed Aug 26 20:00:00 2026 ttys011 zsh\n`;
  scanner.scan();
  assert.strictEqual(scanner.listCodexProcesses().length, 0);
});
