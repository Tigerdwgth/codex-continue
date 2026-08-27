# codex-continue

自动续跑卡住的 codex 会话。定期扫描本机**所有** tmux 里的 codex 会话，遇到
模型容量（`model at capacity`）或 429 限流（`exceeded retry limit, last status: 429
Too Many Requests`）错误时，自动向对应 pane 发送 `continue` + 回车，把停住的
codex 推着继续跑，无需人工干预。

codex 配套插件：不依赖任何框架或服务，只要本机装了 `tmux`、codex 跑在 tmux 里即可。

## 工作原理

1. 每隔 `--interval` 秒（默认 5s）用 `tmux list-panes` 找到所有当前前台命令是
   `codex` 的 pane；
2. 用 `tmux capture-pane` 读每个 pane 最近 100 行输出，在最近 2048 字符的尾部
   缓冲里匹配容量 / 429 错误（不区分大小写，错误文本被终端分块切碎也能命中）；
3. 命中后用 `tmux send-keys` 发送 `continue` + 回车（可 `--send` 自定义文本）；
4. 防抖：同一 pane 屏幕内容没变时不重复发送；屏幕变化后也要间隔 `--cooldown`
   秒（默认 30s）才会再发。

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
*/1 * * * * codex-continue --once >> ~/.codex-continure/once.log 2>&1

# 调参
codex-continue --interval 10     # 扫描间隔（秒，默认 5）
codex-continue --cooldown 60     # 同一会话两次发送的最小间隔（秒，默认 30）
codex-continue --send continue   # 发送给 codex 的命令（默认 continue）
```

## 配置

命令行参数即可覆盖所有选项，无独立配置文件。日志与 pid 文件在
`~/.codex-continue/`。

## 环境要求

- `tmux`（codex 会话必须在 tmux 里运行；`codex-continue` 通过 tmux 读输出 / 注入按键）
- macOS / Linux
- Node.js >= 18

## License

MIT
