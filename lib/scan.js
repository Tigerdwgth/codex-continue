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
const VERIFY_WINDOW_MS = 15 * 1000;     // 发送后等待 codex 响应的观察窗口
const SILENCE_MS = 10 * 60 * 1000;      // codex 无响应（冻结）后的静默时长，期间不再发
// 日志 mtime 在最近多少毫秒内更新过 = 会话仍活跃（codex 在写日志）。活跃中的会话
// 即使日志尾部出现过 429（codex 可能在自动重试），也不能发 continue 打扰。
// 只有日志停滞（codex 完全没在写 = 真卡住）且最后错误是 429 时才需要推。
const STALE_MS = 20 * 1000;
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/** 同步 sleep。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultExecPs() {
  // LC_ALL=C 强制 ps 的 lstart 输出英文日期（"Wed Aug 26 22:18:16 2026"）。
  // 本机 LANG=zh_CN.UTF-8 时 ps 会输出中文（"四 8月/27 08:38:53 2026"），
  // 解析正则只认英文格式，导致一个进程都匹配不上。
  const r = spawnSync('ps', ['-axo', 'pid,lstart,tty,command'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  return r.status === 0 ? (r.stdout || '') : '';
}

function defaultExecTmux(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout || '') : '';
}

/**
 * 列出所有 tmux pane 的 tty → target 映射（/dev/ttysXXX → session:win.pane）。
 * codex 跑在 tmux 里时，写 tty slave 到不了 codex（输入必须走 tmux 服务器），
 * 所以要能根据 codex 进程的 tty 找到它所在的 pane，改用 tmux send-keys。
 */
function listTmuxPaneTargets(exec = defaultExecTmux) {
  const out = exec(['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}']);
  const map = new Map();
  if (!out) return map;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ttyPath, target] = line.split('\t');
    if (ttyPath && target) map.set(ttyPath.trim(), target.trim());
  }
  return map;
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
 * @returns {Array<{pid:number, tty:string, tmuxTarget:string|null, startTimeMs:number|null, command:string, sessionId:string|null}>}
 */
function listCodexProcesses(exec, tmuxTargets = new Map()) {
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
      tmuxTarget: tmuxTargets.get(`/dev/${tty}`) || null,
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

function defaultExecLsof(pid) {
  const r = spawnSync('lsof', ['-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  return r.status === 0 ? (r.stdout || '') : '';
}

/**
 * 用 lsof 找出 codex 进程真正打开的会话日志（rollout-*.jsonl）。
 *
 * 为什么必须用 lsof：codex resume（不带 session id）时进程会加载多个历史会话上下文，
 * 打开多个 rollout 文件（fd 列表里能看到）。ps 只知道进程启动时间，拿"启动后最新 mtime
 * 的日志"来猜在并发多会话下必然错配 —— 曾把 ttys011 配到一个它根本没打开的老日志上，
 * 导致检测到的是别的会话的错误、永远不触发。lsof 直接看 fd，准确锁定当前会话。
 * @param {number} pid
 * @param {string} sessionsDir codex 会话日志根目录
 * @param {(pid:number)=>string} [execLsof] lsof 执行器（测试注入用）
 * @returns {string[]} 该进程打开的会话日志绝对路径
 */
function listOpenSessionLogs(pid, sessionsDir, execLsof) {
  const base = sessionsDir || SESSIONS_DIR;
  const out = typeof execLsof === 'function' ? execLsof(pid) : defaultExecLsof(pid);
  const hits = new Set();
  for (const line of out.split('\n')) {
    const m = /(rollout-[\dTZ:.-]+-[0-9a-f-]+\.jsonl)$/.exec(line.trim());
    if (!m) continue;
    const fileName = m[1];
    // 只认 sessionsDir 下的 rollout 日志
    if (fileName.startsWith('rollout-')) hits.add(fileName);
  }
  if (hits.size === 0) return [];
  return [...hits].map((bn) => {
    // 递归查找 sessionsDir 下的实际路径（按日期分目录）
    const found = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === bn) found.push(full);
      }
    };
    walk(base);
    return found[0] || null;
  }).filter(Boolean);
}

/**
 * 定位进程对应的会话日志。
 * - resume 进程：文件名包含 session id（rollout-<ts>-<session_id>.jsonl）
 * - 优先：lsof 探测该进程真实打开的 rollout 文件（codex resume 会打开多个历史会话，
 *   从中选未分配给其它进程的最新者 —— 当前活跃会话通常是最近写入的那个）
 * - 回退：进程启动后创建的最新日志（排除已分配给其它进程的）
 */
