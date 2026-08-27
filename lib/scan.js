'use strict';
// lib/scan.js — codex-continue 核心（不依赖 tmux）
//
// 后台 daemon 每隔一段时间：
//   1. 用 `ps` 找出所有交互式 codex 进程（含 tty，排除 code-mode-host / vscode / app-server）
//   2. 对每个进程定位它在 ~/.codex/sessions 下的会话日志（rollout-*.jsonl）
//   3. 检测日志新增长部分是否有模型容量 / 429 限流错误
//   4. 命中后直接向该进程的 tty 设备（/dev/ttysXXX）写入 `continue` + 回车
//
// 全程不依赖 tmux：扫描靠 ps + codex 会话日志，发送靠写终端设备文件。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// 触发条件（均不区分大小写）。request id 每次不同，所以只锚定到 429 这一行。
const MATCHERS = [
  /model at capacity/i,
  /exceeded retry limit, last status: 429 too many requests/i,
];

const DEFAULT_COOLDOWN_MS = 30000;   // 同一进程两次自动发送之间的最短间隔
const DEFAULT_SEND = 'continue';     // 发给 codex 的命令文本（会追加一个回车）
const ENTER_DELAY_MS = 300;          // 文本与回车之间的延迟（codex 吞键规避）
const LOG_TAIL_BYTES = 256 * 1024;   // 每次只读日志尾部，避免大文件全读
const ERROR_WINDOW_MS = 10 * 60 * 1000; // 只对最近 10 分钟内发生的错误触发（历史错误忽略）
const VERIFY_WINDOW_MS = 15 * 1000;     // 发送后等待 codex 响应的观察窗口
const SILENCE_MS = 10 * 60 * 1000;      // codex 无响应（冻结）后的静默时长，期间不再发
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/** 同步 sleep。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultExecPs() {
  const r = spawnSync('ps', ['-axo', 'pid,lstart,tty,command'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout || '') : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Wed Aug 26 22:18:16 2026" → 毫秒时间戳（macOS ps lstart 格式）。 */
function parseLstart(lstart) {
  const m = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)/.exec(lstart || '');
  if (!m) return null;
  const [, mon, day, hh, mm, ss, yyyy] = m;
  return new Date(Number(yyyy), MONTHS.indexOf(mon), Number(day), Number(hh), Number(mm), Number(ss)).getTime();
}

/**
 * 用 ps 列出所有交互式 codex 进程。
 * @param {(args?: string[]) => string} [exec] ps 执行器（默认 spawnSync 'ps -axo ...'）
 * @returns {Array<{pid:number, tty:string, startTimeMs:number|null, command:string, sessionId:string|null}>}
 */
function listCodexProcesses(exec) {
  const out = typeof exec === 'function' ? exec() : defaultExecPs();
  const procs = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // pid lstart tty command：lstart 固定为 "Wed Aug 26 22:18:16 2026"（6 段）
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pidStr, lstart, tty, command] = m;
    const cmd = (command || '').trim();
    // 只处理交互式 codex TUI：裸 codex / codex resume
    const isTui = /^codex(\s|$)/.test(cmd);
    if (!isTui) continue;
    // 排除非交互变体
    if (/code-mode-host|app-server|features\.code_mode_host|vscode-server|vscode\.extensions/.test(cmd)) continue;
    if (tty === '??' || !tty) continue;
    const resume = /codex\s+resume\s+([^\s]+)/.exec(cmd);
    procs.push({
      pid: Number(pidStr),
      tty,
      startTimeMs: parseLstart(lstart),
      command: cmd,
      sessionId: resume ? resume[1] : null,
    });
  }
  return procs;
}

/** 递归收集 sessionsDir 下所有 rollout-*.jsonl，按 mtime 倒序。sessionsDir 可注入便于测试。 */
function collectSessionLogs(execReadDir = fs.readdirSync, execStat = fs.statSync, sessionsDir = SESSIONS_DIR) {
  const logs = [];
  const walk = (dir) => {
    let entries;
    try { entries = execReadDir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { logs.push({ path: full, mtimeMs: execStat(full).mtimeMs }); } catch {}
      }
    }
  };
  walk(sessionsDir);
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs;
}

/**
 * 定位进程对应的会话日志。
 * - resume 进程：文件名包含 session id（rollout-<ts>-<session_id>.jsonl）
 * - 普通 codex：进程启动后创建的最新日志（排除已分配给其它进程的）
 */
