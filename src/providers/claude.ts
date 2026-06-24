import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile, execFileSync } from 'child_process'
import type { Project, Session, Message, SearchResult, ToolUse, AgentSource } from '../types'
import { resolveAgentDir, type AgentProvider } from './base'

const SOURCE: AgentSource = 'claude-code'

function readLines(filePath: string): string[] {
  try { return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()) }
  catch { return [] }
}

function fallbackDecode(encodedPath: string): string {
  return '/' + encodedPath.replace(/^-/, '').replace(/-/g, '/')
}

function encodeClaude(p: string): string {
  return p.replace(/^\//, '').replace(/\//g, '-')
}

function summarizeTool(name: string, input: any): string {
  if (!input) return name
  switch (name) {
    case 'Bash': return (input.command || name).slice(0, 80)
    case 'Read': return input.file_path || name
    case 'Edit': return input.file_path || name
    case 'Write': return input.file_path || name
    case 'Grep': return input.pattern || name
    case 'Glob': return input.pattern || name
    case 'Agent': return (input.description || name).slice(0, 60)
    case 'WebFetch': return (input.url || name).slice(0, 60)
    case 'WebSearch': return (input.query || name).slice(0, 60)
    default: return name
  }
}

function parseMessage(obj: any): Message | null {
  if (obj.type === 'user') {
    if (typeof obj.message?.content !== 'string') return null
    return { uuid: obj.uuid || '', role: 'user', content: obj.message.content, timestamp: obj.timestamp || '', source: SOURCE }
  }
  if (obj.type === 'assistant') {
    const content = obj.message?.content || []
    const textParts: string[] = []
    const toolUses: ToolUse[] = []
    for (const block of content) {
      if (block.type === 'text') textParts.push(block.text)
      else if (block.type === 'tool_use') {
        const tu: ToolUse = { name: block.name, summary: summarizeTool(block.name, block.input) }
        if (block.name === 'Edit' && block.input) {
          tu.filePath = block.input.file_path || ''
          tu.oldString = block.input.old_string || ''
          tu.newString = block.input.new_string || ''
          tu.replaceAll = block.input.replace_all || false
        } else if (block.name === 'Write' && block.input) {
          tu.filePath = block.input.file_path || ''
          tu.content = block.input.content || ''
        }
        toolUses.push(tu)
      }
    }
    return {
      uuid: obj.uuid || '', role: 'assistant', content: textParts.join('\n'),
      timestamp: obj.timestamp || '', model: obj.message?.model,
      toolUses: toolUses.length > 0 ? toolUses : undefined, source: SOURCE,
    }
  }
  return null
}

function readSessionMeta(filePath: string, id: string, encodedPath: string): Session | null {
  const lines = readLines(filePath)
  if (lines.length === 0) return null
  let firstPrompt = '', gitBranch = '', firstTimestamp = '', cwd = ''
  for (const line of lines.slice(0, 30)) {
    try {
      const obj = JSON.parse(line)
      if (!cwd && obj.cwd) cwd = obj.cwd
      if (obj.type === 'user' && typeof obj.message?.content === 'string') {
        firstPrompt = obj.message.content
        gitBranch = obj.gitBranch || ''
        firstTimestamp = obj.timestamp || ''
        if (obj.cwd) cwd = obj.cwd
        break
      }
    } catch { /* skip */ }
  }
  if (!cwd) {
    for (const line of lines) {
      try { const obj = JSON.parse(line); if (obj.cwd) { cwd = obj.cwd; break } } catch { /* skip */ }
    }
  }
  try {
    const last = JSON.parse(lines[lines.length - 1])
    if (last.type === 'last-prompt' && last.lastPrompt && !firstPrompt) firstPrompt = last.lastPrompt
  } catch { /* skip */ }
  let lastTimestamp = firstTimestamp
  if (!lastTimestamp) {
    try { lastTimestamp = fs.statSync(filePath).mtime.toISOString() } catch { /* skip */ }
  }
  const messageCount = lines.filter(l => l.includes('"type":"user"')).length
  return {
    id, project: cwd || fallbackDecode(encodedPath), encodedPath,
    firstPrompt: firstPrompt.slice(0, 200), lastTimestamp, messageCount,
    gitBranch: gitBranch || undefined, source: SOURCE,
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly source = SOURCE
  readonly configDir = resolveAgentDir('CLAUDE_CONFIG_DIR', '.claude')
  private get projectsDir() { return path.join(this.configDir, 'projects') }
  private get skillsDir() { return path.join(this.configDir, 'skills') }

  available(): boolean { try { return fs.existsSync(this.projectsDir) } catch { return false } }

  listProjects(): Project[] {
    if (!this.available()) return []
    const projects: Project[] = []
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(this.projectsDir, entry.name)
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
        if (files.length === 0) continue
        let projectPath = fallbackDecode(entry.name)
        for (const file of files) {
          for (const line of readLines(path.join(dir, file)).slice(0, 10)) {
            try { const obj = JSON.parse(line); if (obj.cwd) { projectPath = obj.cwd; break } } catch { /* skip */ }
          }
          if (projectPath !== fallbackDecode(entry.name)) break
        }
        projects.push({ path: projectPath, encodedPath: entry.name, sessionCount: files.length, source: SOURCE })
      } catch { /* skip */ }
    }
    return projects.sort((a, b) => b.sessionCount - a.sessionCount)
  }

  listSessions(encodedPath: string): Session[] {
    const dir = path.join(this.projectsDir, encodedPath)
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime)
    const sessions: Session[] = []
    for (const file of files) {
      const id = file.name.replace('.jsonl', '')
      if (id.length < 10) continue
      const meta = readSessionMeta(path.join(dir, file.name), id, encodedPath)
      if (meta) sessions.push(meta)
    }
    return sessions
  }

  listSessionsByProject(projectPath: string): Session[] {
    return this.listSessions(encodeClaude(projectPath))
  }

  readSession(encodedPath: string, sessionId: string): Message[] {
    const filePath = path.join(this.projectsDir, encodedPath, `${sessionId}.jsonl`)
    const messages: Message[] = []
    for (const line of readLines(filePath)) {
      try { const msg = parseMessage(JSON.parse(line)); if (msg) messages.push(msg) } catch { /* skip */ }
    }
    return messages
  }

  search(query: string, limit: number): SearchResult[] {
    if (!this.available()) return []
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'i')
    const results: SearchResult[] = []
    for (const proj of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!proj.isDirectory() || proj.name.startsWith('.')) continue
      const dir = path.join(this.projectsDir, proj.name)
      try {
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
          if (results.length >= limit) break
          const filePath = path.join(dir, file)
          let matchText = ''
          for (const line of readLines(filePath)) {
            if (!re.test(line)) continue
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'user' && typeof obj.message?.content === 'string') matchText = obj.message.content
              else if (obj.type === 'assistant') matchText = (obj.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            } catch { matchText = line.slice(0, 100) }
            break
          }
          if (matchText) {
            const session = readSessionMeta(filePath, file.replace('.jsonl', ''), proj.name)
            if (session) results.push({ session, match: matchText.slice(0, 200) })
          }
        }
      } catch { /* skip */ }
    }
    return results
  }

  listRecent(limit: number): Session[] {
    if (!this.available()) return []
    const all: Session[] = []
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(this.projectsDir, entry.name)
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
          .sort((a, b) => b.mtime - a.mtime)
        for (const file of files) {
          const id = file.name.replace('.jsonl', '')
          if (id.length < 10) continue
          const meta = readSessionMeta(path.join(dir, file.name), id, entry.name)
          if (meta) all.push(meta)
        }
      } catch { /* skip */ }
    }
    return all.sort((a, b) => ts(b.lastTimestamp) - ts(a.lastTimestamp)).slice(0, limit)
  }

  // --- Claude-specific (skills + send), kept on the provider ---

  listSkills(): { id: string; name: string; description: string; allowedTools: string[] }[] {
    if (!fs.existsSync(this.skillsDir)) return []
    const skills: { id: string; name: string; description: string; allowedTools: string[] }[] = []
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const raw = fs.readFileSync(path.join(this.skillsDir, entry.name, 'SKILL.md'), 'utf-8')
        const meta = parseFrontmatter(raw)
        let description = meta.description || ''
        if (!description) {
          const afterFm = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
          const line = afterFm.split('\n').find(l => l.trim() && !l.startsWith('#'))
          if (line) description = line.trim().slice(0, 200)
        }
        skills.push({ id: entry.name, name: meta.name || entry.name, description, allowedTools: meta.allowedTools || [] })
      } catch { /* skip */ }
    }
    return skills
  }

  findBin(): string {
    const home = os.homedir()
    try { return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim() } catch { /* not in PATH */ }
    const nvmDefault = path.join(home, '.nvm/alias/default')
    if (fs.existsSync(nvmDefault)) {
      const version = fs.readFileSync(nvmDefault, 'utf-8').trim()
      if (version) {
        const nvmClaude = path.join(home, `.nvm/versions/node/${version}/bin/claude`)
        if (fs.existsSync(nvmClaude)) return nvmClaude
      }
    }
    const nvmVersionsDir = path.join(home, '.nvm/versions/node')
    if (fs.existsSync(nvmVersionsDir)) {
      try {
        for (const v of fs.readdirSync(nvmVersionsDir).sort().reverse()) {
          const candidate = path.join(nvmVersionsDir, v, 'bin/claude')
          if (fs.existsSync(candidate)) return candidate
        }
      } catch { /* skip */ }
    }
    for (const c of ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', path.join(home, '.local/bin/claude')]) {
      if (fs.existsSync(c)) return c
    }
    return 'claude'
  }

  /** Headless send (--new | --resume). Prints {sessionId, response, costUsd} JSON. */
  call(args: string[]): void {
    const flag = args[0], sessionId = args[1], prompt = args.slice(2).join(' ')
    if (!flag || !sessionId || !prompt) { console.error('Usage: claude-call --new|--resume <session-id> <prompt>'); process.exit(1) }
    const claudeArgs = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits']
    if (flag === '--new') claudeArgs.push('--session-id', sessionId, '--model', 'sonnet')
    else claudeArgs.push('--resume', sessionId)
    execFile(this.findBin(), claudeArgs, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { console.error(stderr || err.message); process.exit(1); return }
      try {
        const data = JSON.parse(stdout)
        console.log(JSON.stringify({ sessionId: data.session_id || sessionId, response: data.result || '', costUsd: data.cost_usd || 0 }))
      } catch {
        console.log(JSON.stringify({ sessionId, response: stdout.trim(), costUsd: 0 }))
      }
    })
  }
}