function findSessionLog(proc, allLogs, assigned, openLogs) {
  if (proc.sessionId) {
    const hit = allLogs.find((l) => path.basename(l.path).includes(proc.sessionId));
    if (hit) return hit;
  }
  // lsof 探测优先：codex 进程真实打开的文件，选最近写入者。
  // 不参与 assigned 去重 —— lsof 是进程真实 fd 的硬证据，即使别的进程的猜分支
  // 误抢过这个文件，这里也要还给它。多个进程共享同一日志文件时（codex resume
  // 会加载历史上下文）各自真实打开的文件可能重叠，但 mtime 最新者归当前活跃会话。
  if (openLogs && openLogs.length > 0) {
    const cand = openLogs
      .map((p) => allLogs.find((l) => l.path === p))
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (cand.length > 0) return cand[0];
  }
  // 完全无 openLogs（lsof 拿不到）时才回退猜：进程启动后创建的最新日志。
  if (proc.startTimeMs == null) return null;
  const start = proc.startTimeMs - 30000; // 允许 30s 时钟差
  const cand = allLogs
    .filter((l) => !assigned.has(l.path) && l.mtimeMs >= start)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cand[0] || null;
}

/**
 * 检测日志尾部（从 fromBytes 到末尾）是否有容量/429 错误，返回最近错误时间戳，
 * 以及错误之后是否已有新活动（activeAfterError）。
 *
 * 只统计「task_complete 且 error 字段匹配」的错误行 —— codex 日志里的普通消息
 * （agent_message / function_call_output 等）文本也可能提到 "model at capacity" 或
 * "429"，整行正则会把它们误当错误，导致没报错也发 continue。task_complete error
 * 才表示 turn 因容量/限流失败结束。无法解析 timestamp 的行同样不计。
 *
 * activeAfterError=true 表示错误之后日志里还有新事件 —— 说明会话在报错后已经恢复
 * /继续工作了（如用户手动 continue、或 codex 自己重试成功），此时不该再自动
 * continue 打扰。只有会话"停在错误上"（错误是最后一条）才需要推。
 * @returns {{ hit: boolean, newSize: number, lastErrorTime: number|null, activeAfterError: boolean }}
 */
function detectError(logPath, fromBytes, patterns, execRead = fs.readFileSync, execStat = fs.statSync) {
  let size = 0;
  let mtimeMs = 0;
  try { const st = execStat(logPath); size = st.size; mtimeMs = st.mtimeMs || 0; } catch { return { hit: false, newSize: 0, lastErrorTime: null, activeAfterError: false, mtimeMs: 0 }; }
  if (size <= fromBytes) return { hit: false, newSize: size, lastErrorTime: null, activeAfterError: false, mtimeMs };
  const start = Math.max(0, fromBytes, size - LOG_TAIL_BYTES);
  let chunk = '';
  try { chunk = execRead(logPath, { encoding: 'utf8', start, end: size }); } catch { return { hit: false, newSize: size, lastErrorTime: null, activeAfterError: false, mtimeMs }; }
  let lastErrorTime = null;
  let lastLineTime = null;
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let d = null;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload;
    if (!p) continue;
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts)) continue;
    // lastLineTime 统计所有事件的最新时间（不含关键词的普通事件也计入），
    // 用于判断错误之后会话是否已恢复活动。
    if (lastLineTime === null || ts > lastLineTime) lastLineTime = ts;
    if (p.type === 'task_complete' && p.error) {
      const msg = typeof p.error === 'string' ? p.error : (p.error.message || '');
      if (patterns.some((re) => re.test(String(msg)))) {
        if (lastErrorTime === null || ts > lastErrorTime) lastErrorTime = ts;
      }
    }
  }
  return {
    hit: lastErrorTime !== null,
    newSize: size,
    lastErrorTime,
    activeAfterError: lastErrorTime !== null && lastLineTime !== null && lastLineTime > lastErrorTime,
    mtimeMs,
  };
}

/**
 * 向 codex 发送 continue + 回车（分两次，规避 codex 吞掉紧跟文本的回车）。
 *
 * 关键：codex 跑在 tmux 里时，直接写 tty slave（/dev/ttysXXX）**到不了 codex** ——
 * 输入必须走 tmux 服务器（用户手动打字就是这条路径），写 slave 的字符只被终端 echo
 * 显示、codex 收不到。所以：
 * - 在 tmux 里（proc.tmuxTarget）：用 tmux send-keys 发送（文本 + 回车分两次）
 * - 普通终端：直接写 tty 设备，回车用 `\n`
 */
