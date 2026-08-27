'use strict';
// lib/scan.js — codex-continue 核心
//
// 每隔一段时间扫描本机所有 tmux 会话里的 codex pane：用 capture-pane 读屏幕输出，
// 检测到模型容量 / 429 限流错误时，用 tmux send-keys 向该 pane 发送 continue + 回车，
// 把卡住的 codex 推着继续跑。不依赖任何其他工具，只需要 tmux 和 codex 跑在 tmux 里。

const { spawnSync } = require('node:child_process');

// 触发条件（均不区分大小写）。request id 每次不同，所以只锚定到 429 这一行。
const MATCHERS = [
  /model at capacity/i,
  /exceeded retry limit, last status: 429 too many requests/i,
];

const DEFAULT_COOLDOWN_MS = 30000;   // 同一 pane 两次自动发送之间的最短间隔
const DEFAULT_SEND = 'continue';     // 发给 codex 的命令文本（会追加一个回车）
const CAPTURE_HISTORY_LINES = 100;   // capture-pane 往回读多少行
const BUFFER_LEN = 2048;             // 错误匹配的尾部缓冲（应对输出被分块切碎）

function defaultExec(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout || '') : '';
}

/** 列出本机所有 tmux 会话中当前前台命令为 codex 的 pane target（session:window.pane）。 */
function listCodexPanes(exec) {
  const out = exec(['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}']);
  if (!out) return [];
  const panes = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [target, command] = line.split('\t');
    if (target && command && command.trim() === 'codex') panes.push(target.trim());
  }
  return panes;
}

/** 读取 pane 最近若干行输出。 */
function capturePane(exec, target) {
  return exec(['capture-pane', '-p', '-t', target, '-S', `-${CAPTURE_HISTORY_LINES}`]);
}

/** 往 pane 发送指定文本 + 回车（key 名 Enter，与真实按键等价）。 */
function sendKeys(exec, target, send) {
  exec(['send-keys', '-t', target, send, 'Enter']);
}

/** 去掉 ANSI 控制序列后的文本指纹，用于判断「屏幕有没有变化」。 */
function hashText(s) {
  const clean = String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  let h = 5381;
  for (let i = 0; i < clean.length; i++) h = ((h << 5) + h + clean.charCodeAt(i)) | 0;
  return String(h);
}

/**
 * 创建 codex-continue 扫描器。
 * @param {object} opts
 * @param {(args: string[]) => string} [opts.exec] tmux 执行器，默认 spawnSync 'tmux'
 * @param {string[]} [opts.matchers] 触发正则（RegExp 源字符串）
 * @param {number} [opts.cooldownMs] 同一 pane 两次发送的最短间隔，默认 30000
 * @param {string} [opts.send] 发送给 codex 的命令文本，默认 'continue'
 * @param {() => number} [opts.now] 时钟（毫秒）
 * @param {(msg: string) => void} [opts.onTrigger] 每次触发后的回调（日志用）
 * @returns {{ scan: () => number, listCodexPanes: () => string[] }}
 */
function createScanner({ exec, matchers, cooldownMs, send, now, onTrigger } = {}) {
  const run = exec || defaultExec;
  const patterns = (matchers || MATCHERS).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const text = send ?? DEFAULT_SEND;
  const clock = now || (() => Date.now());
  // target → { buffer, lastSig, lastAt }
  const panes = new Map();

  function scan() {
    let triggered = 0;
    const targets = listCodexPanes(run);
    const seen = new Set(targets);

    for (const target of targets) {
      const cur = capturePane(run, target);
      if (!cur) continue;

      const sig = hashText(cur);
      let state = panes.get(target);
      if (!state) {
        // lastAt 初始为 -Infinity：保证首次扫描必能通过冷却检查
        state = { buffer: '', lastSig: null, lastAt: Number.NEGATIVE_INFINITY };
        panes.set(target, state);
      }

      // 屏幕指纹没变 = 错误文本原样停在屏幕上，不重复抽（哪怕冷却已过）。
      if (sig === state.lastSig) continue;

      // 尾部缓冲累积最近一段输出，跨 chunk 匹配。
      state.buffer = (state.buffer + cur).slice(-BUFFER_LEN);
      if (!patterns.some((re) => re.test(state.buffer))) continue;

      const t = clock();
      if (t - state.lastAt < cooldown) continue;

      state.lastAt = t;
      state.lastSig = sig;
      sendKeys(run, target, text);
      triggered += 1;
      if (onTrigger) onTrigger(`sent "${text}" to ${target}`);
    }

    // 清理已消失的 pane
    for (const k of [...panes.keys()]) {
      if (!seen.has(k)) panes.delete(k);
    }
    return triggered;
  }

  return { scan, listCodexPanes: () => listCodexPanes(run) };
}

module.exports = {
  createScanner, listCodexPanes, capturePane, sendKeys, hashText,
  MATCHERS, DEFAULT_COOLDOWN_MS, DEFAULT_SEND,
};
