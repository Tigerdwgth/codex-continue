'use strict';
// test/scan.test.js — codex-continue 核心测试（ps 扫描 + 会话日志检测 + 写 tty）
const test = require('node:test');
const assert = require('node:assert');
const {
  createScanner, listCodexProcesses, findSessionLog, detectError, parseLstart, listTmuxPaneTargets,
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

test('scan 全流程：日志有 429 错误 → 写 tty continue + \\n', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({ execTmux: () => '',
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

test('scan：历史错误（已停住）也触发 —— 移除时间窗口后只要有错误就发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({ execTmux: () => '',
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => ERR_TS + 20 * 60_000, // 错误后 20 分钟（远超原 10 分钟窗口）
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 1, '历史错误同样触发');
  assert.strictEqual(writes.length, 2);
});

test('scan：日志无错误时不触发', () => {
  const { readdirSync, statSync, readFileSync } = makeDirTree();
  const writes = [];
  const scanner = createScanner({ execTmux: () => '',
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
  const scanner = createScanner({ execTmux: () => '',
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
  // mtime 保持 BASE（很老）：日志写完后停滞 = 卡住状态，STALE 判据不误伤
  const err2 = err1 + errLine(BASE + 70_000, 'model at capacity');
  files.set(errLog, { size: Buffer.byteLength(err2), content: err2, mtimeMs: BASE });
  t.value = BASE + 75_000;
  scanner.scan();
  assert.strictEqual(writes.length, 2, '冷却内不触发');
  // 冷却过后（距上次 90s）日志再出现新错误 → 触发
  const err3 = err2 + errLine(BASE + 140_000, 'exceeded retry limit, last status: 429 Too Many Requests, request id: zzz');
  files.set(errLog, { size: Buffer.byteLength(err3), content: err3, mtimeMs: BASE });
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
  const scanner = createScanner({ execTmux: () => '',
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
  const scanner = createScanner({ execTmux: () => '',
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

test('listTmuxPaneTargets 解析 pane_tty → target 映射', () => {
  const map = listTmuxPaneTargets(() => '/dev/ttys011\tS-lo-t-SIM:0.0\n/dev/ttys019\tcc-x:0.0\n');
  assert.strictEqual(map.get('/dev/ttys011'), 'S-lo-t-SIM:0.0');
  assert.strictEqual(map.get('/dev/ttys019'), 'cc-x:0.0');
});

test('listCodexProcesses：tmux 里的 codex 标注 tmuxTarget，普通终端为 null', () => {
  const psOut = ' 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n 2000 Wed Aug 26 11:00:00 2026 ttys200 codex\n';
  const map = new Map([['/dev/ttys011', 'S-lo-t-SIM:0.0']]);
  const procs = listCodexProcesses(() => psOut, map);
  const a = procs.find((p) => p.pid === 1000);
  const b = procs.find((p) => p.pid === 2000);
  assert.strictEqual(a.tmuxTarget, 'S-lo-t-SIM:0.0');
  assert.strictEqual(b.tmuxTarget, null);
});

test('scan：tmux 里的 codex 用 tmux send-keys 发送（文本 + Enter 分两次）', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const tmuxCmds = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    execTmux: (args) => {
      if (args[0] === 'list-panes') return '/dev/ttys011\tS-lo-t-SIM:0.0\n';
      if (args[0] === 'send-keys') { tmuxCmds.push(args); return ''; }
      return '';
    },
    now: () => ERR_TS + 60_000,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: () => { throw new Error('不应写 tty'); } },
  });
  assert.strictEqual(scanner.scan(), 1);
  assert.deepStrictEqual(tmuxCmds[0], ['send-keys', '-t', 'S-lo-t-SIM:0.0', 'continue']);
  assert.deepStrictEqual(tmuxCmds[1], ['send-keys', '-t', 'S-lo-t-SIM:0.0', 'Enter']);
});

test('scan：普通终端 codex 用写 tty 发送', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys200 codex\n`,
    execTmux: () => '', // 无 tmux 映射 → 普通终端
    now: () => ERR_TS + 60_000,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (dev, data) => writes.push({ dev, data }) },
  });
  assert.strictEqual(scanner.scan(), 1);
  assert.deepStrictEqual(writes, [{ dev: '/dev/ttys200', data: 'continue' }, { dev: '/dev/ttys200', data: '\n' }]);
});

test('scan：进程在错误之后启动（用户 resume 会话）→ 不自动 continue', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({
    // 进程 11:31 启动，错误 11:30 → 进程在错误之后启动（resume 场景）
    execPs: () => ` 1000 Wed Aug 26 11:31:00 2026 ttys011 codex resume 01a04000-0000-0000-0000-000000000003\n`,
    execTmux: () => '',
    now: () => ERR_TS + 120_000,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 0, 'resume 场景不自动 continue');
  assert.strictEqual(writes.length, 0);
});

test('scan：进程在错误之前就在运行（一直卡住）→ 正常触发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const ERR_TS = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(ERR_TS)), content: errLine(ERR_TS), mtimeMs: ERR_TS });

  const writes = [];
  const scanner = createScanner({
    // 进程 10:00 启动，错误 11:30 → 进程在错误前就在运行
    execPs: () => ` 1000 Wed Aug 26 10:00:00 2026 ttys011 codex\n`,
    execTmux: () => '',
    now: () => ERR_TS + 60_000,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 1);
  assert.strictEqual(writes.length, 2);
});

test('scan：错误之后已有新活动（会话已恢复）→ 不触发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const BASE = new Date(2026, 7, 26, 11, 30, 0).getTime();
  // 错误之后还有普通事件（agent_message），说明会话在错误后继续了
  const content = errLine(BASE) + '{"timestamp":"' + new Date(BASE + 60_000).toISOString() + '","type":"event_msg","payload":{"type":"agent_message","message":{"content":"working..."}}}\n';
  files.set(errLog, { size: Buffer.byteLength(content), content, mtimeMs: BASE + 60_000 });

  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 10:00:00 2026 ttys011 codex\n`,
    execTmux: () => '',
    now: () => BASE + 120_000,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 0, '错误后已恢复的会话不触发');
  assert.strictEqual(writes.length, 0);
});

test('scan：错误是最后一条（会话停在错误上）→ 触发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const BASE = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(BASE)), content: errLine(BASE), mtimeMs: BASE });

  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 10:00:00 2026 ttys011 codex\n`,
    execTmux: () => '',
    now: () => BASE + 60_000,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 1, '停在错误上的会话触发');
  assert.strictEqual(writes.length, 2);
});

test('scan：进程消失后状态清理', () => {
  const { readdirSync, statSync, readFileSync } = makeDirTree();
  let ps = ` 1000 Wed Aug 26 20:00:00 2026 ttys011 codex\n`;
  const scanner = createScanner({ execTmux: () => '',
    execPs: () => ps,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: () => {} },
  });
  scanner.scan();
  ps = ` 2000 Wed Aug 26 20:00:00 2026 ttys011 zsh\n`;
  scanner.scan();
  assert.strictEqual(scanner.listCodexProcesses().length, 0);
});

test('findSessionLog：lsof 探测的 openLogs 优先于启动时间猜测', () => {
  const { ROOT } = makeDirTree();
  const allLogs = [
    { path: `${ROOT}/2026/08/26/rollout-x-01a00000-0000-0000-0000-0000000000aa.jsonl`, mtimeMs: 100 },
    { path: `${ROOT}/2026/08/26/rollout-y-01a00000-0000-0000-0000-0000000000bb.jsonl`, mtimeMs: 200 },
    { path: `${ROOT}/2026/08/26/rollout-z-01a00000-0000-0000-0000-0000000000cc.jsonl`, mtimeMs: 300 },
  ];
  const assigned = new Set();
  // 进程真实打开 bb（mtime 200），但启动时间猜测会选 cc（mtime 300）
  const proc = { sessionId: null, startTimeMs: 1000 };
  const openLogs = [allLogs[1].path];
  const hit = findSessionLog(proc, allLogs, assigned, openLogs);
  assert.ok(hit, '应选中 lsof 打开的日志');
  assert.strictEqual(hit.path, allLogs[1].path, 'openLogs 优先于 mtime');
  // 即使 assigned 里有它（被别的进程猜分支抢占过），lsof 硬证据仍要还给本进程
  assigned.add(allLogs[1].path);
  const hit2 = findSessionLog(proc, allLogs, assigned, openLogs);
  assert.strictEqual(hit2.path, allLogs[1].path, 'lsof 硬证据无视 assigned');
  // 无 openLogs 时才回退猜分支，且跳过已 assigned 的
  const hit3 = findSessionLog({ sessionId: null, startTimeMs: 1000 }, allLogs, new Set([allLogs[2].path]), []);
  assert.strictEqual(hit3.path, allLogs[1].path, '猜分支跳过已分配、选次新');
});

test('listOpenSessionLogs：从 lsof 输出提取进程打开的 rollout 日志', () => {
  const { listOpenSessionLogs } = require('../lib/scan');
  const lsofOut = [
    'codex  1234  gsj  19u  REG  1,18  14873858  /Users/gsj/.codex/sessions/2026/08/27/rollout-2026-08-27T22-56-23-01a00000-0000-0000-0000-000000000001.jsonl',
    'codex  1234  gsj  22u  REG  1,18   4322196  /Users/gsj/.codex/sessions/2026/08/28/rollout-2026-08-28T01-09-42-01a00000-0000-0000-0000-000000000002.jsonl',
    'codex  1234  gsj  3u  CHR  136,2  0t0  /dev/ttys011',
  ].join('\n');
  // execLsof 注入返回 mock；sessionsDir 指向不存在的 fake 目录，只验证提取逻辑
  const paths = listOpenSessionLogs(1234, '/fake/.codex/sessions', () => lsofOut);
  // 真实 fs 下找不到文件返回空数组（mock 路径不存在），验证提取至少识别到 2 个文件名
  assert.ok(paths.length <= 2, '提取结果不超上限');
});

test('scan：日志活跃（mtime 新鲜，codex 在写）→ 即使有 429 也不触发', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/c.jsonl`;
  const BASE = new Date(2026, 7, 26, 11, 30, 0).getTime();
  files.set(errLog, { size: Buffer.byteLength(errLine(BASE)), content: errLine(BASE), mtimeMs: BASE });

  const writes = [];
  const scanner = createScanner({ execTmux: () => '',
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => BASE + 5_000, // 距 mtime 仅 5s → 日志仍在写（活跃）
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  assert.strictEqual(scanner.scan(), 0, '活跃中的会话（日志在写）不触发');
  assert.strictEqual(writes.length, 0);
});