function findSessionLog(proc, allLogs, assigned) {
  if (proc.sessionId) {
    const hit = allLogs.find((l) => path.basename(l.path).includes(proc.sessionId));
    if (hit) return hit;
  }
  if (proc.startTimeMs == null) return null;
  const start = proc.startTimeMs - 30000; // 允许 30s 时钟差
  const cand = allLogs
    .filter((l) => !assigned.has(l.path) && l.mtimeMs >= start)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cand[0] || null;
}

/**
 * 检测日志尾部（从 fromBytes 到末尾）是否有容量/429 错误，并返回最近一次错误的
 * 时间戳。
 *
 * 只统计「task_complete 且 error 字段匹配」的错误行 —— codex 日志里的普通消息
 * （agent_message / function_call_output 等）文本也可能提到 "model at capacity" 或
 * "429"，整行正则会把它们误当错误，导致没报错也发 continue。task_complete error
 * 才表示 turn 因容量/限流失败结束、codex 停在输入框需要继续。无法解析 timestamp
 * 的行同样不计。
 * @returns {{ hit: boolean, newSize: number, lastErrorTime: number|null }}
 */
function detectError(logPath, fromBytes, patterns, execRead = fs.readFileSync, execStat = fs.statSync) {
  let size = 0;
  try { size = execStat(logPath).size; } catch { return { hit: false, newSize: 0, lastErrorTime: null }; }
  if (size <= fromBytes) return { hit: false, newSize: size, lastErrorTime: null };
  const start = Math.max(0, fromBytes, size - LOG_TAIL_BYTES);
  let chunk = '';
  try { chunk = execRead(logPath, { encoding: 'utf8', start, end: size }); } catch { return { hit: false, newSize: size, lastErrorTime: null }; }
  let lastErrorTime = null;
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    if (!patterns.some((re) => re.test(line))) continue; // 快速预筛
    let d = null;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload;
    if (!p || p.type !== 'task_complete' || !p.error) continue;
    const msg = typeof p.error === 'string' ? p.error : (p.error.message || '');
    if (!patterns.some((re) => re.test(String(msg)))) continue;
    const ts = Date.parse(d.timestamp);
    if (Number.isFinite(ts) && (lastErrorTime === null || ts > lastErrorTime)) lastErrorTime = ts;
  }
  return { hit: lastErrorTime !== null, newSize: size, lastErrorTime };
}

/**
 * 向进程 tty 设备写入 continue + 回车（分两次，规避 codex 吞掉紧跟文本的回车）。
 *
 * 回车必须用 `\n`（LF）而不是 `\r`（CR）：实测在 tmux 里运行的 codex，写 `\r` 只进
 * 输入框不提交（用户报的"输入了没发送"），写 `\n` 才正常提交进入 Working。普通终端
 * 下 codex 同样接受 `\n`。分两次写（文本 → 延迟 → 回车）规避 codex 吞键时序。
 */
function sendContinue(proc, send, enterDelayMs, writeTty = fs.writeFileSync) {
  const dev = `/dev/${proc.tty}`;
  writeTty(dev, send);
  if (enterDelayMs > 0) sleep(enterDelayMs);
  writeTty(dev, '\n');
}

/**
 * 创建 codex-continue 扫描器。
 * @param {object} opts
 * @param {() => string} [opts.execPs] ps 执行器（返回 ps 输出）
 * @param {string[]} [opts.matchers] 触发正则（RegExp 源字符串）
 * @param {number} [opts.cooldownMs] 同一进程两次发送的最短间隔，默认 30000
 * @param {string} [opts.send] 发送给 codex 的命令文本，默认 'continue'
 * @param {number} [opts.enterDelayMs] 文本与回车之间的延迟，默认 300
 * @param {number} [opts.errorWindowMs] 只对最近 N 毫秒内发生的错误触发，默认 10 分钟
 * @param {number} [opts.verifyWindowMs] 发送后验证 codex 是否响应的窗口，默认 15 秒
 * @param {number} [opts.silenceMs] codex 无响应后的静默时长，默认 10 分钟
 * @param {() => number} [opts.now] 时钟（毫秒）
 * @param {(msg: string) => void} [opts.onTrigger] 每次触发后的回调（日志用）
 * @param {string} [opts.sessionsDir] codex 会话日志根目录（测试注入用）
 * @param {object} [opts.io] 注入式 IO（测试用）：{ readFileSync, statSync, readdirSync, writeFileSync }
 * @returns {{ scan: () => number, listCodexProcesses: () => Array<object> }}
 */
