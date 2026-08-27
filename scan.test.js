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
  // code-mode-host / app-server / 无 tty 都被排除
  assert.ok(!procs.some((p) => p.command.includes('code-mode-host')));
  assert.ok(!procs.some((p) => p.tty === '??'));
});

test('parseLstart 解析 macOS ps lstart 格式', () => {
  const t = parseLstart('Wed Aug 26 22:18:16 2026');
  const d = new Date(t);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7); // Aug
  assert.strictEqual(d.getDate(), 26);
  assert.strictEqual(d.getHours(), 22);
  assert.ok(Number.isFinite(t));
  assert.strictEqual(parseLstart('garbage'), null);
});

function makeDirTree() {
  // ~/.codex/sessions/2026/08/26/<rollout>.jsonl 的目录结构 mock
  const T = (h) => new Date(2026, 7, 26, h, 0, 0).getTime(); // 2026-08-26 本地时间
  const files = new Map(); // path → { size, content, mtimeMs }
  const set = (p, content, mtimeMs) => files.set(p, { size: Buffer.byteLength(content), content, mtimeMs });
  const ROOT = '/fake/.codex/sessions';
  set(`${ROOT}/2026/08/26/rollout-2026-08-26T00-00-00-01a04000-0000-0000-0000-000000000001.jsonl`, '', T(8));
  set(`${ROOT}/2026/08/26/rollout-2026-08-26T10-00-00-01a04000-0000-0000-0000-000000000002.jsonl`, '', T(10));
  set(`${ROOT}/2026/08/26/rollout-2026-08-26T12-00-00-01a04000-0000-0000-0000-000000000003.jsonl`, '', T(12));

  const readdirSync = (dir, opts) => {
    const children = [];
    for (const p of files.keys()) {
      const rel = p.slice(ROOT.length + 1);
      if (path.dirname(rel) === path.relative(ROOT, dir) || (dir === ROOT && !rel.includes('/'))) {
        const base = path.basename(p);
        if (dir === ROOT) children.push({ name: base, isDirectory: () => true, isFile: () => false });
      }
    }
    // 简化：直接按层级返回
    if (dir === ROOT) return ['2026'].map((n) => ({ name: n, isDirectory: () => true, isFile: () => false }));
    if (dir.endsWith('2026')) return ['08'].map((n) => ({ name: n, isDirectory: () => true, isFile: () => false }));
    if (dir.endsWith('08')) return ['26'].map((n) => ({ name: n, isDirectory: () => true, isFile: () => false }));
    if (dir.endsWith('26')) {
      return [...files.keys()].filter((p) => path.dirname(p) === dir).map((p) => ({ name: path.basename(p), isDirectory: () => false, isFile: () => true }));
    }
    return [];
  };
  const statSync = (p) => ({ size: files.get(p)?.size || 0, mtimeMs: files.get(p)?.mtimeMs || 0 });
  const readFileSync = (p, opts) => {
    const f = files.get(p);
    if (!f) return '';
    const { start = 0, end = f.size } = opts || {};
    return f.content.slice(start, end);
  };
  return { readdirSync, statSync, readFileSync, files, ROOT };
}

const path = require('node:path');

test('findSessionLog：resume 按 session id 匹配；普通按启动时间最近', () => {
  const { readdirSync, statSync, files, ROOT } = makeDirTree();
  const allLogs = [{ path: `${ROOT}/2026/08/26/rollout-x-01a04000-0000-0000-0000-000000000001.jsonl`, mtimeMs: 1 }, { path: `${ROOT}/2026/08/26/rollout-y-01a04000-0000-0000-0000-000000000002.jsonl`, mtimeMs: 2 }];
  const assigned = new Set();
  const resumeProc = { sessionId: '01a04000-0000-0000-0000-000000000002', startTimeMs: 0 };
  const hit = findSessionLog(resumeProc, allLogs, assigned);
  assert.ok(hit.path.includes('000000000002'));
});

