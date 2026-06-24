import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getProvider, aggregateRecent, aggregateProjects, aggregateProjectSessions, aggregateSearch } from './providers'
import { ClaudeProvider } from './providers/claude'

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
const [, , subcommand, ...args] = process.argv

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
  case 'claude-call':
    new ClaudeProvider().call(args)
    break
  case 'list-dirs':
    if (!args[0]) { console.error('Usage: list-dirs <path>'); process.exit(1) }
    cmdListDirs(args[0])
    break
  default:
    console.error(`Unknown subcommand: ${subcommand}`)
    console.error('Available: list-projects, list-sessions, read-session, search, list-recent, list-skills, claude-call, list-dirs')
    process.exit(1)
}