function ts(s: string): number { return s ? new Date(s).getTime() : 0 }

function parseFrontmatter(raw: string): { name?: string; description?: string; allowedTools?: string[] } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return {}
  const lines = fmMatch[1].split('\n')
  const result: { name?: string; description?: string; allowedTools?: string[] } = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch) { result.name = nameMatch[1].trim(); i++; continue }
    if (line.match(/^description:\s*\|/)) {
      const blockLines: string[] = []; i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) { const t = lines[i].trim(); if (t) blockLines.push(t); i++ }
      result.description = blockLines.join(' ').slice(0, 200); continue
    }
    const descInlineMatch = line.match(/^description:\s*(.+)$/)
    if (descInlineMatch) { result.description = descInlineMatch[1].trim(); i++; continue }
    if (line.match(/^allowed-tools:\s*\|/)) {
      const blockLines: string[] = []; i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) { const t = lines[i].trim().replace(/^-\s*/, ''); if (t) blockLines.push(t); i++ }
      result.allowedTools = blockLines; continue
    }
    const toolsInlineMatch = line.match(/^allowed-tools:\s*(.+)$/)
    if (toolsInlineMatch) { result.allowedTools = toolsInlineMatch[1].split(',').map(t => t.trim()).filter(Boolean); i++; continue }
    if (line.match(/^allowed-tools:\s*$/)) {
      const tools: string[] = []; i++
      while (i < lines.length && lines[i].match(/^\s*-\s/)) { const t = lines[i].replace(/^\s*-\s*/, '').trim().split('#')[0].trim(); if (t) tools.push(t); i++ }
      result.allowedTools = tools; continue
    }
    i++
  }
  return result
}
