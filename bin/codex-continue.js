#!/usr/bin/env node
'use strict';
// bin/codex-continue.js — codex-continue CLI
//
// codex-continue [--once] [--interval 5] [--cooldown 30] [--send continue]
// codex-continue --status | --stop
//
// 默认以 watch（daemon）模式运行：每 --interval 秒扫描一次全部 tmux 里的 codex
// 会话，发现模型容量 / 429 限流错误就自动发 continue + 回车。
// --once 跑完一次立即退出（适合 cron 定时）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createScanner } = require('../lib/scan');

const RUNTIME_DIR = path.join(os.homedir(), '.codex-continue');
const PID_FILE = path.join(RUNTIME_DIR, 'codex-continue.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'codex-continue.log');

const pkg = require('../package.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { return null; }
}

function isRunning() {
  const pid = readPid();
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

function parseArgs(argv) {
  const opts = { intervalSec: 5, cooldownMs: 30000, send: 'continue', once: false, status: false, stop: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--once' || a === '-1') opts.once = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--stop') opts.stop = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--interval' || a === '-i') opts.intervalSec = Number(next());
    else if (a === '--cooldown' || a === '-c') opts.cooldownMs = Number(next()) * 1000;
    else if (a === '--send' || a === '-s') opts.send = next();
    else { console.error(`未知参数: ${a}`); opts.help = true; }
  }
  return opts;
}

function help() {
  console.log(`codex-continue v${pkg.version}
自动续跑卡住的 codex：定期扫描全部 tmux 里的 codex 会话，
遇到 model at capacity / 429 rate-limit 错误自动发送 continue + 回车。

用法:
  codex-continue                watch 模式，每 5s 扫描一次（默认，前台运行）
  codex-continue --once         只扫描一次，立即退出
  codex-continue --interval 10  设置扫描间隔（秒，默认 5）
  codex-continue --cooldown 30  同一会话两次发送的最小间隔（秒，默认 30）
  codex-continue --send continue 自定义发送文本（默认 continue）
  codex-continue --status       查看 watch 是否在运行
  codex-continue --stop         停止 watch

cron 用法:  */1 * * * * codex-continue --once
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) { console.log(pkg.version); return; }
  if (opts.help) { help(); return; }

  if (opts.status) {
    const pid = isRunning();
    console.log(pid ? `codex-continue 运行中 (PID ${pid})` : 'codex-continue 未在运行');
    return;
  }
  if (opts.stop) {
    const pid = isRunning();
    if (!pid) { console.log('未在运行'); return; }
    try { process.kill(pid, 'SIGTERM'); console.log(`已停止 (PID ${pid})`); } catch { console.log('停止失败'); }
    return;
  }

  const scanner = createScanner({
    cooldownMs: opts.cooldownMs,
    send: opts.send,
    onTrigger: (msg) => log(`[trigger] ${msg}`),
  });

  if (opts.once) {
    try {
      const n = scanner.scan();
      console.log(`扫描完成，触发 ${n} 个会话`);
    } catch (e) {
      console.error('扫描失败:', e.message);
      process.exit(1);
    }
    return;
  }

  // watch 模式：若已有实例在跑，提示后退出（幂等）。
  const existing = isRunning();
  if (existing) {
    console.log(`codex-continue 已在运行 (PID ${existing})，如需换参先 --stop`);
    process.exit(0);
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  log(`codex-continue v${pkg.version} watch 启动 (interval=${opts.intervalSec}s, cooldown=${opts.cooldownMs}ms, send="${opts.send}")`);
  const scanOnce = () => {
    try {
      const n = scanner.scan();
      if (n > 0) log(`本轮触发 ${n} 个会话`);
    } catch (e) {
      log(`扫描出错: ${e.message}`);
    }
  };
  scanOnce();
  // 注意：不要 unref —— detached 子进程下 unref 的 timer 无法阻止事件循环空转退出，
  // watch 必须常驻直到收到 SIGTERM/SIGINT。
  const timer = setInterval(scanOnce, opts.intervalSec * 1000);

  const cleanup = () => {
    clearInterval(timer);
    try { fs.unlinkSync(PID_FILE); } catch {}
    log('watch 停止');
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// 支持 `codex-continue start`（后台）——内部 fork 一个 detached 子进程跑 watch。
function maybeDaemonize() {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'start') return false;
  const existing = isRunning();
  if (existing) { console.log(`codex-continue 已在运行 (PID ${existing})`); return true; }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const child = spawn(process.execPath, [__filename, ...argv.slice(1)], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  console.log(`已后台启动 (PID ${child.pid})，日志: ${LOG_FILE}`);
  return true;
}

if (maybeDaemonize()) process.exit(0);
main().catch((e) => { console.error(e); process.exit(1); });