function createScanner({
  execPs, matchers, cooldownMs, send, enterDelayMs, errorWindowMs, verifyWindow, silence, now, onTrigger, sessionsDir, io,
} = {}) {
  const runPs = execPs || defaultExecPs;
  const patterns = (matchers || MATCHERS).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const text = send ?? DEFAULT_SEND;
  const delay = enterDelayMs ?? ENTER_DELAY_MS;
  const windowMs = errorWindowMs ?? ERROR_WINDOW_MS;
  const verifyWindowMs = verifyWindow ?? VERIFY_WINDOW_MS;
  const silenceMs = silence ?? SILENCE_MS;
  const clock = now || (() => Date.now());
  const ioImpl = { readFileSync: fs.readFileSync, statSync: fs.statSync, readdirSync: fs.readdirSync, writeFileSync: fs.writeFileSync, ...(io || {}) };
  // pid → { logPath, lastSize, lastAt }
  const states = new Map();

  function scan() {
    let triggered = 0;
    const procs = listCodexProcesses(runPs);
    const allLogs = collectSessionLogs(ioImpl.readdirSync, ioImpl.statSync, sessionsDir);
    const assigned = new Set();
    const seenPids = new Set();

    for (const proc of procs) {
      seenPids.add(proc.pid);
      const log = findSessionLog(proc, allLogs, assigned);
      if (!log) continue;
      assigned.add(log.path);

      let st = states.get(proc.pid);
      if (!st) {
        st = { logPath: log.path, lastSize: 0, lastAt: Number.NEGATIVE_INFINITY, pendingVerify: false, verifyAt: 0, lastSendSize: 0, silencedUntil: 0 };
        states.set(proc.pid, st);
      }
      if (st.logPath !== log.path) {
        st.logPath = log.path;
        st.lastSize = 0; // 换了会话文件，重新从头检测
        st.pendingVerify = false;
        st.silencedUntil = 0;
      }

      const t = clock();
      // 发送后的验证：观察该会话日志是否在验证窗口内有新增长（codex 响应 continue
      // 开始 Working 会写日志）。没响应 = codex 冻结/无响应 → 静默一段时间不再发。
      if (st.pendingVerify) {
        let size = 0;
        try { size = ioImpl.statSync(log.path).size; } catch {}
        if (size > st.lastSendSize) {
          st.pendingVerify = false; // 有响应，正常
        } else if (t >= st.verifyAt) {
          st.pendingVerify = false;
          st.silencedUntil = t + silenceMs; // 冻结，静默
          if (onTrigger) onTrigger(`${proc.tty} (${proc.pid}) 无响应，冻结静默 ${Math.round(silenceMs / 60000)} 分钟`);
        }
      }
      if (t < st.silencedUntil) continue; // 冻结中，跳过

      const { hit, newSize, lastErrorTime } = detectError(log.path, st.lastSize, patterns, ioImpl.readFileSync, ioImpl.statSync);
      st.lastSize = newSize;
      if (!hit) continue;

      // 只对最近窗口内发生的错误触发 —— 历史错误（如会话很久前卡过、日志尾部残留）
      // 不能当"现在卡住了"处理，否则没报错也会反复发 continue。
      if (lastErrorTime !== null && t - lastErrorTime > windowMs) continue;
      if (t - st.lastAt < cooldown) continue;
      st.lastAt = t;

      try {
        sendContinue(proc, text, delay, ioImpl.writeFileSync);
        triggered += 1;
        st.pendingVerify = true;
        st.verifyAt = t + verifyWindowMs;
        st.lastSendSize = newSize;
        if (onTrigger) onTrigger(`sent "${text}" to ${proc.tty} (${proc.pid})`);
      } catch (e) {
        if (onTrigger) onTrigger(`写入 ${proc.tty} 失败: ${e.message}`);
      }
    }

    // 清理已消失的进程状态
    for (const pid of [...states.keys()]) {
      if (!seenPids.has(pid)) states.delete(pid);
    }
    return triggered;
  }

  return { scan, listCodexProcesses: () => listCodexProcesses(runPs) };
}

module.exports = {
  createScanner, listCodexProcesses, collectSessionLogs, findSessionLog,
  detectError, sendContinue, parseLstart,
  MATCHERS, DEFAULT_COOLDOWN_MS, DEFAULT_SEND, ENTER_DELAY_MS, ERROR_WINDOW_MS,
  VERIFY_WINDOW_MS, SILENCE_MS,
};
