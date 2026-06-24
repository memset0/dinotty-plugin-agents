# dinotty-plugin-agents (`agents-view`)

> Fork 自 [`xichan96/dinotty-plugins` 的 `claude-code` 插件](https://github.com/xichan96/dinotty-plugins/tree/main/claude-code)（`git subtree split` 保留原始历史），由 **memset0** 维护。dinotty 插件 id 为 **`agents-view`**。

一个 [dinotty](https://github.com/xichan96/dinotty) 上的**统一多-Agent 可视化会话视图**:在 dinotty 的插件标签页里浏览 / 搜索 / 新建 / 恢复各 Coding Agent 的会话。

**目标:统一支持 Claude Code + Codex + opencode。** 当前实现基于 **Claude Code**(读 `~/.claude` 会话库、调 `claude` CLI);Codex、opencode 作为后续 provider 接入(见 [Roadmap](#roadmap)）。

## 工作原理(二次开发必读)

插件分两层,经 dinotty 注入的 `ctx.exec` 桥接:

- **UI 层** `src/ui.ts` → `dist/main.js`,在 dinotty webview(Vue 3)里渲染,导出 `activate(ctx)`。它**从不直接读文件 / 跑命令**,一切数据经 `ctx.exec.run([...])` 委托给 CLI 层。
- **CLI 层** `src/cli.ts`(仅 `import './history-cli'`)→ `dist/cli`(node 程序)。当前 provider 读 Claude Code 的本地会话库(`~/.claude/projects/<encoded>/<sid>.jsonl`)并输出 JSON;新建 / 续聊时 `claude -p <prompt> --output-format json --permission-mode acceptEdits [--session-id|--resume]`。
- **启动器** `bin/cli-wrapper`(静态 bash,构建时复制为 `dist/cli-wrapper`):`plugin.json` 的 `bin.entry` 指向它;定位 node(PATH → nvm → 常见路径)再 `exec node dist/cli "$@"`。

> 当前是 **headless print 模式**(`claude -p` 一次性、无流式、回合间无常驻进程,状态全在 jsonl,`--resume` 靠重放)。这决定了:实时只拿到最终文本、工具步骤要刷新后(`read-session` 回读 jsonl)才可见。要流式 / 实时遥控见 [Roadmap](#roadmap)。

CLI 子命令(`src/history-cli.ts`,UI 经 `ctx.exec.run` 调):
`list-projects` · `list-sessions <encoded>` · `read-session <encoded> <sid>` · `search <query>` · `list-recent <n>` · `list-skills` · `list-dirs <path>` · `claude-call --new|--resume <id> <prompt>`。

dinotty 插件 API(`ctx`)见 dinotty 仓库 `docs/plugin-development.md` 与 `plugin-api/index.d.ts`。

## 目录结构

```
plugin.json          # 清单:id=agents-view / entry=dist/main.js / bin=dist/cli-wrapper / commands=agents-view.*
styles.css           # 样式
bin/cli-wrapper      # 静态 node 启动器(构建时复制进 dist/)
src/
  ui.ts              # UI 层(→ dist/main.js)
  cli.ts             # CLI 层入口(→ dist/cli),仅 re-export history-cli
  history-cli.ts     # CLI 子命令:读会话库、调 agent
  history.ts         # UI 侧调用 CLI 的封装(exec → JSON)
  claude.ts          # 新建 / 续聊(claude-call) —— 将抽象为 agent provider
  diff.ts / icons.ts / types.ts
.github/workflows/build-dist.yml   # CI:构建并发布到 dist 分支
```

> `dist/` **不入库**(gitignore)。源码只在 `main`,构建产物由 CI 发布到 `dist` 分支。

## 开发(pnpm)

```bash
pnpm install
pnpm run build      # 产出 dist/main.js + dist/cli + dist/cli-wrapper(本地,gitignore)
```

本地接入 dinotty:构建后 dev-link 本目录(`curl -X POST http://127.0.0.1:8999/api/plugins/dev-link -d '{"path":"<本目录绝对路径>"}'`),或把构建后的 `dist/` + `plugin.json` + `styles.css` 放进 `~/.dinotty/plugins/agents-view/`。dinotty 支持**热重载**:改源码 → `pnpm run build` → 自动重载。

前置:需先安装并登录对应 agent 的 CLI(当前 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code),`claude` 须在 PATH 中)。

## 构建产物与在线安装:`dist` 分支

- `main` 分支:**仅源码**,不含 `dist/`。
- 每次推 `main`,GitHub Action 用 **pnpm** 构建并把可安装产物(`plugin.json` / `styles.css` / `dist/`)**强推到 `dist` 分支**(单提交、始终为最新构建)。
- **在线安装**指向 `dist` 分支:repo = `memset0/dinotty-plugin-agents`,branch = `dist`。

## Roadmap

- **多-Agent provider 抽象**:把写死的 Claude Code(`~/.claude` 路径、`claude` 二进制、`--model`、`acceptEdits`)抽象成 provider 接口,接入 **Codex**、**opencode**。抽象维度不止“会话目录 / 二进制”,还含“生命周期”(见下)。
- **双生命周期模式**:
  - *headless*(现状):`agent -p` 一次性调用,适合查历史 / 简单问答。
  - *interactive*:用 `ctx.terminal.createTab()` / `send()` / `onOutput()` 把真·交互式 agent 跑进 dinotty 终端面板,得到**流式输出、实时工具可见、可中断、可远程遥控**(dinotty 本身远程可达)。
- **流式与实时一致性**:换 `--output-format stream-json` + `ctx.exec.spawn()`,或发送中 tail 会话 jsonl;消除“实时视图 vs 刷新后视图”的割裂。
- **Rename sessions**:`sessionId → 自定义名` 映射存 `ctx.storage`(`~/.dinotty/plugin-data/agents-view/`),不改 jsonl 文件名(`--resume` 依赖它)。
- **设置面板**:模型 / 权限模式 / 默认 cwd / 各 agent 路径等,持久化于 `ctx.storage`。
- **真正的 Stop**:headless 下 `exec.run` 不可中断;交互模式经终端面板 `kill` 可实现。

## 功能(当前)

- 浏览 / 按项目分组 / 搜索历史会话
- 新建会话并在插件内交互、恢复已有会话
- 文件变更面板、项目选择器、费用展示
- Slash 命令面板(`/new` `/open` `/search` `/skills` 等)