test('detectError 只检测增量增长部分，命中 429 / capacity', () => {
  const logPath = '/fake/rollout.jsonl';
  const size = Buffer.byteLength('first\n' + 'exceeded retry limit, last status: 429 Too Many Requests\n');
  const statSync = () => ({ size });
  const readFileSync = (p, o) => 'exceeded retry limit, last status: 429 Too Many Requests\n';
  const { hit, newSize } = detectError(logPath, 0, [/model at capacity/i, /exceeded retry limit, last status: 429 too many requests/i], readFileSync, statSync);
  assert.strictEqual(hit, true);
  assert.strictEqual(newSize, size);
});

test('scan 全流程：ps 找到 codex → 日志有错误 → 写 tty continue + \\r', () => {
  const { readdirSync, statSync, readFileSync, files, ROOT } = makeDirTree();
  const errLog = `${ROOT}/2026/08/26/rollout-2026-08-26T12-00-00-01a04000-0000-0000-0000-000000000003.jsonl`;
  const errContent = '{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests, request id: abc"}}}\n';
  files.set(errLog, { size: Buffer.byteLength(errContent), content: errContent, mtimeMs: new Date(2026, 7, 26, 12, 0, 0).getTime() });

  const writes = [];
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    sessionsDir: '/fake/.codex/sessions',
    io: {
      readdirSync, statSync, readFileSync,
      writeFileSync: (dev, data) => writes.push({ dev, data }),
    },
    cooldownMs: 30000,
    enterDelayMs: 0,
  });
  const n = scanner.scan();
  assert.strictEqual(n, 1);
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0].dev, '/dev/ttys011');
  assert.strictEqual(writes[0].data, 'continue');
  assert.strictEqual(writes[1].data, '\r');
});

test('scan：日志无新错误时不触发', () => {
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
  const errLog = `${ROOT}/2026/08/26/rollout-2026-08-26T12-00-00-01a04000-0000-0000-0000-000000000003.jsonl`;
  const errContent = '{"payload":{"type":"task_complete","error":{"message":"model at capacity"}}}\n';
  files.set(errLog, { size: Buffer.byteLength(errContent), content: errContent, mtimeMs: new Date(2026, 7, 26, 12, 0, 0).getTime() });

  const writes = [];
  const t = { value: 0 };
  const scanner = createScanner({
    execPs: () => ` 1000 Wed Aug 26 11:00:00 2026 ttys011 codex\n`,
    now: () => t.value,
    cooldownMs: 30000,
    enterDelayMs: 0,
    sessionsDir: '/fake/.codex/sessions',
    io: { readdirSync, statSync, readFileSync, writeFileSync: (d, x) => writes.push(x) },
  });
  scanner.scan(); // 触发
  assert.strictEqual(writes.length, 2);
  scanner.scan(); // 日志没变，不重复
  assert.strictEqual(writes.length, 2);
  // 日志增长出新错误但冷却内 → 不触发，但 lastSize 前进
  const err2 = errContent + '{"payload":{"type":"task_complete","error":{"message":"model at capacity"}}}\n';
  files.set(errLog, { size: Buffer.byteLength(err2), content: err2, mtimeMs: new Date(2026, 7, 26, 12, 0, 10).getTime() });
  t.value = 5000;
  scanner.scan();
  assert.strictEqual(writes.length, 2, '冷却内不触发');
  // 冷却过后日志再出现新错误 → 触发
  const err3 = err2 + '{"payload":{"type":"task_complete","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests, request id: zzz"}}}\n';
  files.set(errLog, { size: Buffer.byteLength(err3), content: err3, mtimeMs: new Date(2026, 7, 26, 12, 0, 20).getTime() });
  t.value = 40000;
  scanner.scan();
  assert.strictEqual(writes.length, 4, '冷却过后新错误触发');
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
  ps = ` 2000 Wed Aug 26 20:00:00 2026 ttys011 zsh\n`; // codex 退出了
  scanner.scan();
  assert.strictEqual(scanner.listCodexProcesses().length, 0);
});
