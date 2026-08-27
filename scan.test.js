'use strict';
// test/scan.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createScanner, hashText, listCodexPanes, DEFAULT_SEND } = require('../lib/scan');

// 注入式 tmux 执行器：按参数返回假输出，send-keys 记录到 calls。
// panes 元素可以是字符串（视为 codex pane）或 { target, cmd }。
function makeEnv({ panes, captureText }) {
  const sends = [];
  let captureCall = 0;
  const exec = (args) => {
    if (args[0] === 'list-panes') {
      return panes
        .map((p) => (typeof p === 'string' ? { target: p, cmd: 'codex' } : p))
        .map((p) => `${p.target}\t${p.cmd}`)
        .join('\n');
    }
    if (args[0] === 'capture-pane') {
      return typeof captureText === 'function' ? captureText(captureCall++) : captureText;
    }
    if (args[0] === 'send-keys') {
      sends.push(args); // ['send-keys','-t',target,send,'Enter']
      return '';
    }
    return '';
  };
  return { exec, sends };
}

function nowStub(start = 0) {
  const t = { value: start };
  return { now: () => t.value, t };
}

test('listCodexPanes 返回 codex pane target', () => {
  const { exec } = makeEnv({ panes: ['sess:0.0', 'sess:1.2'] });
  assert.deepStrictEqual(listCodexPanes(exec), ['sess:0.0', 'sess:1.2']);
});

test('命中 "model at capacity" → 分两次发送文本与 Enter', () => {
  const { exec, sends } = makeEnv({ panes: ['codex:0.0'], captureText: 'ERROR: model at capacity\n' });
  const scanner = createScanner({ exec, enterDelayMs: 0 });
  assert.strictEqual(scanner.scan(), 1);
  // codex 吞键规避：文本与 Enter 必须分两次 send-keys
  assert.deepStrictEqual(sends[0], ['send-keys', '-t', 'codex:0.0', DEFAULT_SEND]);
  assert.deepStrictEqual(sends[1], ['send-keys', '-t', 'codex:0.0', 'Enter']);
});

test('命中 429 "exceeded retry limit" → 触发', () => {
  const { exec, sends } = makeEnv({
    panes: ['codex:0.0'],
    captureText: 'exceeded retry limit, last status: 429 Too Many Requests, request id: abc\n',
  });
  const scanner = createScanner({ exec, enterDelayMs: 0 });
  assert.strictEqual(scanner.scan(), 1);
  assert.strictEqual(sends.length, 2, '一次触发 = 文本 + Enter 两条');
});

test('同一屏错误不重复触发（指纹去重）', () => {
  const { exec, sends } = makeEnv({ panes: ['codex:0.0'], captureText: () => 'ERROR: model at capacity\n' });
  const scanner = createScanner({ exec, enterDelayMs: 0 });
  scanner.scan();
  scanner.scan();
  scanner.scan();
  assert.strictEqual(sends.length, 2);
});

test('屏幕变化但冷却期内 → 不重复；冷却过后屏幕再变 → 恢复', () => {
  let n = 0;
  const { exec, sends } = makeEnv({ panes: ['codex:0.0'], captureText: () => `ERROR: model at capacity [${n++}]\n` });
  const { now, t } = nowStub(0);
  const scanner = createScanner({ exec, enterDelayMs: 0, now, cooldownMs: 30000 });
  scanner.scan(); // t=0 触发
  assert.strictEqual(sends.length, 2);
  t.value += 5000;
  scanner.scan(); // 冷却期
  assert.strictEqual(sends.length, 2);
  t.value += 40000;
  scanner.scan(); // 冷却过，屏幕已变 → 触发
  assert.strictEqual(sends.length, 4);
});

test('错误消失又出现 → 可以再次触发', () => {
  const texts = ['ERROR: model at capacity\n', 'prompt> ok\n', 'ERROR: model at capacity again\n'];
  const { exec, sends } = makeEnv({ panes: ['codex:0.0'], captureText: () => texts.shift() || '' });
  const { now, t } = nowStub(0);
  const scanner = createScanner({ exec, enterDelayMs: 0, now, cooldownMs: 30000 });
  scanner.scan(); // 命中
  t.value += 5000;
  scanner.scan(); // 无错误
  assert.strictEqual(sends.length, 2);
  t.value += 40000;
  scanner.scan(); // 错误再现 → 再触发
  assert.strictEqual(sends.length, 4);
});

test('无关输出不触发', () => {
  const { exec, sends } = makeEnv({
    panes: ['codex:0.0'],
    captureText: 'some normal log\nHTTP 500 Error\n',
  });
  const scanner = createScanner({ exec, enterDelayMs: 0 });
  assert.strictEqual(scanner.scan(), 0);
  assert.strictEqual(sends.length, 0);
});

test('跨 chunk 拆分错误文本仍命中（尾部缓冲）', () => {
  const parts = ['exceeded retry ', 'limit, last status: 429 Too ', 'Many Requests, request id: x'];
  const { exec, sends } = makeEnv({ panes: ['codex:0.0'], captureText: () => parts.shift() || '' });
  const scanner = createScanner({ exec, enterDelayMs: 0 });
  scanner.scan();
  scanner.scan();
  scanner.scan();
  assert.strictEqual(sends.length, 2, '三次累计后尾部缓冲应命中');
});

test('自定义 send 文本生效', () => {
  const { exec, sends } = makeEnv({ panes: ['codex:0.0'], captureText: 'ERROR: model at capacity\n' });
  const scanner = createScanner({ exec, enterDelayMs: 0, send: '继续' });
  scanner.scan();
  assert.deepStrictEqual(sends[0], ['send-keys', '-t', 'codex:0.0', '继续']);
  assert.deepStrictEqual(sends[1], ['send-keys', '-t', 'codex:0.0', 'Enter']);
});

test('pane 消失后状态被清理', () => {
  const panes = ['codex:0.0'];
  const { exec } = makeEnv({ panes, captureText: '' });
  const scanner = createScanner({ exec, enterDelayMs: 0 });
  scanner.scan();
  assert.strictEqual(scanner.listCodexPanes().length, 1);
  // 模拟该 pane 退出，换成非 codex pane
  panes.length = 0;
  panes.push({ target: 'sess:0.0', cmd: 'zsh' });
  scanner.scan();
  assert.strictEqual(scanner.listCodexPanes().length, 0);
});

test('hashText 忽略 ANSI 控制序列', () => {
  assert.strictEqual(hashText('\x1b[31mERROR\x1b[0m: model at capacity'), hashText('ERROR: model at capacity'));
});
