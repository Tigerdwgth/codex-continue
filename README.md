# codex-continue

自动续跑卡住的 codex 会话。后台守护程序每隔一段时间扫描本机**所有** codex 会话
（通过 `ps` 找运行中的 codex 进程 + 解析 `~/.codex/sessions` 下的会话日志），遇到
模型容量（`model at capacity`）或 429 限流（`exceeded retry limit, last status: 429
Too Many Requests`）错误时，自动向对应 codex 终端发送 `continue` + 回车，把停住的
codex 推着继续跑，无需人工干预。

codex 配套插件：**不依赖 tmux**，只要 codex 跑在终端里（普通终端 / tmux / dashboard
均适用），本机是 macOS / Linux 即可。

## 工作原理

1. 每隔 `--interval` 秒（默认 5s）用 `ps -axo pid,lstart,tty,command` 找到所有
   交互式 codex 进程（裸 `codex` / `codex resume`，排除 code-mode-host、vscode、
   app-server 等后台变体），拿到进程的 tty；
2. 对每个进程定位它的会话日志：优先用 `lsof` 探测该进程**真实打开**的
   `~/.codex/sessions/**/rollout-*.jsonl` 文件（`codex resume` 不带 session id 时会
   同时打开多个历史会话日志，靠猜必然错配）；`codex resume <session-id>` 按 session
   id 精确匹配，其余按启动时间匹配最近日志；
3. 只检测日志**新增长**部分的 429 / 容量错误（不区分大小写，滚动历史不重复触发），
   且只对「错误是最后一条、会话停住在错误上」的会话触发 —— 错误之后已有新活动
   （已恢复）的不打扰；
4. 命中后直接向该进程的终端设备（`/dev/<tty>`）分两次写入 `continue` 和回车
   —— 先写文本、稍等 300ms 再写回车（`\n`）。两个坑：
   - codex 的 TUI 会吞掉"紧跟文本的回车"（一次写入文本+回车时只输入不提交），
     必须分两次写；
   - 回车要用 `\n`（LF）而不是 `\r`（CR）——实测 tmux 里运行的 codex 对 `\r`
     只进输入框不提交（"输入了没发送"），`\n` 才正常提交进入 Working；
5. 防抖：同一进程 30 秒（`--cooldown`）内不重复发送；会话日志不增长时也不重复。

## 安装

```bash
# 方式一：npm 全局安装
npm install -g codex-continue

# 方式二：从源码跑
git clone git@github.com:Tigerdwgth/codex-continue.git
cd codex-continue && npm install && npm link
```

## 使用

```bash
# 前台 watch：每 5s 扫一次，遇到错误自动发 continue（Ctrl+C 停止）
codex-continue

# 后台运行 / 停止 / 状态
codex-continue start
codex-continue --status
codex-continue --stop

# 只跑一次就退出（适合 cron 定时）
codex-continue --once

# 调参
codex-continue --interval 10     # 扫描间隔（秒，默认 5）
codex-continue --cooldown 60     # 同一会话两次发送的最小间隔（秒，默认 30）
codex-continue --send continue   # 发送给 codex 的命令（默认 continue）
```

日志与 pid 文件在 `~/.codex-continue/`。

## 环境要求

- codex 跑在终端里（有 tty）；本机有 `ps`、`lsof`、能读 `~/.codex/sessions`
- 不依赖 tmux
- macOS / Linux
- Node.js >= 18

## License

MIT
