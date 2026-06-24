import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn, execFileSync } from 'child_process'
import type { Project, Session, Message, SearchResult, ToolUse, AgentSource } from '../types'
import { resolveAgentDir, type AgentProvider, type SendOpts, type SendResult, type StreamCallbacks, type StreamHandle } from './base'

const SOURCE: AgentSource = 'codex'

/** Map a codex `--json` stream item to a ToolUse (upserted by callId on the UI side). */
function codexItemToTool(it: any): ToolUse | null {
  if (!it || !it.type) return null
  switch (it.type) {
    case 'command_execution':
      return { name: 'Bash', summary: String(it.command || 'command').slice(0, 100), args: String(it.command || ''), output: it.aggregated_output ? String(it.aggregated_output).slice(0, 4000) : undefined, callId: it.id }
    case 'file_change':
    case 'patch':
      return { name: 'Edit', summary: String(it.path || it.summary || 'patch').slice(0, 100), callId: it.id, output: it.diff ? String(it.diff).slice(0, 4000) : undefined }
    case 'mcp_tool_call':
      return { name: it.server ? `mcp:${it.server}` : 'mcp', summary: String(it.tool || it.name || 'mcp').slice(0, 100), args: it.arguments ? JSON.stringify(it.arguments) : undefined, output: it.result ? String(it.result).slice(0, 4000) : undefined, callId: it.id }
    case 'web_search':
      return { name: 'WebSearch', summary: String(it.query || 'search').slice(0, 100), callId: it.id }
    default:
      return null
  }
}

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

  private metaOf(file: string): { id: string; cwd: string; firstPrompt: string; timestamp: string; messageCount: number; model: string; effort: string; permission: string } {
    let cwd = '', firstPrompt = '', timestamp = '', id = idFromFile(file), messageCount = 0, model = '', effort = '', permission = ''
    for (const line of readLines(file)) {
      let o: any; try { o = JSON.parse(line) } catch { continue }
      const p = o.payload || {}
      if (o.type === 'session_meta') { cwd = p.cwd || cwd; id = p.session_id || p.id || id; timestamp = o.timestamp || p.timestamp || timestamp; if (p.model) model = p.model }
      else if (o.type === 'turn_context') { // last turn wins
        if (p.model) model = p.model
        const e = p.collaboration_mode?.settings?.reasoning_effort; effort = e || ''
        const sb = p.sandbox_policy?.type; if (sb) permission = sb
      }
      else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        messageCount++
        const t = textOf(p.content)
        if (!firstPrompt && t && !t.trimStart().startsWith('<')) firstPrompt = t
      }
    }
    return { id, cwd, firstPrompt, timestamp, messageCount, model, effort, permission }
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
      model: meta.model || undefined, effort: meta.effort || undefined, permission: meta.permission || undefined,
    }
  }

  /** Selectable models (slug + label + reasoning levels) from $CODEX_HOME/models_cache.json. */
  listModels(): { slug: string; name: string; defaultEffort?: string; efforts: string[] }[] {
    const byslug = new Map<string, { slug: string; name: string; defaultEffort?: string; efforts: string[] }>()
    let data: any
    try { data = JSON.parse(fs.readFileSync(path.join(this.configDir, 'models_cache.json'), 'utf-8')) } catch { return [] }
    const visit = (o: any) => {
      if (!o || typeof o !== 'object') return
      if (Array.isArray(o)) { for (const x of o) visit(x); return }
      const slug = o.slug || o.id || o.model
      if (typeof slug === 'string' && (o.supported_reasoning_levels || o.default_reasoning_level)) {
        const efforts = Array.isArray(o.supported_reasoning_levels) ? o.supported_reasoning_levels.map((e: any) => e?.effort).filter(Boolean) : []
        if (!byslug.has(slug)) byslug.set(slug, { slug, name: o.display_name || o.displayName || slug, defaultEffort: o.default_reasoning_level, efforts })
      }
      for (const v of Object.values(o)) visit(v)
    }
    visit(data)
    return Array.from(byslug.values())
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

  // --- Send (codex exec --json; codex mints the session id and writes its own rollout) ---

  findBin(): string {
    const home = os.homedir()
    const envBin = (process.env.CODEX_BIN || '').trim()
    if (envBin) { try { if (fs.existsSync(envBin)) return envBin } catch { /* fall through */ } }
    try { return execFileSync('which', ['codex'], { encoding: 'utf-8' }).trim() } catch { /* not in PATH */ }
    const nvmDefault = path.join(home, '.nvm/alias/default')
    if (fs.existsSync(nvmDefault)) {
      const version = fs.readFileSync(nvmDefault, 'utf-8').trim()
      if (version) { const c = path.join(home, `.nvm/versions/node/${version}/bin/codex`); if (fs.existsSync(c)) return c }
    }
    const nvmVersionsDir = path.join(home, '.nvm/versions/node')
    if (fs.existsSync(nvmVersionsDir)) {
      try { for (const v of fs.readdirSync(nvmVersionsDir).sort().reverse()) { const c = path.join(nvmVersionsDir, v, 'bin/codex'); if (fs.existsSync(c)) return c } } catch { /* skip */ }
    }
    for (const c of ['/usr/local/bin/codex', '/opt/homebrew/bin/codex', path.join(home, '.local/bin/codex')]) { if (fs.existsSync(c)) return c }
    return 'codex'
  }

  /**
   * Build `codex exec` argv. New: `-s workspace-write -C <cwd>` (mirrors Claude acceptEdits).
   * Resume: NO `-s`/`-C` (codex rejects them; it inherits the session sandbox and uses the
   * process cwd) — the caller MUST set the spawn cwd to the session's project dir.
   */
  private buildArgs(opts: SendOpts, outFile?: string): string[] {
    const a = ['--json', '--skip-git-repo-check']
    if (outFile) a.push('-o', outFile)
    if (opts.model) a.push('-m', opts.model)
    // Codex does NOT auto-inherit model/effort on resume, so the caller passes the session's values explicitly.
    if (opts.effort) a.push('-c', `model_reasoning_effort="${opts.effort}"`)
    // Permission/sandbox. YOLO uses the bypass flag (the only thing that works on `resume`; `-s`/`-c sandbox_mode`
    // are rejected/ignored there). Lower levels use `-s` on new chats (resume keeps codex's default).
    const yolo = opts.sandbox === 'danger-full-access'
    if (yolo) a.push('--dangerously-bypass-approvals-and-sandbox')
    else a.push('-c', 'approval_policy="never"')
    if (opts.mode === 'resume' && opts.sessionId) return ['exec', 'resume', opts.sessionId, ...a, opts.prompt]
    const newFlags = yolo ? [] : ['-s', opts.sandbox || 'workspace-write']
    return ['exec', ...newFlags, '-C', opts.cwd || process.cwd(), ...a, opts.prompt]
  }

  /** Headless blocking send. Reply from `-o` file (preferred) or the last agent_message; id from thread.started. */
  send(opts: SendOpts): Promise<SendResult> {
    const outFile = path.join(os.tmpdir(), `codex-last-${process.pid}-${Date.now()}.txt`)
    const args = this.buildArgs(opts, outFile)
    return new Promise((resolve, reject) => {
      const child = spawn(this.findBin(), args, { cwd: opts.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf-8'); child.stdout.on('data', d => { stdout += d })
      child.stderr.setEncoding('utf-8'); child.stderr.on('data', d => { stderr += d })
      child.on('error', e => reject(e))
      child.on('close', (code) => {
        let sessionId = opts.sessionId || '', response = ''
        for (const line of stdout.split('\n')) {
          const t = line.trim(); if (!t) continue
          let o: any; try { o = JSON.parse(t) } catch { continue }
          if (o.type === 'thread.started' && o.thread_id) sessionId = o.thread_id
          else if (o.type === 'item.completed' && o.item?.type === 'agent_message' && o.item.text) response = o.item.text
        }
        try { const f = fs.readFileSync(outFile, 'utf-8').trim(); if (f) response = f } catch { /* keep parsed */ }
        try { fs.unlinkSync(outFile) } catch { /* */ }
        if (code && code !== 0 && !response && !sessionId) { reject(new Error(stderr.trim() || `codex exited with code ${code}`)); return }
        resolve({ sessionId, response, costUsd: 0 })
      })
    })
  }

  /** Streaming send via `codex exec --json`; maps thread/item events onto the common callbacks. */
  sendStreaming(opts: SendOpts, cbs: StreamCallbacks): StreamHandle | null {
    const args = this.buildArgs(opts)
    const child = spawn(this.findBin(), args, { cwd: opts.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let sid = opts.sessionId || '', buf = '', stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        let o: any; try { o = JSON.parse(line) } catch { continue }
        if (o.type === 'thread.started' && o.thread_id) { sid = o.thread_id; cbs.onSession(sid) }
        else if (o.type === 'item.completed' || o.type === 'item.started' || o.type === 'item.updated') {
          const it = o.item; if (!it) continue
          if (it.type === 'agent_message') { if (o.type === 'item.completed' && it.text) cbs.onDelta(it.text) }
          else { const tu = codexItemToTool(it); if (tu) cbs.onToolUse(tu) }
        }
      }
    })
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', (d: string) => { stderr += d })
    const done = new Promise<void>((resolve) => {
      child.on('error', (e) => { cbs.onError(e.message); resolve() })
      child.on('close', (code) => { if (code && code !== 0 && stderr) cbs.onError(stderr.trim().slice(0, 500)); cbs.onDone({ sessionId: sid, costUsd: 0 }); resolve() })
    })
    return { wait: () => done, kill: () => { try { child.kill('SIGKILL') } catch { /* */ } } }
  }
}