function sendContinue(proc, send, enterDelayMs, { sendTmux, writeTty } = {}) {
  const run = sendTmux || defaultExecTmux;
  const write = writeTty || fs.writeFileSync;
  if (proc.tmuxTarget) {
    run(['send-keys', '-t', proc.tmuxTarget, send]);
    if (enterDelayMs > 0) sleep(enterDelayMs);
    run(['send-keys', '-t', proc.tmuxTarget, 'Enter']);
  } else {
    const dev = `/dev/${proc.tty}`;
    write(dev, send);
    if (enterDelayMs > 0) sleep(enterDelayMs);
    write(dev, '\n');
  }
}

/**
 * 创建 codex-continue 扫描器。
 * @param {object} opts
 * @param {() => string} [opts.execPs] ps 执行器（返回 ps 输出）
 * @param {string[]} [opts.matchers] 触发正则（RegExp 源字符串）
 * @param {number} [opts.cooldownMs] 同一进程两次发送的最短间隔，默认 30000
 * @param {string} [opts.send] 发送给 codex 的命令文本，默认 'continue'
 * @param {number} [opts.enterDelayMs] 文本与回车之间的延迟，默认 300
 * @param {number} [opts.verifyWindowMs] 发送后验证 codex 是否响应的窗口，默认 15 秒
 * @param {number} [opts.silenceMs] codex 无响应后的静默时长，默认 10 分钟
 * @param {() => number} [opts.now] 时钟（毫秒）
 * @param {(msg: string) => void} [opts.onTrigger] 每次触发后的回调（日志用）
 * @param {string} [opts.sessionsDir] codex 会话日志根目录（测试注入用）
 * @param {object} [opts.io] 注入式 IO（测试用）：{ readFileSync, statSync, readdirSync, writeFileSync }
 * @returns {{ scan: () => number, listCodexProcesses: () => Array<object> }}
 */
