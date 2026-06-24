import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getProvider, aggregateRecent, aggregateProjects, aggregateProjectSessions, aggregateSearch } from './providers'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'

function out(v: any) { console.log(JSON.stringify(v)) }

// Generic directory browser for the cwd picker (agent-agnostic).
function cmdListDirs(dirPath: string) {
  const resolved = dirPath.replace(/^~/, os.homedir())
  try { if (!fs.statSync(resolved).isDirectory()) { out([]); return } } catch { out([]); return }
  try {
    const dirs: { name: string; path: string }[] = []
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue
      dirs.push({ name: entry.name, path: path.join(resolved, entry.name) })
    }
    out(dirs.sort((a, b) => a.name.localeCompare(b.name)))
  } catch { out([]) }
}

// Thin argv dispatcher over the provider registry.
// Cross-agent commands (list-projects/list-recent/search) aggregate; per-session
// commands take an optional [source] (default claude-code).
//
// `--with-env <json>` prefix: the streaming path (ctx.exec.spawn) cannot forward
// cwd/env through dinotty's spawn WS (unlike ctx.exec.run), so the UI passes them
// here as args. Apply BEFORE any provider is constructed (configDir reads env at
// construction). Paths only — no secrets — so args are safe.
let _argv = process.argv.slice(2)
if (_argv[0] === '--with-env') {
  try {
    const cfg = JSON.parse(_argv[1] || '{}')
    if (cfg.cwd) { try { process.chdir(cfg.cwd) } catch { /* keep cwd */ } }
    if (cfg.env && typeof cfg.env === 'object') for (const [k, v] of Object.entries(cfg.env)) process.env[k] = String(v)
  } catch { /* ignore malformed */ }
  _argv = _argv.slice(2)
}
const [subcommand, ...args] = _argv

switch (subcommand) {
  case 'list-projects':
    out(aggregateProjects())
    break
  case 'list-sessions': {
    if (!args[0]) { console.error('Usage: list-sessions <encodedPath> [source]'); process.exit(1) }
    const p = getProvider(args[1] || 'claude-code')
    out(p && p.available() ? p.listSessions(args[0]) : [])
    break
  }
  case 'read-session': {
    if (!args[0] || !args[1]) { console.error('Usage: read-session <encodedPath> <sessionId> [source]'); process.exit(1) }
    const p = getProvider(args[2] || 'claude-code')
    out(p ? p.readSession(args[0], args[1]) : [])
    break
  }
  case 'project-sessions':
    if (!args[0]) { console.error('Usage: project-sessions <projectPath>'); process.exit(1) }
    out(aggregateProjectSessions(args[0]))
    break
  case 'search':
    if (!args[0]) { console.error('Usage: search <query>'); process.exit(1) }
    out(aggregateSearch(args.join(' '), 20))
    break
  case 'list-recent':
    out(aggregateRecent(args[0] ? parseInt(args[0], 10) : 30))
    break
  case 'list-skills':
    out(new ClaudeProvider().listSkills())
    break
  case 'config': {
    const c = new ClaudeProvider()
    const x = getProvider('codex')
    const codexBin = x instanceof CodexProvider ? x.findBin() : ''
    out({ claudeConfigDir: c.configDir, codexHome: x ? x.configDir : '', claudeBin: c.findBin(), codexBin })
    break
  }
  case 'claude-call':
    new ClaudeProvider().call(args)
    break
  case 'list-models': {
    // list-models [source]  — selectable models for the agent (codex: from models_cache.json)
    const p = getProvider(args[0] || 'codex')
    out(p instanceof CodexProvider ? p.listModels() : [])
    break
  }
  case 'agent-call': {
    // agent-call <source> --new|--resume <id> <model> <effort> <permission> <prompt>  ('' = unset).
    const source = args[0], flag = args[1], sessionId = args[2] || undefined, model = args[3] || undefined, effort = args[4] || undefined, sandbox = args[5] || undefined, prompt = args.slice(6).join(' ')
    if (!source || !flag || !prompt) { console.error('Usage: agent-call <source> --new|--resume <id> <model> <effort> <permission> <prompt>'); process.exit(1) }
    const p = getProvider(source)
    if (!p) { console.error(`Unknown source: ${source}`); process.exit(1); break }
    p.send({ mode: flag === '--new' ? 'new' : 'resume', sessionId, prompt, cwd: process.cwd(), model, effort, sandbox })
      .then(r => out(r))
      .catch(e => { console.error(e?.message || String(e)); process.exit(1) })
    break
  }
  case 'agent-stream': {
    // agent-stream <source> --new|--resume <id> <model> <effort> <permission> <prompt>  — streams normalized NDJSON.
    const source = args[0], flag = args[1], sessionId = args[2] || undefined, model = args[3] || undefined, effort = args[4] || undefined, sandbox = args[5] || undefined, prompt = args.slice(6).join(' ')
    if (!source || !flag || !prompt) { console.error('Usage: agent-stream <source> --new|--resume <id> <model> <effort> <permission> <prompt>'); process.exit(1) }
    const p = getProvider(source)
    if (!p) { console.error(`Unknown source: ${source}`); process.exit(1); break }
    const emit = (o: any) => process.stdout.write(JSON.stringify(o) + '\n')
    const handle = p.sendStreaming({ mode: flag === '--new' ? 'new' : 'resume', sessionId, prompt, cwd: process.cwd(), model, effort, sandbox }, {
      onDelta: (text) => emit({ type: 'delta', text }),
      onToolUse: (tool) => emit({ type: 'tool', tool }),
      onSession: (sid) => emit({ type: 'session', sessionId: sid }),
      onDone: (r) => emit({ type: 'done', ...r }),
      onError: (message) => emit({ type: 'error', message }),
    })
    if (!handle) { emit({ type: 'unsupported' }); process.exit(0); break }
    const stop = () => { try { handle.kill() } catch { /* */ } }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    handle.wait().then(() => { process.off('SIGTERM', stop); process.off('SIGINT', stop); process.exitCode = 0 })
    break
  }
  case 'list-dirs':
    if (!args[0]) { console.error('Usage: list-dirs <path>'); process.exit(1) }
    cmdListDirs(args[0])
    break
  default:
    console.error(`Unknown subcommand: ${subcommand}`)
    console.error('Available: list-projects, list-sessions, read-session, search, list-recent, list-skills, list-models, config, claude-call, agent-call, agent-stream, list-dirs')
    process.exit(1)
}
