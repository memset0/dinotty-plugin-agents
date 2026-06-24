import * as fs from 'fs'
import * as path from 'path'
import type { Project, Session, Message, SearchResult, ToolUse, AgentSource } from '../types'
import { resolveAgentDir, type AgentProvider } from './base'

const SOURCE: AgentSource = 'codex'

function readLines(f: string): string[] {
  try { return fs.readFileSync(f, 'utf-8').split('\n').filter(l => l.trim()) } catch { return [] }
}
function ts(s: string): number { return s ? new Date(s).getTime() : 0 }
function safeMtime(f: string): number { try { return fs.statSync(f).mtime.getTime() } catch { return 0 } }
function encode(p: string): string { return p.replace(/^\//, '').replace(/\//g, '-') }
function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c: any) => (c && typeof c.text === 'string') ? c.text : '').join('')
  return ''
}
function codexToolSummary(name: string, argsStr: any): string {
  try {
    const a = JSON.parse(String(argsStr || '{}'))
    return String(a.cmd || a.command || a.path || a.file_path || a.query || name || 'tool').slice(0, 100)
  } catch { return name || 'tool' }
}
function idFromFile(f: string): string {
  const base = path.basename(f, '.jsonl')
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return m ? m[1] : base.replace(/^rollout-/, '')
}
function walkRollouts(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  return out
}

/** Codex session store: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-...jsonl (+ archived_sessions/) and session_index.jsonl. Read-only in Phase 1. */
export class CodexProvider implements AgentProvider {
  readonly source = SOURCE
  readonly configDir = resolveAgentDir('CODEX_HOME', '.codex')
  private get roots(): string[] { return [path.join(this.configDir, 'sessions'), path.join(this.configDir, 'archived_sessions')] }

  available(): boolean { return this.roots.some(r => { try { return fs.existsSync(r) } catch { return false } }) }

  private nameIndex(): Map<string, { name?: string; updated?: string }> {
    const m = new Map<string, { name?: string; updated?: string }>()
    for (const line of readLines(path.join(this.configDir, 'session_index.jsonl'))) {
      try { const o = JSON.parse(line); if (o.id) m.set(o.id, { name: o.thread_name, updated: o.updated_at }) } catch { /* skip */ }
    }
    return m
  }

  private allFiles(): string[] { return this.roots.flatMap(walkRollouts) }

  private metaOf(file: string): { id: string; cwd: string; firstPrompt: string; timestamp: string; messageCount: number } {
    let cwd = '', firstPrompt = '', timestamp = '', id = idFromFile(file), messageCount = 0
    for (const line of readLines(file)) {
      let o: any; try { o = JSON.parse(line) } catch { continue }
      const p = o.payload || {}
      if (o.type === 'session_meta') { cwd = p.cwd || cwd; id = p.session_id || p.id || id; timestamp = o.timestamp || p.timestamp || timestamp }
      else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        messageCount++
        const t = textOf(p.content)
        if (!firstPrompt && t && !t.trimStart().startsWith('<')) firstPrompt = t
      }
    }
    return { id, cwd, firstPrompt, timestamp, messageCount }
  }

  private toSession(file: string, names: Map<string, { name?: string; updated?: string }>): Session | null {
    const meta = this.metaOf(file)
    if (!meta.id) return null
    const idx = names.get(meta.id)
    let last = idx?.updated || meta.timestamp
    if (!last) last = new Date(safeMtime(file)).toISOString()
    return {
      id: meta.id, project: meta.cwd || '(unknown)', encodedPath: encode(meta.cwd || ''),
      firstPrompt: (idx?.name || meta.firstPrompt || '').slice(0, 200),
      lastTimestamp: last, messageCount: meta.messageCount, source: SOURCE, name: idx?.name,
    }
  }

  listRecent(limit: number): Session[] {
    if (!this.available()) return []
    const names = this.nameIndex()
    const files = this.allFiles().map(f => ({ f, m: safeMtime(f) })).sort((a, b) => b.m - a.m).slice(0, Math.max(limit, 30))
    const out: Session[] = []
    for (const { f } of files) { const s = this.toSession(f, names); if (s) out.push(s) }
    return out.sort((a, b) => ts(b.lastTimestamp) - ts(a.lastTimestamp)).slice(0, limit)
  }

  listProjects(): Project[] {
    if (!this.available()) return []
    const names = this.nameIndex()
    const byCwd = new Map<string, number>()
    for (const f of this.allFiles()) { const s = this.toSession(f, names); if (s) byCwd.set(s.project, (byCwd.get(s.project) || 0) + 1) }
    return Array.from(byCwd.entries()).map(([p, n]) => ({ path: p, encodedPath: encode(p), sessionCount: n, source: SOURCE }))
  }

  listSessions(_encodedPath: string): Session[] { return this.listRecent(1000) }

  listSessionsByProject(projectPath: string): Session[] {
    if (!this.available()) return []
    const names = this.nameIndex()
    const out: Session[] = []
    for (const f of this.allFiles()) { const s = this.toSession(f, names); if (s && s.project === projectPath) out.push(s) }
    return out.sort((a, b) => ts(b.lastTimestamp) - ts(a.lastTimestamp))
  }

  readSession(_encodedPath: string, id: string): Message[] {
    const file = this.allFiles().find(f => idFromFile(f) === id) || this.allFiles().find(f => f.includes(id))
    if (!file) return []
    const messages: Message[] = []
    const toolByCall: Record<string, ToolUse> = {}
    let model = ''
    const lastAssistant = (): Message | null => {
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i]
      return null
    }
    for (const line of readLines(file)) {
      let o: any; try { o = JSON.parse(line) } catch { continue }
      const p = o.payload || {}
      if (o.type === 'turn_context' && p.model) { model = p.model }
      else if (o.type === 'session_meta' && p.model && !model) { model = p.model }
      else if (o.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        messages.push({
          uuid: p.id || '', role: p.role, content: textOf(p.content), timestamp: o.timestamp || '',
          source: SOURCE, model: p.role === 'assistant' ? (model || undefined) : undefined,
        })
      } else if (o.type === 'response_item' && p.type === 'function_call') {
        const tu: ToolUse = { name: p.name || 'tool', summary: codexToolSummary(p.name, p.arguments), args: String(p.arguments || ''), callId: p.call_id }
        if (p.call_id) toolByCall[p.call_id] = tu
        const a = lastAssistant()
        if (a) (a.toolUses ||= []).push(tu)
        else messages.push({ uuid: p.id || '', role: 'assistant', content: '', timestamp: o.timestamp || '', source: SOURCE, model: model || undefined, toolUses: [tu] })
      } else if (o.type === 'response_item' && p.type === 'function_call_output') {
        const tu = p.call_id ? toolByCall[p.call_id] : null
        if (tu) tu.output = String(typeof p.output === 'string' ? p.output : JSON.stringify(p.output)).slice(0, 4000)
      }
    }
    return messages.filter(m => (m.content && m.content.trim()) || (m.toolUses && m.toolUses.length))
  }

  search(query: string, limit: number): SearchResult[] {
    if (!this.available()) return []
    const names = this.nameIndex()
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    const out: SearchResult[] = []
    for (const f of this.allFiles()) {
      if (out.length >= limit) break
      let match = ''
      for (const line of readLines(f)) {
        if (!re.test(line)) continue
        try { const o = JSON.parse(line); const p = o.payload || {}; if (p.type === 'message') match = textOf(p.content) } catch { match = line.slice(0, 100) }
        if (match) break
      }
      if (match) { const s = this.toSession(f, names); if (s) out.push({ session: s, match: match.slice(0, 200) }) }
    }
    return out
  }
}