function createScanner({
  execPs, execTmux, execLsof, matchers, cooldownMs, send, enterDelayMs, verifyWindow, silence, now, onTrigger, sessionsDir, io,
} = {}) {
  const runPs = execPs || defaultExecPs;
  const runTmux = execTmux || defaultExecTmux;
  const patterns = (matchers || MATCHERS).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const text = send ?? DEFAULT_SEND;
  const delay = enterDelayMs ?? ENTER_DELAY_MS;
  const verifyWindowMs = verifyWindow ?? VERIFY_WINDOW_MS;
  const silenceMs = silence ?? SILENCE_MS;
  const clock = now || (() => Date.now());
  const ioImpl = { readFileSync: fs.readFileSync, statSync: fs.statSync, readdirSync: fs.readdirSync, writeFileSync: fs.writeFileSync, ...(io || {}) };
  // pid → { logPath, lastSize, lastAt }
  const states = new Map();

  function scan() {
    let triggered = 0;
    // 一次构建 tmux pane 的 tty→target 映射，给 codex 进程标注它所在的 pane
    const tmuxTargets = listTmuxPaneTargets(runTmux);
    const procs = listCodexProcesses(runPs, tmuxTargets);
    const allLogs = collectSessionLogs(ioImpl.readdirSync, ioImpl.statSync, sessionsDir);
    const assigned = new Set();
    const seenPids = new Set();

    for (const proc of procs) {
      seenPids.add(proc.pid);
      const t = clock();
      const openLogs = listOpenSessionLogs(proc.pid, sessionsDir, execLsof);
      // 进程可能打开多个历史会话日志（codex resume 加载的上下文），但**当前活跃**的
      // 只有一个 —— mtime 最新的那个。只有它「停在 429 上且之后无新活动」才需要推，
      // 旧日志（早已结束的会话）即使以 429 结尾也不能当"现在卡住"处理，否则会向
      // 正常停下的会话乱发 continue。
      const candidates = openLogs.length > 0
        ? openLogs.map((p) => allLogs.find((l) => l.path === p)).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)
        : [];
      // 日志 = 进程当前活跃的那个（lsof 最新）；无 lsof 时才回退猜分支。
      const log = candidates.length > 0 ? candidates[0] : findSessionLog(proc, allLogs, assigned, candidates);
      if (!log) continue;
      // lsof 硬证据命中的日志不参与全局去重 —— 它是该进程真实打开的，别的进程的
      // 猜分支不应抢占；只有回退猜分支（无 openLogs）才需要 assigned 防重。
      if (candidates.length === 0) assigned.add(log.path);

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

      // 发送后的验证：判断 continue 是否真的让会话恢复了。
      // - tmux 会话：看屏幕 429 是否消失（continue 生效的标志）
      // - 普通终端：看日志是否增长（开始 Working 会写日志）
      // continue 没让它恢复（屏幕 429 仍在 / 日志不增长）→ 进入长静默，不再 30s 重发
      // 同一个卡住事件只推一次，避免 queued continue 堆积污染 codex 输入。
      if (st.pendingVerify) {
        let recovered = false;
        if (proc.tmuxTarget) {
          try {
            const paneOut = runTmux(['capture-pane', '-p', '-t', proc.tmuxTarget]);
            recovered = !patterns.some((re) => re.test(paneOut));
          } catch { recovered = false; }
        } else {
          let size = 0;
          try { size = ioImpl.statSync(log.path).size; } catch {}
          recovered = size > st.lastSendSize;
        }
        if (recovered) {
          st.pendingVerify = false; // continue 生效，会话恢复
        } else if (t >= st.verifyAt) {
          st.pendingVerify = false;
          st.silencedUntil = t + silenceMs; // continue 无效 → 长静默，等它自己恢复或用户介入
          if (onTrigger) onTrigger(`${proc.tty} (${proc.pid}) continue 未恢复，静默 ${Math.round(silenceMs / 60000)} 分钟`);
        }
      }
      if (st.silencedUntil > 0 && t < st.silencedUntil) {
        // 静默中：如果屏幕 429 已消失（会话恢复），提前解除静默恢复正常监听；
        // 否则继续静默等待。
        if (proc.tmuxTarget) {
          try {
            const paneOut = runTmux(['capture-pane', '-p', '-t', proc.tmuxTarget]);
            if (!patterns.some((re) => re.test(paneOut))) {
              st.silencedUntil = 0; // 恢复了，解除静默
            }
          } catch {}
        }
        if (st.silencedUntil > 0 && t < st.silencedUntil) continue;
      }

      const { hit, newSize, lastErrorTime, activeAfterError, mtimeMs } = detectError(log.path, st.lastSize, patterns, ioImpl.readFileSync, ioImpl.statSync);
      st.lastSize = newSize;

      // 屏幕检测：tmux 会话直接看屏幕文本，codex 的某些 429 只显示在 TUI 上、
      // 不写日志，只能靠屏幕判断「现在是否卡在 429」。
      // 注意：只抓**当前屏幕**（不带 -S），带 -S 会把滚动历史里的旧 429 残留
      // 也算命中 —— 会话已恢复但历史行还在，导致对已恢复的会话反复发 continue。
      let screenHit = false;
      if (proc.tmuxTarget) {
        try {
          const paneOut = runTmux(['capture-pane', '-p', '-t', proc.tmuxTarget]);
          screenHit = patterns.some((re) => re.test(paneOut));
        } catch { screenHit = false; }
      }

      // 触发条件（满足任一）：
      // 1. 日志里错误是最后一条（activeAfterError=false）+ 日志停滞（没在写）
      // 2. tmux 屏幕实时显示 429/capacity 错误
      if (!screenHit) {
        if (!hit) continue;
        const logStale = mtimeMs !== 0 && t - mtimeMs >= STALE_MS; // 日志停滞 = codex 没在写
        // 日志 mtime 新鲜（在写）= codex 活跃/正在自动重试，不打扰
        if (!logStale) continue;
        // 日志已停滞但 429 后还有活动（如正常完成任务、日志最后不是错误）→ 不推
        if (activeAfterError) continue;
        // 进程在最近一次错误之后才启动（刚 resume 历史会话）→ 由用户自己控制
        if (proc.startTimeMs !== null && lastErrorTime !== null && proc.startTimeMs > lastErrorTime) continue;
      }

      if (t - st.lastAt < cooldown) continue;
      st.lastAt = t;

      try {
        sendContinue(proc, text, delay, { sendTmux: runTmux, writeTty: ioImpl.writeFileSync });
        triggered += 1;
        st.pendingVerify = true;
        st.verifyAt = t + verifyWindowMs;
        st.lastSendSize = newSize;
        if (onTrigger) onTrigger(`sent "${text}" to ${proc.tty} (${proc.pid})${proc.tmuxTarget ? ` via tmux ${proc.tmuxTarget}` : ''}`);
      } catch (e) {
        if (onTrigger) onTrigger(`发送到 ${proc.tty} 失败: ${e.message}`);
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
  createScanner, listCodexProcesses, listTmuxPaneTargets, collectSessionLogs, findSessionLog,
  listOpenSessionLogs, detectError, sendContinue, parseLstart,
  MATCHERS, DEFAULT_COOLDOWN_MS, DEFAULT_SEND, ENTER_DELAY_MS,
  VERIFY_WINDOW_MS, SILENCE_MS, STALE_MS,
};
