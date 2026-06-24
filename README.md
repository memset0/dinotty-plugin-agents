# dinotty-plugin-agents

> Fork 自 [`xichan96/dinotty-plugins` 的 `claude-code` 插件](https://github.com/xichan96/dinotty-plugins/tree/main/claude-code)（通过 `git subtree split` 保留原始提交历史），由 **memset0** 维护，作为自定义 **dinotty agents 插件** 的开发基础。

[dinotty](https://github.com/xichan96/dinotty) 的可视化 Coding Agent 会话管理插件：在 dinotty 的插件标签页里浏览 / 搜索 / 新建 / 恢复 Claude Code 会话。

## 工作原理（二次开发必读）

插件分两层，二者通过 dinotty 注入的 `ctx.exec` 桥接：

- **UI 层** `src/ui.ts` → 构建为 `dist/main.js`，在 dinotty 的 webview（Vue 3 运行时）里渲染，导出 `activate(ctx)`。它**不直接读文件、不直接跑命令**，所有数据都通过 `ctx.exec.run([...])` 调下面的 CLI 层取得。
- **CLI 层** `src/cli.ts`（仅 `import './history-cli'`）→ 构建为 `dist/cli`（node 程序）。它读取 Claude Code 的本地会话库（`~/.claude/projects/<encoded-path>/*.jsonl`）并按子命令输出 JSON；新建 / 续聊会话时再 shell 调用 `claude` CLI。
- **启动器** `bin/cli-wrapper`（静态 bash，构建 / 发布时复制为 `dist/cli-wrapper`）：`plugin.json` 的 `bin.entry` 指向它；它负责定位 node 可执行文件（PATH → nvm default → 常见路径）再 `exec node dist/cli "$@"`，让 dinotty server 即便在精简 PATH 下也能跑起 CLI。

CLI 子命令（实现于 `src/history-cli.ts`，UI 经 `ctx.exec.run` 调用）：
`list-projects` · `list-sessions <encodedPath>` · `read-session <encodedPath> <id>` · `search <query>` · `list-recent <limit>` · `list-skills` · `list-dirs <path>` · `claude-call --new|--resume <id> <prompt>`。

dinotty 插件 API（`ctx`）参考 dinotty 仓库的 `docs/plugins.md` 与 `plugin-api/index.d.ts`。

## 目录结构

```
plugin.json          # 插件清单（id / entry=dist/main.js / bin=dist/cli-wrapper / styles / commands）
styles.css           # 样式
bin/cli-wrapper      # 静态 node 启动器（构建时复制进 dist/）
src/
  ui.ts              # UI 层入口（→ dist/main.js）
  cli.ts             # CLI 层入口（→ dist/cli），仅 re-export history-cli
  history-cli.ts     # CLI 各子命令：读 ~/.claude 会话库、调 claude
  history.ts         # UI 侧调用 CLI 的封装（exec → JSON）
  claude.ts          # 新建 / 续聊会话（claude-call）
  diff.ts / icons.ts / types.ts
.github/workflows/build-dist.yml   # CI：构建并发布到 dist 分支
```

> `dist/` **不入库**（已 gitignore）。源码只在 `main`，构建产物由 CI 发布到 `dist` 分支，见下。

## 开发（pnpm）

本仓库用 **pnpm** 管理依赖与构建：

```bash
pnpm install
pnpm run build      # 产出 dist/main.js + dist/cli + dist/cli-wrapper（本地，已 gitignore）
```

本地接入 dinotty 调试：构建后用 dev-link 把本目录链接进 dinotty（见 dinotty `docs/plugins.md`），或把构建后的 `dist/` + `plugin.json` + `styles.css` 放进 `~/.dinotty/plugins/<id>/`。

前置：需先安装并登录 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude` 须在 PATH 中）。

## 构建产物与在线安装：`dist` 分支

- `main` 分支：**仅源码**，不含 `dist/`。
- 每次推送到 `main`，GitHub Action（`.github/workflows/build-dist.yml`）会 `pnpm install && pnpm run build`，并把可安装产物（`plugin.json` / `styles.css` / `dist/`）**强制推送到 `dist` 分支**（单提交、始终为最新构建）。
- **在线安装**指向 `dist` 分支：repo = `memset0/dinotty-plugin-agents`，branch = `dist`。

## 功能

- 浏览 / 按项目分组 / 搜索 Claude Code 历史会话
- 新建会话并在插件内交互、恢复已有会话
- 文件变更面板、项目选择器、费用展示
- Slash 命令面板（`/new` `/open` `/search` `/skills` 等）
