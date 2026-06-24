import type { PluginContext, PluginExports } from '../../plugin-api/index'
import type { Session, Message, Project, SearchResult, FileChange, ToolUse, AgentSource } from './types'
import { aggregateFileChanges, computeEditDiff, type DiffLine } from './diff'
import { listProjects, listSessions, projectSessions, readSession, searchSessions, listRecentSessions, listSkills, listDirs, getConfig, listModels, type ModelInfo } from './history'
import { sendAgent } from './claude'
import {
  initIcons,
  IconSearch, IconRefresh, IconPlus, IconX, IconChevronRight, IconChevronDown,
  IconArrowLeft, IconSend, IconMenu, IconBrain, IconCopy, IconCheck,
  IconFolder, IconZap, IconHash, IconTerminal, IconFileText, IconPencil,
  IconEye, IconGlobe, IconSettings, IconMessageSquare, IconSquarePen, IconClaude, IconUser,
} from './icons'

export function activate(ctx: PluginContext): PluginExports {
  const h = ctx.h
  initIcons(h)

  // --- State ---
  const view = ctx.ref<'browse' | 'chat'>('browse')
  const projects = ctx.ref<Project[]>([])
  const sessions = ctx.ref<Session[]>([])
  const selectedProject = ctx.ref<string | null>(null)
  const selectedProjectEncoded = ctx.ref<string | null>(null)
  const activeSession = ctx.ref<Session | null>(null)
  const messages = ctx.ref<Message[]>([])
  const searchQuery = ctx.ref('')
  const searchResults = ctx.ref<SearchResult[]>([])
  const searching = ctx.ref(false)
  const inputText = ctx.ref('')
  const sending = ctx.ref(false)
  const elapsedSec = ctx.ref(0)
  let elapsedTimer: any = null
  const loading = ctx.ref(false)
  const costTotal = ctx.ref(0)
  const error = ctx.ref<string | null>(null)
  const sidebarOpen = ctx.ref(true)
  const sidebarTab = ctx.ref<'history' | 'search'>('history')
  const chatScrollRef = ctx.ref<HTMLElement | null>(null)
  const expandedTools = ctx.ref<Set<string>>(new Set())
  const recentSessions = ctx.ref<Session[]>([])
  const showCmdPalette = ctx.ref(false)
  const cmdFilter = ctx.ref('')
  const cmdSelectedIdx = ctx.ref(0)
  const skillsList = ctx.ref<{ id: string; name: string; description: string; allowedTools: string[] }[]>([])
  const showSkillsPanel = ctx.ref(false)
  const selectedSkillId = ctx.ref<string | null>(null)
  const browseSearch = ctx.ref('')
  const browseSearchOpen = ctx.ref(false)
  const permissionMode = ctx.ref<'default' | 'agent' | 'plan'>('default')
  const thinkingEnabled = ctx.ref(false)
  const stopRequested = ctx.ref(false)
  const changesPanelOpen = ctx.ref(false)
  const expandedFiles = ctx.ref<Set<string>>(new Set())
  const currentCwd = ctx.ref<string | null>(null)
  const showProjectPicker = ctx.ref(false)
  const pickerCurrentDir = ctx.ref('/')
  const pickerEntries = ctx.ref<{ name: string; path: string }[]>([])
  const pickerLoading = ctx.ref(false)
  const showSettings = ctx.ref(false)
  const settings = ctx.ref<{ claudeConfigDir: string; codexHome: string; claudeBin: string; codexBin: string }>({ claudeConfigDir: '', codexHome: '', claudeBin: '', codexBin: '' })
  const favProjects = ctx.ref<Set<string>>(new Set())
  const favSessions = ctx.ref<Set<string>>(new Set())
  // Agent for a *new* chat (existing sessions use their own source). Streaming handle for real Stop.
  const newChatSource = ctx.ref<AgentSource>('claude-code')
  let activeStreamCancel: (() => void) | null = null
  // Model/effort for the next send: initialized from the session (inherit), editable (modify).
  const activeModel = ctx.ref<string>('')      // concrete model slug (codex)
  const activeEffort = ctx.ref<string>('')     // concrete effort: low|medium|high|xhigh (codex)
  const activePermission = ctx.ref<string>('') // read-only|workspace-write|danger-full-access (codex)
  const codexModels = ctx.ref<ModelInfo[]>([])

  // --- Computed ---
  const fileChanges = ctx.computed(() => aggregateFileChanges(messages.value))

  // Auto-expand all files when changes appear
  ctx.watch(fileChanges, (changes) => {
    if (changes.length > 0) {
      expandedFiles.value = new Set(changes.map(c => c.filePath))
    }
  })

  // --- Slash commands ---
  interface SlashCmd { name: string; desc: string; action: () => void }
  const slashCommands: SlashCmd[] = [
    { name: '/new', desc: 'Start a new conversation', action: startNewChat },
    { name: '/open', desc: 'Open Agents View', action: () => { view.value = 'browse'; sidebarOpen.value = true; loadProjects() } },
    { name: '/history', desc: 'Show conversation history', action: () => { sidebarOpen.value = true; sidebarTab.value = 'history'; loadProjects() } },
    { name: '/search', desc: 'Search conversations', action: () => { sidebarOpen.value = true; sidebarTab.value = 'search' } },
    { name: '/skills', desc: 'List available skills', action: loadAndShowSkills },
    { name: '/cwd', desc: 'Show or set working directory', action: showCwdInfo },
    { name: '/clear', desc: 'Clear current messages', action: () => { messages.value = []; error.value = null } },
    { name: '/cost', desc: 'Show total cost', action: () => { error.value = costTotal.value > 0 ? `Total cost: $${costTotal.value.toFixed(4)}` : 'No cost yet' } },
    { name: '/help', desc: 'Show available commands', action: () => { error.value = null; showCmdPalette.value = true; cmdFilter.value = '' } },
  ]

  async function loadAndShowSkills() {
    try {
      skillsList.value = await listSkills(exec)
      selectedSkillId.value = null
      showSkillsPanel.value = true
    } catch (e: any) {
      error.value = `Failed to load skills: ${e.message}`
    }
  }

  function useSkill(skill: { id: string; name: string }) {
    showSkillsPanel.value = false
    selectedSkillId.value = null
    inputText.value = `/${skill.id} `
  }

  function getFilteredSessions(): Session[] {
    const q = browseSearch.value.trim().toLowerCase()
    if (!q) return recentSessions.value
    return recentSessions.value.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.firstPrompt || '').toLowerCase().includes(q) ||
      (s.project || '').toLowerCase().includes(q) ||
      (s.gitBranch || '').toLowerCase().includes(q)
    )
  }

  async function showCwdInfo() {
    showProjectPicker.value = true
    const startDir = currentCwd.value || '~'
    pickerCurrentDir.value = startDir
    await loadPickerDirs(startDir)
  }

  async function loadPickerDirs(dir: string) {
    pickerLoading.value = true
    try {
      pickerEntries.value = await listDirs(exec, dir)
    } catch {
      pickerEntries.value = []
    } finally {
      pickerLoading.value = false
    }
  }

  async function navigatePickerDir(dir: string) {
    pickerCurrentDir.value = dir
    await loadPickerDirs(dir)
  }

  function selectProjectPath(p: string) {
    currentCwd.value = p
    showProjectPicker.value = false
    ctx.storage.set('cwd', p).catch(() => {})
  }

  function cyclePermissionMode() {
    const modes: Array<'default' | 'agent' | 'plan'> = ['default', 'agent', 'plan']
    const idx = modes.indexOf(permissionMode.value)
    permissionMode.value = modes[(idx + 1) % modes.length]
  }

  function getModeLabel(): string {
    switch (permissionMode.value) {
      case 'agent': return 'Agent'
      case 'plan': return 'Plan'
      default: return 'Default'
    }
  }

  function getModeIcon(): string {
    switch (permissionMode.value) {
      case 'agent': return '∞'
      case 'plan': return '☐'
      default: return '💬'
    }
  }

  function getFilteredCmds(): SlashCmd[] {
    const f = cmdFilter.value.toLowerCase()
    // Merge built-in commands with loaded skills
    const allCmds: SlashCmd[] = [
      ...slashCommands,
      ...skillsList.value.map(s => ({
        name: `/${s.id}`,
        desc: s.description || s.name,
        action: () => useSkill(s),
      })),
    ]
    return f ? allCmds.filter(c => c.name.includes(f) || c.desc.toLowerCase().includes(f)) : allCmds
  }

  function execCmd(cmd: SlashCmd) {
    showCmdPalette.value = false
    cmdFilter.value = ''
    cmdSelectedIdx.value = 0
    inputText.value = ''
    cmd.action()
  }

  // --- Exec helper (injects the configured per-agent dirs / binary as env) ---
  function settingsEnv(): Record<string, string> {
    const s = settings.value, env: Record<string, string> = {}
    if (s.claudeConfigDir && s.claudeConfigDir.trim()) env.CLAUDE_CONFIG_DIR = s.claudeConfigDir.trim()
    if (s.codexHome && s.codexHome.trim()) env.CODEX_HOME = s.codexHome.trim()
    if (s.claudeBin && s.claudeBin.trim()) env.CLAUDE_BIN = s.claudeBin.trim()
    if (s.codexBin && s.codexBin.trim()) env.CODEX_BIN = s.codexBin.trim()
    return env
  }
  function exec(args: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }) {
    return ctx.exec.run(args, { ...options, env: { ...settingsEnv(), ...(options?.env || {}) } })
  }
  function spawnExec(args: string[], options?: { cwd?: string; env?: Record<string, string> }) {
    const env = { ...settingsEnv(), ...(options?.env || {}) }
    // dinotty's spawn WS drops cwd/env (unlike run), so smuggle them in via args — the
    // CLI applies `--with-env` before dispatch. (Still pass options for when the host is fixed.)
    const cfg = JSON.stringify({ cwd: options?.cwd || '', env })
    return ctx.exec.spawn(['--with-env', cfg, ...args], { ...options, env })
  }
  async function loadSettings() {
    let saved: any = {}
    try { saved = (await ctx.storage.get<any>('settings')) || {} } catch { /* */ }
    // Prefill empty fields with the actually-resolved defaults (so the panel
    // shows what's being used, not blanks).
    let def = { claudeConfigDir: '', codexHome: '', claudeBin: '', codexBin: '' }
    try { def = await getConfig(exec) } catch { /* */ }
    settings.value = {
      claudeConfigDir: saved.claudeConfigDir || def.claudeConfigDir || '',
      codexHome: saved.codexHome || def.codexHome || '',
      claudeBin: saved.claudeBin || def.claudeBin || '',
      codexBin: saved.codexBin || def.codexBin || '',
    }
  }
  async function loadModels() {
    try { codexModels.value = await listModels(exec, 'codex') } catch { /* */ }
  }
  // Resolve concrete codex defaults so selectors never show a bare "default".
  function defaultCodexModel(): string { return codexModels.value[0]?.slug || 'gpt-5.5' }
  function codexDefaultEffort(model: string): string { return codexModels.value.find(m => m.slug === model)?.defaultEffort || 'medium' }
  // Set the codex selectors from a session (inherit) or to sensible defaults (new chat).
  async function applyCodexControls(session: Session | null) {
    if (!codexModels.value.length) { try { await loadModels() } catch { /* */ } }
    const model = (session?.model) || defaultCodexModel()
    activeModel.value = model
    activeEffort.value = (session?.effort) || codexDefaultEffort(model)
    activePermission.value = (session?.permission) || 'workspace-write'
  }
  async function refreshLists() {
    loadRecentSessions()
    loadProjects()
    if (selectedProject.value) {
      try { sessions.value = await projectSessions(exec, selectedProject.value) } catch { /* */ }
    }
  }
  async function saveSettings() {
    try { await ctx.storage.set('settings', settings.value) } catch { /* ignore */ }
    showSettings.value = false
    refreshLists()
  }

  // --- Favorites (local only, via ctx.storage — not synced through mem.conf) ---
  async function loadFavorites() {
    try {
      const f = await ctx.storage.get<any>('favorites')
      if (f && typeof f === 'object') {
        favProjects.value = new Set(Array.isArray(f.projects) ? f.projects : [])
        favSessions.value = new Set(Array.isArray(f.sessions) ? f.sessions : [])
      }
    } catch { /* */ }
  }
  function persistFavorites() {
    ctx.storage.set('favorites', { projects: [...favProjects.value], sessions: [...favSessions.value] }).catch(() => {})
  }
  function toggleFavProject(path: string) {
    const s = new Set(favProjects.value); s.has(path) ? s.delete(path) : s.add(path); favProjects.value = s; persistFavorites()
  }
  function toggleFavSession(id: string) {
    const s = new Set(favSessions.value); s.has(id) ? s.delete(id) : s.add(id); favSessions.value = s; persistFavorites()
  }
  // Stable sort: starred first, original order preserved within each group.
  function sortProjectsByFav(list: Project[]): Project[] {
    return [...list].sort((a, b) => (favProjects.value.has(b.path) ? 1 : 0) - (favProjects.value.has(a.path) ? 1 : 0))
  }
  function sortSessionsByFav(list: Session[]): Session[] {
    return [...list].sort((a, b) => (favSessions.value.has(b.id) ? 1 : 0) - (favSessions.value.has(a.id) ? 1 : 0))
  }
  function starBtn(active: boolean, onToggle: () => void) {
    return h('span', {
      onClick: (e: Event) => { e.stopPropagation(); onToggle() },
      title: active ? 'Unstar' : 'Star',
      style: `cursor:pointer;font-size:13px;line-height:1;margin:0 2px;${active ? 'color:#f5c518' : 'opacity:.35'}`,
    }, active ? '★' : '☆')
  }

  // Source badge: distinguishes Claude Code vs Codex sessions.
  function srcBadge(source?: string) {
    if (!source) return null
    const codex = source === 'codex'
    return h('span', {
      class: 'ccm-tag',
      title: source,
      style: codex
        ? 'background:rgba(96,165,250,0.16);color:#60a5fa;font-weight:600'
        : 'background:rgba(217,119,87,0.16);color:#d97757;font-weight:600',
    }, codex ? 'Codex' : 'Claude')
  }

  // Agent selector for a new chat (Claude / Codex).
  function agentChip(src: AgentSource, label: string) {
    const active = newChatSource.value === src
    const on = src === 'codex' ? 'background:rgba(96,165,250,0.18);color:#60a5fa' : 'background:rgba(217,119,87,0.18);color:#d97757'
    return h('span', {
      onClick: (e: Event) => { e.stopPropagation(); newChatSource.value = src; if (src === 'codex' && !activeSession.value) applyCodexControls(null) },
      title: `New chat with ${label}`,
      style: `cursor:pointer;font-size:11px;font-weight:600;padding:1px 7px;border-radius:10px;${active ? on : 'opacity:.45'}`,
    }, label)
  }

  // Model + effort + permission selectors (Codex). Selection is pre-filled from the session
  // (inherit) and concrete — never a bare "default".
  function renderModelEffort() {
    const effSource: AgentSource = activeSession.value?.source || newChatSource.value
    if (effSource !== 'codex') return null
    const sel = (value: string, onChange: (v: string) => void, opts: { v: string; label: string }[], title: string) =>
      h('select', {
        title, value,
        style: 'font-size:11px;background:transparent;border:1px solid var(--border-color,rgba(255,255,255,.14));border-radius:8px;padding:1px 4px;color:inherit;cursor:pointer;max-width:150px',
        onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
      }, opts.map(o => h('option', { value: o.v }, o.label)))
    // Model — concrete current value, always present in the option list.
    const curModel = activeModel.value || defaultCodexModel()
    const modelOpts = codexModels.value.map(m => ({ v: m.slug, label: m.name || m.slug }))
    if (!modelOpts.some(o => o.v === curModel)) modelOpts.unshift({ v: curModel, label: curModel })
    // Effort — restricted to the model's supported levels.
    const cur = codexModels.value.find(m => m.slug === curModel)
    const effortList = (cur?.efforts && cur.efforts.length) ? cur.efforts : ['low', 'medium', 'high', 'xhigh']
    const curEffort = activeEffort.value || codexDefaultEffort(curModel)
    const effortOpts = effortList.map(e => ({ v: e, label: `effort: ${e}` }))
    if (!effortOpts.some(o => o.v === curEffort)) effortOpts.unshift({ v: curEffort, label: `effort: ${curEffort}` })
    // Permission / sandbox (YOLO = full access).
    const curPerm = activePermission.value || 'workspace-write'
    const permOpts = [
      { v: 'read-only', label: 'read-only' },
      { v: 'workspace-write', label: 'workspace-write' },
      { v: 'danger-full-access', label: 'full-access (YOLO)' },
    ]
    if (!permOpts.some(o => o.v === curPerm)) permOpts.unshift({ v: curPerm, label: curPerm })
    return h('span', { style: 'display:inline-flex;gap:4px;align-items:center' }, [
      sel(curModel, (v) => { activeModel.value = v; const m = codexModels.value.find(x => x.slug === v); if (m && m.efforts.length && !m.efforts.includes(activeEffort.value)) activeEffort.value = m.defaultEffort || 'medium' }, modelOpts, 'Model'),
      sel(curEffort, (v) => { activeEffort.value = v }, effortOpts, 'Reasoning effort'),
      sel(curPerm, (v) => { activePermission.value = v }, permOpts, 'Permission / sandbox (YOLO = full access)'),
    ])
  }

  function encodePath(projectPath: string): string {
    // Same encoding Claude Code uses: /Users/talentc/rust/dinotty-plugins → -Users-talentc-rust-dinotty-plugins
    return projectPath.replace(/^\//, '').replace(/\//g, '-')
  }

  // --- Get active terminal's working directory ---
  async function getActiveCwd(): Promise<string | undefined> {
    try {
      const paneId = ctx.terminal.activePaneId()
      if (!paneId) return undefined
      const res = await fetch(`/api/workspace/list?pane_id=${encodeURIComponent(paneId)}`)
      if (!res.ok) return undefined
      const data = await res.json()
      return data.cwd || undefined
    } catch {
      return undefined
    }
  }

  // --- Data loading ---
  async function loadProjects() {
    try {
      projects.value = await listProjects(exec)
    } catch (e: any) {
      error.value = e.message
    }
  }

  async function loadRecentSessions() {
    loading.value = true
    error.value = null
    console.log('[agents-view] loadRecentSessions: starting')
    try {
      const result = await exec(['list-recent', '30'], { timeout: 15_000 })
      console.log('[agents-view] list-recent result:', result.code, result.stdout?.length, result.stderr?.slice(0, 200))
      if (result.code !== 0) {
        throw new Error(result.stderr || 'list-recent failed')
      }
      const parsed = JSON.parse(result.stdout)
      console.log('[agents-view] parsed sessions:', parsed.length)
      recentSessions.value = parsed
    } catch (e: any) {
      console.error('[agents-view] loadRecentSessions error:', e.message)
      // Fallback: load sessions from each project
      try {
        if (projects.value.length === 0) {
          const projResult = await exec(['list-projects'], { timeout: 10_000 })
          if (projResult.code === 0) {
            projects.value = JSON.parse(projResult.stdout)
          }
        }
        const all: Session[] = []
        for (const p of projects.value.slice(0, 8)) {
          try {
            const sessResult = await exec(['list-sessions', p.encodedPath], { timeout: 10_000 })
            if (sessResult.code === 0) {
              const sess = JSON.parse(sessResult.stdout)
              all.push(...sess.slice(0, 5))
            }
          } catch { /* skip */ }
        }
        all.sort((a, b) => {
          const ta = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0
          const tb = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0
          return tb - ta
        })
        recentSessions.value = all.slice(0, 30)
        console.log('[agents-view] fallback loaded:', all.length, 'sessions')
      } catch (e2: any) {
        console.error('[agents-view] fallback error:', e2.message)
        error.value = `Failed to load sessions: ${e.message}`
      }
    } finally {
      loading.value = false
    }
  }

  async function selectProject(project: Project) {
    // Toggle: collapse if already expanded
    if (selectedProject.value === project.path) {
      selectedProject.value = null
      selectedProjectEncoded.value = null
      sessions.value = []
      return
    }
    selectedProject.value = project.path
    selectedProjectEncoded.value = project.encodedPath
    loading.value = true
    error.value = null
    try {
      sessions.value = await projectSessions(exec, project.path)
    } catch (e: any) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function openSession(session: Session) {
    activeSession.value = session
    view.value = 'chat'
    loading.value = true
    error.value = null
    messages.value = []
    expandedTools.value = new Set()
    // Inherit the session's model/effort/permission as the default for the next send (editable).
    if (session.source === 'codex') applyCodexControls(session)
    // Set working directory from session project
    if (session.project && session.project !== '.') {
      currentCwd.value = session.project
    }
    try {
      messages.value = await readSession(exec, session.encodedPath, session.id, session.source)
      scrollToBottom()
    } catch (e: any) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function startNewChat() {
    activeSession.value = null
    messages.value = []
    inputText.value = ''
    costTotal.value = 0
    error.value = null
    expandedTools.value = new Set()
    if (newChatSource.value === 'codex') applyCodexControls(null)  // concrete codex defaults
    view.value = 'chat'
    sidebarOpen.value = false
    // Load saved CWD from storage
    if (!currentCwd.value) {
      try {
        const saved = await ctx.storage.get<string>('cwd')
        if (saved) currentCwd.value = saved
      } catch { /* skip */ }
    }
  }

  async function doSearch() {
    const q = searchQuery.value.trim()
    if (!q) return
    searching.value = true
    error.value = null
    try {
      searchResults.value = await searchSessions(exec, q)
    } catch (e: any) {
      error.value = e.message
    } finally {
      searching.value = false
    }
  }

  function stopSending() {
    stopRequested.value = true
    if (activeStreamCancel) { try { activeStreamCancel() } catch { /* */ } }
    activeStreamCancel = null
    sending.value = false
  }

  // Register a session row for a freshly-minted new chat so reconcile can read it back.
  function setActiveFromNew(sessionId: string, source: AgentSource, cwd?: string) {
    const projectPath = selectedProject.value || cwd || currentCwd.value || '.'
    activeSession.value = {
      id: sessionId, project: projectPath, encodedPath: encodePath(projectPath),
      firstPrompt: (messages.value.find(m => m.role === 'user')?.content || '').slice(0, 200),
      lastTimestamp: new Date().toISOString(), messageCount: 1, source,
    }
    if (projectPath && projectPath !== '.') currentCwd.value = projectPath
  }

  // Keep the view pinned to the newest content during a stream (only if already near bottom).
  function streamScroll() {
    setTimeout(() => {
      const el = chatScrollRef.value
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
    }, 0)
  }

  /**
   * Try a streamed turn over `agent-stream`. Returns false (so the caller falls back to a
   * blocking send) when streaming is unsupported or yields nothing. Mutates `asst` in place.
   */
  async function trySendStreaming(
    opts: { source: AgentSource; mode: 'new' | 'resume'; sessionId: string; prompt: string; cwd?: string; model?: string; effort?: string; permission?: string },
    asst: Message, ensureAsst: () => void, touch: () => void,
  ): Promise<boolean> {
    let handle: ReturnType<typeof spawnExec>
    try {
      handle = spawnExec(['agent-stream', opts.source, opts.mode === 'new' ? '--new' : '--resume', opts.sessionId || '', opts.model || '', opts.effort || '', opts.permission || '', opts.prompt], { cwd: opts.cwd })
    } catch { return false }
    if (!handle || !handle.stdout) return false
    activeStreamCancel = () => { try { handle.kill() } catch { /* */ } }

    const upsertTool = (tool: ToolUse) => {
      ensureAsst()
      const tools = asst.toolUses || (asst.toolUses = [])
      const idx = tool.callId ? tools.findIndex(t => t.callId === tool.callId) : -1
      if (idx >= 0) tools[idx] = { ...tools[idx], ...tool }
      else tools.push(tool)
    }
    let gotAnything = false, unsupported = false, newSessionId = ''
    const handleEvent = (o: any) => {
      if (!o || !o.type) return
      switch (o.type) {
        case 'unsupported': unsupported = true; break
        case 'session': newSessionId = o.sessionId || newSessionId; break
        case 'delta': gotAnything = true; ensureAsst(); asst.content += (o.text || ''); touch(); streamScroll(); break
        case 'tool': gotAnything = true; upsertTool(o.tool); touch(); streamScroll(); break
        case 'error': if (gotAnything) error.value = o.message; break
        case 'done': newSessionId = o.sessionId || newSessionId; costTotal.value += (o.costUsd || 0); break
      }
    }

    const reader = handle.stdout.getReader()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += value
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line) continue
          try { handleEvent(JSON.parse(line)) } catch { /* partial/non-json */ }
        }
      }
    } catch { /* reader aborted (e.g. Stop) */ }

    activeStreamCancel = null
    if (unsupported) return false
    if (!gotAnything && !newSessionId && !stopRequested.value) return false // produced nothing → fall back
    if (opts.mode === 'new' && newSessionId) setActiveFromNew(newSessionId, opts.source, opts.cwd)
    return true
  }

  async function sendMessage() {
    const text = inputText.value.trim()
    if (!text || sending.value) return

    const source: AgentSource = activeSession.value?.source || newChatSource.value
    const mode: 'new' | 'resume' = activeSession.value ? 'resume' : 'new'
    const existingId = activeSession.value?.id || ''
    const model = activeModel.value || undefined  // initialized from the session = inherit; user-changed = modify
    const effort = activeEffort.value || undefined
    const permission = source === 'codex' ? (activePermission.value || undefined) : undefined

    sending.value = true
    stopRequested.value = false
    error.value = null
    elapsedSec.value = 0
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => { elapsedSec.value++ }, 1000)

    const userMsg: Message = { uuid: 'pending-' + Date.now(), role: 'user', content: text, timestamp: new Date().toISOString(), source }
    messages.value = [...messages.value, userMsg]
    inputText.value = ''
    scrollToBottom()

    // Optimistic assistant bubble, mutated as the stream arrives (appended lazily on first output).
    const asstId = 'resp-' + Date.now()
    const asst: Message = { uuid: asstId, role: 'assistant', content: '', timestamp: new Date().toISOString(), source, toolUses: [] }
    let asstAppended = false
    const ensureAsst = () => { if (!asstAppended) { messages.value = [...messages.value, asst]; asstAppended = true } }
    const touch = () => { messages.value = [...messages.value] }

    try {
      const cwd = currentCwd.value || await getActiveCwd()
      if (stopRequested.value) return

      const streamed = await trySendStreaming({ source, mode, sessionId: existingId, prompt: text, cwd, model, effort, permission }, asst, ensureAsst, touch)
      if (!streamed && !stopRequested.value) {
        // Blocking fallback (streaming unsupported or empty).
        const r = await sendAgent(exec, source, mode, existingId, text, { cwd, model, effort, permission })
        if (stopRequested.value) return
        costTotal.value += r.costUsd
        if (mode === 'new' && r.sessionId) setActiveFromNew(r.sessionId, source, cwd)
        asst.content = r.response
        ensureAsst(); touch()
      }
      scrollToBottom()
      if (!stopRequested.value) await reconcileActiveSession()
    } catch (e: any) {
      if (!stopRequested.value) {
        error.value = e.message
        messages.value = messages.value.filter(m => !m.uuid.startsWith('pending-') && m.uuid !== asstId)
      }
    } finally {
      sending.value = false
      stopRequested.value = false
      activeStreamCancel = null
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
    }
  }

  function scrollToBottom() {
    setTimeout(() => {
      const el = chatScrollRef.value
      if (el) el.scrollTop = el.scrollHeight
    }, 50)
  }

  // After a send completes, re-read the on-disk transcript so tool steps appear,
  // preserving the user's scroll position (only auto-stick if already at bottom).
  async function reconcileActiveSession() {
    const s = activeSession.value
    if (!s) return
    const el = chatScrollRef.value
    const atBottom = el ? (el.scrollHeight - el.scrollTop - el.clientHeight < 48) : true
    const prevTop = el ? el.scrollTop : 0
    try {
      const msgs = await readSession(exec, s.encodedPath, s.id, s.source)
      if (msgs && msgs.length) messages.value = msgs
    } catch { /* keep optimistic view */ }
    setTimeout(() => {
      const e2 = chatScrollRef.value
      if (!e2) return
      e2.scrollTop = atBottom ? e2.scrollHeight : prevTop
    }, 30)
  }

  function toggleTool(msgId: string, toolIdx: number) {
    const key = `${msgId}-${toolIdx}`
    const next = new Set(expandedTools.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expandedTools.value = next
  }

  function formatTime(ts: string): string {
    if (!ts) return ''
    try {
      const d = new Date(ts)
      const now = new Date()
      const diffMs = now.getTime() - d.getTime()
      const diffSec = Math.floor(diffMs / 1000)
      if (diffSec < 60) return 'just now'
      const diffMin = Math.floor(diffSec / 60)
      if (diffMin < 60) return `${diffMin}m ago`
      const diffH = Math.floor(diffMin / 60)
      if (diffH < 24) return `${diffH}h ago`
      const diffD = Math.floor(diffH / 24)
      if (diffD < 7) return `${diffD}d ago`
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch { return ts }
  }

  // --- Commands ---
  ctx.commands.register('agents-view.open', () => {
    view.value = 'browse'
    sidebarOpen.value = true
    loadProjects()
  })
  ctx.commands.register('agents-view.new', () => startNewChat())
  ctx.commands.register('agents-view.search', () => {
    sidebarOpen.value = true
    sidebarTab.value = 'search'
    loadProjects()
  })

  ctx.commands.registerQuickPick('agents-view.quick', {
    title: 'Agents View — Switch Session',
    async items() {
      const recent = await listRecentSessions(exec, 20)
      return recent.map(s => ({
        label: (s.name || s.firstPrompt || '').slice(0, 60) || '(empty)',
        detail: `${s.project} · ${formatTime(s.lastTimestamp)}`,
        icon: '💬',
        action() { openSession(s) },
      }))
    },
  })

  // ===== Render =====

  function renderHeader() {
    return h('div', { class: 'ccm-header' }, [
      h('div', { class: 'ccm-header-left' }, [
        h('button', {
          class: 'ccm-icon-btn',
          onClick: () => { sidebarOpen.value = !sidebarOpen.value },
          title: 'Toggle sidebar',
        }, IconMenu()),
        h('span', { class: 'ccm-header-title' },
          activeSession.value
            ? (activeSession.value.name || activeSession.value.firstPrompt?.slice(0, 60) || 'Session')
            : (view.value === 'chat' ? 'New Chat' : 'Agents View')
        ),
      ]),
      h('div', { class: 'ccm-header-right' }, [
        h('button', { class: 'ccm-icon-btn', onClick: () => { showSettings.value = true }, title: 'Settings' }, IconSettings(16)),
        costTotal.value > 0 ? h('span', { class: 'ccm-cost-badge' }, `$${costTotal.value.toFixed(3)}`) : null,
        fileChanges.value.length > 0 ? h('button', {
          class: `ccm-icon-btn ${changesPanelOpen.value ? 'ccm-icon-btn-active' : ''}`,
          onClick: () => { changesPanelOpen.value = !changesPanelOpen.value },
          title: `${fileChanges.value.length} changed files`,
        }, IconFileText(15)) : null,
        h('button', {
          class: 'ccm-icon-btn',
          onClick: startNewChat,
          title: 'New conversation',
        }, IconPlus()),
      ].filter(Boolean)),
    ])
  }

  function renderSidebar() {
    return h('div', { class: 'ccm-sidebar' }, [
      h('div', { class: 'ccm-sidebar-header' }, [
        h('div', { class: 'ccm-sidebar-tabs' }, [
          h('button', {
            class: `ccm-sidebar-tab ${sidebarTab.value === 'history' ? 'ccm-sidebar-tab-active' : ''}`,
            onClick: () => { sidebarTab.value = 'history' },
          }, 'History'),
          h('button', {
            class: `ccm-sidebar-tab ${sidebarTab.value === 'search' ? 'ccm-sidebar-tab-active' : ''}`,
            onClick: () => { sidebarTab.value = 'search' },
          }, 'Search'),
        ]),
        h('div', { style: 'display:flex;gap:4px' }, [
          h('button', { class: 'ccm-icon-btn ccm-icon-btn-sm', onClick: () => refreshLists(), title: 'Refresh' }, IconRefresh(14)),
          h('button', { class: 'ccm-icon-btn ccm-icon-btn-sm', onClick: startNewChat, title: 'New conversation' }, IconPlus()),
        ]),
      ]),
      sidebarTab.value === 'history' ? renderHistoryPanel() : renderSearchPanel(),
    ])
  }

  function renderHistoryPanel() {
    return h('div', { class: 'ccm-sidebar-body' }, [
      loading.value && !selectedProject.value ? h('div', { class: 'ccm-sidebar-loading' }, [
        h('span', { class: 'ccm-spinner' }),
      ]) : null,
      ...sortProjectsByFav(projects.value).map(p => h('div', { class: 'ccm-project-group' }, [
        h('div', {
          class: `ccm-project-header ${selectedProject.value === p.path ? 'ccm-project-header-active' : ''}`,
          style: 'display:flex;align-items:center',
          onClick: () => selectProject(p),
        }, [
          h('span', { class: 'ccm-project-chevron' }, selectedProject.value === p.path ? IconChevronDown(12) : IconChevronRight(12)),
          h('span', { class: 'ccm-project-icon' }, IconFolder(14)),
          h('span', { class: 'ccm-project-label' }, p.path.split('/').pop() || p.path),
          h('span', { style: 'opacity:.5;font-size:11px;margin-left:5px;font-variant-numeric:tabular-nums;flex:0 0 auto' }, `(${p.sessionCount})`),
          h('span', { style: 'margin-left:auto;display:flex;align-items:center' }, starBtn(favProjects.value.has(p.path), () => toggleFavProject(p.path))),
        ]),
        selectedProject.value === p.path ? h('div', { class: 'ccm-session-list' },
          loading.value ? [h('div', { class: 'ccm-sidebar-loading' }, [h('span', { class: 'ccm-spinner' })])] :
          sortSessionsByFav(sessions.value).map(s => h('div', {
            class: `ccm-session-row ${activeSession.value?.id === s.id ? 'ccm-session-row-active' : ''}`,
            style: 'display:flex;align-items:center;gap:8px',
            onClick: () => openSession(s),
          }, [
            h('div', { style: 'flex:1;min-width:0' }, [
              h('div', { class: 'ccm-session-text' }, (s.name || s.firstPrompt || '').slice(0, 50) || '(empty)'),
              h('div', { class: 'ccm-session-info' }, [
                srcBadge(s.source),
                h('span', null, formatTime(s.lastTimestamp)),
                s.gitBranch ? h('span', { class: 'ccm-tag' }, s.gitBranch) : null,
              ].filter(Boolean)),
            ]),
            starBtn(favSessions.value.has(s.id), () => toggleFavSession(s.id)),
          ]))
        ) : null,
      ])),
    ])
  }

  function renderSearchPanel() {
    return h('div', { class: 'ccm-sidebar-body' }, [
      h('div', { class: 'ccm-search-input-wrap' }, [
        h('input', {
          type: 'text',
          class: 'ccm-search-field',
          placeholder: 'Search conversations...',
          value: searchQuery.value,
          onInput: (e: Event) => { searchQuery.value = (e.target as HTMLInputElement).value },
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') doSearch() },
        }),
      ]),
      searching.value ? h('div', { class: 'ccm-sidebar-loading' }, [
        h('span', { class: 'ccm-spinner' }),
      ]) : null,
      ...searchResults.value.map(r => h('div', {
        class: 'ccm-session-row',
        onClick: () => openSession(r.session),
      }, [
        h('div', { class: 'ccm-session-text' }, (r.session.name || r.session.firstPrompt || '').slice(0, 50)),
        h('div', { class: 'ccm-search-snippet' }, r.match.slice(0, 80)),
        h('div', { class: 'ccm-session-info' }, [
          srcBadge(r.session.source),
          h('span', { class: 'ccm-tag' }, r.session.project.split('/').pop()),
          h('span', null, formatTime(r.session.lastTimestamp)),
        ]),
      ])),
    ])
  }

  function renderChat() {
    return h('div', { class: 'ccm-chat' }, [
      h('div', {
        class: 'ccm-messages',
        ref: (el: HTMLElement) => { chatScrollRef.value = el },
      }, [
        messages.value.length === 0 ? renderEmptyState() : null,
        ...messages.value.map((msg, i) => renderMessage(msg, i)),
        sending.value ? renderTypingIndicator() : null,
      ]),
      error.value ? h('div', { class: 'ccm-error-bar' }, [
        h('span', null, error.value),
        h('button', { class: 'ccm-error-close', onClick: () => { error.value = null } }, IconX(14)),
      ]) : null,
      renderInput(),
    ])
  }

  function renderEmptyState() {
    return h('div', { class: 'ccm-empty' }, [
      h('div', { class: 'ccm-empty-logo' }, IconClaude(48)),
      h('div', { class: 'ccm-empty-heading' }, activeSession.value ? 'Loading conversation...' : 'Start a new conversation'),
      h('div', { class: 'ccm-empty-sub' }, activeSession.value ? '' : 'Type a message below to start chatting with your agent'),
    ])
  }

  function renderTypingIndicator() {
    return h('div', { class: 'ccm-typing' }, [
      h('div', { class: 'ccm-typing-dots' }, [
        h('div', { class: 'ccm-typing-dot' }),
        h('div', { class: 'ccm-typing-dot' }),
        h('div', { class: 'ccm-typing-dot' }),
      ]),
      h('span', { class: 'ccm-typing-elapsed', style: 'font-size:12px;opacity:.6;font-variant-numeric:tabular-nums' }, `${elapsedSec.value}s`),
      h('button', {
        class: 'ccm-stop-btn',
        onClick: stopSending,
        title: 'Stop generating',
      }, 'Stop'),
    ])
  }

  function renderMessage(msg: Message, index: number) {
    const isUser = msg.role === 'user'
    const prevRole = index > 0 ? messages.value[index - 1].role : null
    const showDivider = prevRole !== null && prevRole !== msg.role

    return h('div', { class: `ccm-message ${isUser ? 'ccm-message-user' : 'ccm-message-assistant'}` }, [
      showDivider ? h('div', { class: 'ccm-divider' }) : null,
      h('div', { class: 'ccm-message-gutter' }, [
        h('div', { class: `ccm-avatar ${isUser ? 'ccm-avatar-user' : 'ccm-avatar-assistant'}` },
          isUser ? IconUser(16) : IconClaude(16)
        ),
      ]),
      h('div', { class: 'ccm-message-body' }, [
        h('div', { class: 'ccm-message-meta' }, [
          h('span', { class: 'ccm-message-role' }, isUser ? 'You' : (msg.source === 'codex' ? 'Codex' : 'Claude')),
          msg.model ? h('span', { class: 'ccm-model-tag' }, msg.model) : null,
          h('span', { class: 'ccm-message-time' }, formatTime(msg.timestamp)),
        ].filter(Boolean)),
        h('div', { class: 'ccm-message-content' }, renderMarkdown(msg.content)),
        msg.toolUses && msg.toolUses.length > 0
          ? h('div', { class: 'ccm-tools-section' },
              msg.toolUses.map((t, i) => renderToolCard(msg.uuid, t, i))
            )
          : null,
      ]),
    ])
  }

  function renderToolCard(msgId: string, tool: ToolUse, index: number) {
    const key = `${msgId}-${index}`
    const expanded = expandedTools.value.has(key)
    const preStyle = 'white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:240px;margin:0;font-size:12px'
    const labelStyle = 'opacity:.55;font-size:11px;margin:0 0 2px'

    return h('div', { class: `ccm-tool-card ${expanded ? 'ccm-tool-card-expanded' : ''}` }, [
      h('div', {
        class: 'ccm-tool-header',
        onClick: () => toggleTool(msgId, index),
      }, [
        h('span', { class: 'ccm-tool-icon' }, getToolIcon(tool.name)),
        h('span', { class: 'ccm-tool-name' }, tool.name),
        h('span', { class: 'ccm-tool-summary' }, tool.summary),
        h('span', { class: 'ccm-tool-chevron' }, expanded ? IconChevronDown(12) : IconChevronRight(12)),
      ]),
      expanded ? h('div', { class: 'ccm-tool-detail' }, [
        tool.args ? h('div', { class: 'ccm-tool-block' }, [
          h('div', { style: labelStyle }, 'Call'),
          h('pre', { style: preStyle }, tool.args),
        ]) : null,
        tool.output != null ? h('div', { class: 'ccm-tool-block', style: 'margin-top:6px' }, [
          h('div', { style: labelStyle }, 'Output'),
          h('pre', { style: preStyle }, tool.output),
        ]) : null,
        (!tool.args && tool.output == null) ? h('code', null, `${tool.name}: ${tool.summary}`) : null,
      ].filter(Boolean)) : null,
    ])
  }

  function getToolIcon(name: string): any {
    switch (name) {
      case 'Bash': return IconTerminal(14)
      case 'Read': return IconEye(14)
      case 'Edit': case 'Write': return IconPencil(14)
      case 'Grep': case 'Glob': return IconSearch(14)
      case 'Agent': return IconZap(14)
      case 'WebFetch': case 'WebSearch': return IconGlobe(14)
      default: return IconSettings(14)
    }
  }

  function renderInput() {
    return h('div', { class: 'ccm-input-area' }, [
      showCmdPalette.value ? renderCommandPalette() : null,
      h('div', { class: 'ccm-input-container' }, [
        h('textarea', {
          class: 'ccm-input',
          placeholder: activeSession.value ? 'Continue the conversation...  (type / for commands)' : 'Ask your agent anything...  (type / for commands)',
          value: inputText.value,
          onInput: (e: Event) => {
            inputText.value = (e.target as HTMLTextAreaElement).value
            const el = e.target as HTMLTextAreaElement
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 200) + 'px'
            // Show command palette when input starts with /
            const text = inputText.value
            if (text.startsWith('/')) {
              showCmdPalette.value = true
              cmdFilter.value = text.slice(1)
              cmdSelectedIdx.value = 0
            } else {
              showCmdPalette.value = false
            }
          },
          onKeydown: (e: KeyboardEvent) => {
            const cmds = getFilteredCmds()
            if (showCmdPalette.value && cmds.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                cmdSelectedIdx.value = (cmdSelectedIdx.value + 1) % cmds.length
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                cmdSelectedIdx.value = (cmdSelectedIdx.value - 1 + cmds.length) % cmds.length
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                execCmd(cmds[cmdSelectedIdx.value])
                return
              }
              if (e.key === 'Escape') {
                showCmdPalette.value = false
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendMessage()
            }
          },
          disabled: sending.value,
        }),
        h('div', { class: 'ccm-input-actions' }, [
          h('button', {
            class: 'ccm-send-btn',
            onClick: sendMessage,
            disabled: sending.value || !inputText.value.trim(),
            title: 'Send (Enter)',
          }, sending.value ? h('span', { class: 'ccm-spinner ccm-spinner-sm' }) : IconSend(16)),
        ]),
      ]),
      h('div', { class: 'ccm-input-hint' }, [
        h('span', {
          class: 'ccm-cwd-badge',
          title: currentCwd.value ? `Click to change: ${currentCwd.value}` : 'Click to set project directory',
          onClick: showCwdInfo,
        }, [
          IconFolder(12),
          h('span', null, currentCwd.value ? (currentCwd.value.split('/').pop() || currentCwd.value) : 'Set project'),
        ]),
        // New chat: choose the agent. Existing session: show which agent it is.
        activeSession.value
          ? (activeSession.value.source ? srcBadge(activeSession.value.source) : null)
          : h('span', { style: 'display:inline-flex;gap:2px;align-items:center' }, [agentChip('claude-code', 'Claude'), agentChip('codex', 'Codex')]),
        // Model + effort (Codex): default = inherited from the session, editable.
        renderModelEffort(),
        h('span', null, 'Shift+Enter for new line  |  / for commands'),
      ]),
    ])
  }

  // ===== File Changes Panel =====

  function renderChangesPanel() {
    const changes = fileChanges.value
    const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0)
    const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0)

    return h('div', { class: 'ccm-changes-panel' }, [
      h('div', { class: 'ccm-changes-header' }, [
        h('div', { class: 'ccm-changes-header-left' }, [
          h('span', { class: 'ccm-changes-title' }, `${changes.length} changed files`),
          renderDiffChanges(totalAdditions, totalDeletions, 'default'),
        ]),
        h('button', {
          class: 'ccm-icon-btn ccm-icon-btn-sm',
          onClick: () => { changesPanelOpen.value = false },
          title: 'Close panel',
        }, IconX(14)),
      ]),
      h('div', { class: 'ccm-changes-list' },
        changes.map(change => renderFileChangeItem(change))
      ),
    ])
  }

  function renderDiffChanges(additions: number, deletions: number, variant: 'default' | 'bars' = 'default') {
    if (variant === 'bars') {
      const TOTAL_BLOCKS = 5
      const total = additions + deletions
      let addBlocks = 0
      let delBlocks = 0

      if (total > 0) {
        if (total < 5) {
          addBlocks = additions > 0 ? 1 : 0
          delBlocks = deletions > 0 ? 1 : 0
        } else {
          const ratio = additions / total
          addBlocks = Math.max(1, Math.round(ratio * TOTAL_BLOCKS))
          delBlocks = TOTAL_BLOCKS - addBlocks
        }
      }

      return h('div', { class: 'ccm-diff-bars' }, [
        ...Array.from({ length: addBlocks }, (_, i) =>
          h('span', { class: 'ccm-diff-bar ccm-diff-bar-add', key: `a${i}` })
        ),
        ...Array.from({ length: delBlocks }, (_, i) =>
          h('span', { class: 'ccm-diff-bar ccm-diff-bar-del', key: `d${i}` })
        ),
      ])
    }

    return h('span', { class: 'ccm-diff-changes' }, [
      additions > 0 ? h('span', { class: 'ccm-diff-add' }, `+${additions}`) : null,
      deletions > 0 ? h('span', { class: 'ccm-diff-del' }, `-${deletions}`) : null,
    ].filter(Boolean))
  }

  function renderFileChangeItem(change: FileChange) {
    const expanded = expandedFiles.value.has(change.filePath)
    const fileName = change.filePath.split('/').pop() || change.filePath
    const dirPath = change.filePath.slice(0, change.filePath.lastIndexOf('/'))

    return h('div', { class: `ccm-change-item ${expanded ? 'ccm-change-item-expanded' : ''}` }, [
      h('div', {
        class: 'ccm-change-header',
        onClick: () => {
          const next = new Set(expandedFiles.value)
          if (next.has(change.filePath)) next.delete(change.filePath)
          else next.add(change.filePath)
          expandedFiles.value = next
        },
      }, [
        h('span', { class: 'ccm-change-chevron' },
          expanded ? IconChevronDown(12) : IconChevronRight(12)
        ),
        h('span', { class: 'ccm-change-icon' }, IconFileText(14)),
        h('div', { class: 'ccm-change-info' }, [
          h('span', { class: 'ccm-change-filename' }, fileName),
          h('span', { class: 'ccm-change-dir' }, dirPath),
        ]),
        renderDiffChanges(change.additions, change.deletions, 'bars'),
      ]),
      expanded ? renderFileDiff(change) : null,
    ])
  }

  function renderFileDiff(change: FileChange) {
    const operations: DiffLine[] = []

    for (const msg of messages.value) {
      if (!msg.toolUses) continue
      for (const tu of msg.toolUses) {
        if (tu.filePath !== change.filePath) continue
        if (tu.name === 'Edit' && tu.oldString !== undefined && tu.newString !== undefined) {
          operations.push(...computeEditDiff(tu.oldString, tu.newString))
        } else if (tu.name === 'Write' && tu.content !== undefined) {
          const lines = tu.content.split('\n')
          for (const line of lines) {
            operations.push({ type: 'add', text: line })
          }
        }
      }
    }

    return h('div', { class: 'ccm-change-diff' },
      operations.map((line, i) =>
        h('div', {
          class: `ccm-diff-line ${line.type === 'add' ? 'ccm-diff-line-add' : line.type === 'del' ? 'ccm-diff-line-del' : 'ccm-diff-line-ctx'}`,
          key: i,
        }, [
          h('span', { class: 'ccm-diff-prefix' }, line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '),
          h('span', { class: 'ccm-diff-text' }, line.text),
        ])
      )
    )
  }

  function renderStatusBar() {
    return h('div', { class: 'ccm-statusbar' }, [
      h('div', { class: 'ccm-statusbar-left' }, [
        h('span', { class: 'ccm-statusbar-item' }, [
          IconClaude(12),
          h('span', null, ' Agents View'),
        ]),
        activeSession.value ? h('span', { class: 'ccm-statusbar-sep' }, '|') : null,
        activeSession.value ? h('span', { class: 'ccm-statusbar-item ccm-statusbar-muted' },
          activeSession.value.project?.split('/').pop() || ''
        ) : null,
      ]),
      h('div', { class: 'ccm-statusbar-right' }, [
        messages.value.length > 0 ? h('span', { class: 'ccm-statusbar-item ccm-statusbar-muted' },
          `${messages.value.length} messages`
        ) : null,
        costTotal.value > 0 ? h('span', { class: 'ccm-statusbar-item ccm-statusbar-cost' },
          `$${costTotal.value.toFixed(4)}`
        ) : null,
        sending.value ? h('span', { class: 'ccm-statusbar-item ccm-statusbar-active' }, [
          h('span', { class: 'ccm-spinner ccm-spinner-xs' }),
          h('span', null, 'thinking'),
        ]) : null,
      ]),
    ])
  }

  // --- Keyboard shortcuts ---
  function handleGlobalKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'b') {
      e.preventDefault()
      sidebarOpen.value = !sidebarOpen.value
    }
    if (mod && e.key === 'n') {
      e.preventDefault()
      startNewChat()
    }
    if (mod && e.key === 'k') {
      e.preventDefault()
      showCmdPalette.value = !showCmdPalette.value
      cmdFilter.value = ''
      cmdSelectedIdx.value = 0
    }
    if (mod && e.key === 'd') {
      e.preventDefault()
      if (fileChanges.value.length > 0) {
        changesPanelOpen.value = !changesPanelOpen.value
      }
    }
  }

  function renderCommandPalette() {
    const cmds = getFilteredCmds()
    if (cmds.length === 0) return null
    return h('div', { class: 'ccm-cmd-palette' }, [
      h('div', { class: 'ccm-cmd-header' }, [
        h('span', null, 'Commands'),
        h('button', { class: 'ccm-cmd-close', onClick: () => { showCmdPalette.value = false } }, IconX(14)),
      ]),
      h('div', { class: 'ccm-cmd-list' },
        cmds.map((cmd, i) => h('div', {
          class: `ccm-cmd-item ${i === cmdSelectedIdx.value ? 'ccm-cmd-item-active' : ''}`,
          onClick: () => execCmd(cmd),
          onMouseenter: () => { cmdSelectedIdx.value = i },
        }, [
          h('span', { class: 'ccm-cmd-name' }, cmd.name),
          h('span', { class: 'ccm-cmd-desc' }, cmd.desc),
        ]))
      ),
    ])
  }

  // ===== Markdown rendering =====

  function renderMarkdown(content: string): any[] {
    if (!content) return [h('span', { class: 'ccm-muted' }, '(no content)')]
    // Strip Claude Code command tags
    const cleaned = content.replace(/<\/?command-(?:message|name)[^>]*>/g, '')
    const lines = cleaned.split('\n')
    const elements: any[] = []
    let inCode = false
    let codeLines: string[] = []
    let codeLang = ''
    let codeKey = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Code fence toggle
      if (line.startsWith('```')) {
        if (inCode) {
          elements.push(renderCodeBlock(codeLines.join('\n'), codeLang, codeKey++))
          codeLines = []
          codeLang = ''
          inCode = false
        } else {
          inCode = true
          codeLang = line.slice(3).trim()
        }
        continue
      }

      if (inCode) {
        codeLines.push(line)
        continue
      }

      // GFM table: a header row `| … |` followed by a `|---|---|` separator row
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const splitRow = (r: string) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
        const headers = splitRow(line)
        const aligns = splitRow(lines[i + 1]).map(c => { const l = c.startsWith(':'), r = c.endsWith(':'); return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '' })
        const rows: string[][] = []
        let j = i + 2
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(splitRow(lines[j])); j++ }
        elements.push(h('table', { class: 'ccm-md-table', key: i, style: 'border-collapse:collapse;width:100%;margin:6px 0;font-size:13px' }, [
          h('thead', null, h('tr', null, headers.map((hd, k) => h('th', { key: k, style: `border:1px solid var(--border-color,rgba(127,127,127,.3));padding:3px 8px;text-align:${aligns[k] || 'left'};font-weight:600` }, renderInline(hd))))),
          h('tbody', null, rows.map((row, ri) => h('tr', { key: ri }, headers.map((_, k) => h('td', { key: k, style: `border:1px solid var(--border-color,rgba(127,127,127,.2));padding:3px 8px;text-align:${aligns[k] || 'left'}` }, renderInline(row[k] || '')))))),
        ]))
        i = j - 1
        continue
      }

      // Block-level elements
      if (line.startsWith('# ')) {
        elements.push(h('h1', { class: 'ccm-md-h1', key: i }, renderInline(line.slice(2))))
      } else if (line.startsWith('## ')) {
        elements.push(h('h2', { class: 'ccm-md-h2', key: i }, renderInline(line.slice(3))))
      } else if (line.startsWith('### ')) {
        elements.push(h('h3', { class: 'ccm-md-h3', key: i }, renderInline(line.slice(4))))
      } else if (line.startsWith('> ')) {
        elements.push(h('blockquote', { class: 'ccm-md-quote', key: i }, renderInline(line.slice(2))))
      } else if (/^[-*]\s/.test(line)) {
        elements.push(h('div', { class: 'ccm-md-li', key: i }, renderInline(line.replace(/^[-*]\s/, ''))))
      } else if (/^\d+\.\s/.test(line)) {
        elements.push(h('div', { class: 'ccm-md-li ccm-md-oli', key: i }, renderInline(line.replace(/^\d+\.\s/, ''))))
      } else if (line === '---' || line === '***') {
        elements.push(h('hr', { class: 'ccm-md-hr', key: i }))
      } else if (line.trim() === '') {
        // Skip blank lines — spacing is handled by CSS
      } else {
        elements.push(h('p', { class: 'ccm-md-p', key: i }, renderInline(line)))
      }
    }

    if (inCode && codeLines.length > 0) {
      elements.push(renderCodeBlock(codeLines.join('\n'), codeLang, codeKey))
    }

    return elements.length > 0 ? elements : [h('span', { class: 'ccm-muted' }, '(empty)')]
  }

  function renderCodeBlock(code: string, lang: string, key: number) {
    const codeId = `code-${key}-${Date.now()}`
    return h('div', { class: 'ccm-code-block', key: `code-${key}` }, [
      h('div', { class: 'ccm-code-toolbar' }, [
        h('span', { class: 'ccm-code-lang' }, lang || 'code'),
        h('button', {
          class: 'ccm-code-copy',
          onClick: (e: Event) => {
            const btn = e.target as HTMLElement
            navigator.clipboard.writeText(code).then(() => {
              btn.textContent = '✓'
              setTimeout(() => { btn.textContent = 'Copy' }, 1500)
            }).catch(() => {})
          },
        }, 'Copy'),
      ]),
      h('pre', { class: 'ccm-code-pre' }, [
        h('code', { class: lang ? `language-${lang}` : '' }, code),
      ]),
    ])
  }

  function renderInline(text: string): any[] {
    const parts: any[] = []
    let remaining = text
    let keyCounter = 0

    while (remaining.length > 0) {
      // Inline code `...`
      const codeMatch = remaining.match(/`([^`]+)`/)
      // Bold **...**
      const boldMatch = remaining.match(/\*\*([^*]+)\*\*/)
      // Italic *...*
      const italicMatch = remaining.match(/(?<!\*)\*([^*]+)\*(?!\*)/)
      // Link [text](url)
      const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/)

      const candidates = [
        codeMatch ? { type: 'code', idx: codeMatch.index!, m: codeMatch } : null,
        boldMatch ? { type: 'bold', idx: boldMatch.index!, m: boldMatch } : null,
        italicMatch ? { type: 'italic', idx: italicMatch.index!, m: italicMatch } : null,
        linkMatch ? { type: 'link', idx: linkMatch.index!, m: linkMatch } : null,
      ].filter(Boolean) as { type: string; idx: number; m: RegExpMatchArray }[]

      if (candidates.length === 0) {
        parts.push(remaining)
        break
      }

      candidates.sort((a, b) => a.idx - b.idx)
      const first = candidates[0]

      if (first.idx > 0) parts.push(remaining.slice(0, first.idx))

      const k = keyCounter++
      if (first.type === 'code') {
        parts.push(h('code', { class: 'ccm-inline-code', key: k }, first.m[1]))
        remaining = remaining.slice(first.idx + first.m[0].length)
      } else if (first.type === 'bold') {
        parts.push(h('strong', { key: k }, first.m[1]))
        remaining = remaining.slice(first.idx + first.m[0].length)
      } else if (first.type === 'italic') {
        parts.push(h('em', { key: k }, first.m[1]))
        remaining = remaining.slice(first.idx + first.m[0].length)
      } else if (first.type === 'link') {
        parts.push(h('a', { class: 'ccm-link', href: first.m[2], target: '_blank', rel: 'noopener', key: k }, first.m[1]))
        remaining = remaining.slice(first.idx + first.m[0].length)
      }
    }

    return parts
  }

  // ===== Main render =====

  return {
    component: {
      setup() {
        ctx.onMounted(() => {
          console.log('[agents-view] onMounted called')
          loadFavorites()
          loadSettings().then(() => { loadRecentSessions(); loadProjects(); loadModels() })
          // Pre-load skills for slash command palette
          listSkills(exec).then(s => { skillsList.value = s }).catch(() => {})
          document.addEventListener('keydown', handleGlobalKeydown)
        })
        return {}
      },
      render() {
        return h('div', { class: 'ccm-root' }, [
          renderHeader(),
          h('div', { class: 'ccm-main' }, [
            sidebarOpen.value ? renderSidebar() : null,
            h('div', { class: 'ccm-content' }, [
              view.value === 'browse' ? renderBrowseView() : renderChat(),
            ]),
            (view.value === 'chat' && changesPanelOpen.value && fileChanges.value.length > 0)
              ? renderChangesPanel()
              : null,
          ]),
          renderStatusBar(),
          showProjectPicker.value ? renderProjectPicker() : null,
          showSkillsPanel.value ? renderSkillsPanel() : null,
          showSettings.value ? renderSettings() : null,
        ])
      },
    },
  }

  function renderSettings() {
    const field = (label: string, key: 'claudeConfigDir' | 'codexHome' | 'claudeBin' | 'codexBin', placeholder: string) =>
      h('div', { style: 'margin-bottom:12px' }, [
        h('label', { style: 'display:block;font-size:12px;opacity:.7;margin-bottom:4px' }, label),
        h('input', {
          type: 'text', class: 'ccm-browse-search-input', style: 'width:100%', value: settings.value[key], placeholder,
          onInput: (e: Event) => { settings.value = { ...settings.value, [key]: (e.target as HTMLInputElement).value } },
        }),
      ])
    const section = (title: string, children: any[]) =>
      h('div', { style: 'margin-bottom:18px' }, [
        h('div', { style: 'font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.55;margin-bottom:8px' }, title),
        ...children,
      ])
    return h('div', { class: 'ccm-picker-overlay' }, [
      h('div', { class: 'ccm-picker-backdrop', onClick: () => { showSettings.value = false } }),
      h('div', { class: 'ccm-picker-panel', style: 'max-height:82vh;display:flex;flex-direction:column' }, [
        h('div', { class: 'ccm-picker-header' }, [
          h('span', { class: 'ccm-picker-title' }, 'Settings'),
          h('button', { class: 'ccm-icon-btn ccm-icon-btn-sm', onClick: () => { showSettings.value = false } }, IconX(14)),
        ]),
        h('div', { style: 'padding:14px;overflow:auto;flex:1 1 auto' }, [
          section('Claude Code', [
            field('Config dir (CLAUDE_CONFIG_DIR)', 'claudeConfigDir', '~/.claude'),
            field('Binary (CLAUDE_BIN)', 'claudeBin', 'auto-detect if empty'),
          ]),
          section('Codex', [
            field('Home (CODEX_HOME)', 'codexHome', '~/.codex'),
            field('Binary (CODEX_BIN)', 'codexBin', 'auto-detect if empty'),
          ]),
          h('div', { style: 'font-size:11px;opacity:.55;line-height:1.5' },
            'Prefilled with the values currently in use. Reading another user’s dir (e.g. /root/.claude) requires the dinotty process to have read access — run dinotty as that user, or grant an ACL.'),
        ]),
        h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border-color,rgba(255,255,255,.08));flex:0 0 auto' }, [
          h('button', { class: 'ccm-icon-btn', onClick: () => { showSettings.value = false } }, 'Cancel'),
          h('button', { class: 'ccm-primary-btn ccm-primary-btn-sm', onClick: () => saveSettings() }, 'Save & Refresh'),
        ]),
      ]),
    ])
  }

  function renderBrowseView() {
    const filtered = sortSessionsByFav(getFilteredSessions())
    return h('div', { class: 'ccm-browse' }, [
      // Header bar (Claudix SessionsPage style)
      h('div', { class: 'ccm-browse-header' }, [
        h('div', { class: 'ccm-browse-header-left' }, [
          h('span', { class: 'ccm-browse-title' }, 'Sessions'),
        ]),
        h('div', { class: 'ccm-browse-header-right' }, [
          h('button', {
            class: `ccm-icon-btn ${browseSearchOpen.value ? 'ccm-icon-btn-active' : ''}`,
            onClick: () => { browseSearchOpen.value = !browseSearchOpen.value; if (!browseSearchOpen.value) browseSearch.value = '' },
            title: 'Search sessions',
          }, IconSearch(15)),
          h('button', {
            class: 'ccm-icon-btn',
            onClick: () => loadRecentSessions(),
            title: 'Refresh',
          }, IconRefresh(15)),
          h('button', {
            class: 'ccm-primary-btn ccm-primary-btn-sm',
            onClick: startNewChat,
          }, '+ New'),
        ]),
      ]),
      // Search bar (collapsible, like Claudix)
      browseSearchOpen.value ? h('div', { class: 'ccm-browse-search' }, [
        h('input', {
          type: 'text',
          class: 'ccm-browse-search-input',
          placeholder: 'Search sessions...',
          value: browseSearch.value,
          onInput: (e: Event) => { browseSearch.value = (e.target as HTMLInputElement).value },
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { browseSearchOpen.value = false; browseSearch.value = '' } },
        }),
      ]) : null,
      // Content
      h('div', { class: 'ccm-browse-content' }, [
        // Loading state
        loading.value ? h('div', { class: 'ccm-browse-state' }, [
          h('div', { class: 'ccm-spinner' }),
          h('span', null, 'Loading sessions...'),
        ]) : null,
        // Error state
        !loading.value && error.value ? h('div', { class: 'ccm-browse-state' }, [
          h('span', { class: 'ccm-browse-error' }, error.value),
          h('button', {
            class: 'ccm-primary-btn ccm-primary-btn-sm',
            onClick: () => { error.value = null; loadRecentSessions() },
          }, 'Retry'),
        ]) : null,
        // Empty state
        !loading.value && !error.value && filtered.length === 0
          ? h('div', { class: 'ccm-browse-state' }, [
              h('div', { class: 'ccm-browse-empty-icon' }, IconClaude(48)),
              h('span', null, browseSearch.value ? 'No matching sessions' : 'No sessions yet'),
              !browseSearch.value ? h('button', {
                class: 'ccm-primary-btn',
                onClick: startNewChat,
              }, 'Start a conversation') : null,
            ].filter(Boolean))
          : null,
        // Session cards
        !loading.value && !error.value && filtered.length > 0
          ? h('div', { class: 'ccm-browse-sessions' },
              filtered.map(s => renderSessionCard(s))
            )
          : null,
      ]),
    ])
  }

  function renderSessionCard(s: Session) {
    // Keep the card's native layout (header row + meta row stacked); overlay the
    // star at the right-center via absolute positioning, with right padding so
    // content doesn't run under it.
    return h('div', {
      class: 'ccm-session-card',
      style: 'position:relative;padding-right:30px',
      onClick: () => openSession(s),
    }, [
      h('div', { class: 'ccm-session-card-header' }, [
        h('span', { class: 'ccm-session-card-title' }, (s.name || s.firstPrompt || '').slice(0, 80) || '(empty)'),
        h('span', { class: 'ccm-session-card-time' }, formatTime(s.lastTimestamp)),
      ]),
      h('div', { class: 'ccm-session-card-meta' }, [
        srcBadge(s.source),
        h('span', { class: 'ccm-session-card-count' }, `${s.messageCount} messages`),
        h('span', { class: 'ccm-tag' }, s.project.split('/').pop() || s.project),
        s.gitBranch ? h('span', { class: 'ccm-tag' }, s.gitBranch) : null,
      ].filter(Boolean)),
      h('span', { style: 'position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;align-items:center' },
        starBtn(favSessions.value.has(s.id), () => toggleFavSession(s.id))),
    ])
  }

  // ===== Project Path Picker =====

  function renderProjectPicker() {
    const dir = pickerCurrentDir.value
    const entries = pickerEntries.value
    const detected = currentCwd.value

    // Breadcrumb segments
    const segments = dir.split('/').filter(Boolean)
    const breadcrumbs: any[] = [
      h('span', {
        class: 'ccm-picker-crumb',
        onClick: () => navigatePickerDir('/'),
      }, '/'),
    ]
    let accumulated = ''
    for (const seg of segments) {
      accumulated += '/' + seg
      const path = accumulated
      breadcrumbs.push(h('span', { class: 'ccm-picker-crumb-sep' }, '/'))
      breadcrumbs.push(h('span', {
        class: 'ccm-picker-crumb',
        onClick: () => navigatePickerDir(path),
      }, seg))
    }

    return h('div', { class: 'ccm-picker-overlay' }, [
      h('div', { class: 'ccm-picker-backdrop', onClick: () => { showProjectPicker.value = false } }),
      h('div', { class: 'ccm-picker-panel' }, [
        h('div', { class: 'ccm-picker-header' }, [
          h('span', { class: 'ccm-picker-title' }, 'Select Project Directory'),
          h('button', {
            class: 'ccm-icon-btn ccm-icon-btn-sm',
            onClick: () => { showProjectPicker.value = false },
          }, IconX(14)),
        ]),
        // Breadcrumb
        h('div', { class: 'ccm-picker-breadcrumb' }, breadcrumbs),
        // Current CWD indicator
        detected ? h('div', { class: 'ccm-picker-current' }, [
          IconFolder(14),
          h('span', null, `Current: ${detected}`),
        ]) : null,
        // Select current directory button
        h('div', { class: 'ccm-picker-actions' }, [
          h('button', {
            class: 'ccm-picker-action-btn',
            onClick: () => selectProjectPath(dir),
          }, [
            IconCheck(14),
            h('span', null, `Select "${dir.split('/').pop() || '/'}"`),
          ]),
        ]),
        // Directory list
        h('div', { class: 'ccm-picker-list' },
          pickerLoading.value
            ? h('div', { class: 'ccm-picker-empty' }, [
                h('span', { class: 'ccm-spinner' }),
              ])
            : entries.length > 0
              ? entries.map(entry => h('div', {
                  class: 'ccm-picker-item',
                  onClick: () => navigatePickerDir(entry.path),
                }, [
                  IconFolder(14),
                  h('div', { class: 'ccm-picker-item-info' }, [
                    h('span', { class: 'ccm-picker-item-name' }, entry.name),
                    h('span', { class: 'ccm-picker-item-path' }, entry.path),
                  ]),
                  IconChevronRight(14),
                ]))
              : h('div', { class: 'ccm-picker-empty' }, 'No subdirectories')
        ),
      ]),
    ])
  }

  function renderSkillsPanel() {
    const selected = skillsList.value.find(s => s.id === selectedSkillId.value)
    return h('div', { class: 'ccm-skills-overlay' }, [
      h('div', { class: 'ccm-skills-backdrop', onClick: () => { showSkillsPanel.value = false; selectedSkillId.value = null } }),
      h('div', { class: 'ccm-skills-panel' }, [
        h('div', { class: 'ccm-skills-header' }, [
          h('div', { class: 'ccm-skills-header-left' }, [
            selected ? h('button', {
              class: 'ccm-icon-btn ccm-icon-btn-sm',
              onClick: () => { selectedSkillId.value = null },
              title: 'Back to list',
            }, IconArrowLeft(14)) : null,
            h('span', { class: 'ccm-skills-title' }, selected ? selected.name : 'Skills'),
          ]),
          h('button', {
            class: 'ccm-icon-btn ccm-icon-btn-sm',
            onClick: () => { showSkillsPanel.value = false; selectedSkillId.value = null },
          }, IconX(14)),
        ]),
        selected ? renderSkillDetail(selected) : renderSkillsList(),
      ]),
    ])
  }

  function renderSkillsList() {
    if (skillsList.value.length === 0) {
      return h('div', { class: 'ccm-skills-empty' }, 'No skills installed')
    }
    return h('div', { class: 'ccm-skills-list' },
      skillsList.value.map(skill => h('div', {
        class: 'ccm-skill-card',
        onClick: () => { selectedSkillId.value = skill.id },
      }, [
        h('div', { class: 'ccm-skill-card-header' }, [
          h('span', { class: 'ccm-skill-icon' }, IconZap(14)),
          h('span', { class: 'ccm-skill-name' }, skill.name),
        ]),
        h('div', { class: 'ccm-skill-desc' }, skill.description || 'No description'),
        skill.allowedTools.length > 0 ? h('div', { class: 'ccm-skill-tools' },
          skill.allowedTools.map(t => h('span', { class: 'ccm-skill-tool-tag' }, t))
        ) : null,
      ]))
    )
  }

  function renderSkillDetail(skill: { id: string; name: string; description: string; allowedTools: string[] }) {
    return h('div', { class: 'ccm-skill-detail' }, [
      h('div', { class: 'ccm-skill-detail-desc' }, skill.description || 'No description'),
      skill.allowedTools.length > 0 ? h('div', { class: 'ccm-skill-detail-section' }, [
        h('div', { class: 'ccm-skill-detail-label' }, 'Allowed Tools'),
        h('div', { class: 'ccm-skill-tools' },
          skill.allowedTools.map(t => h('span', { class: 'ccm-skill-tool-tag' }, t))
        ),
      ]) : null,
      h('div', { class: 'ccm-skill-detail-actions' }, [
        h('button', {
          class: 'ccm-primary-btn',
          onClick: () => useSkill(skill),
        }, 'Use in Chat'),
      ]),
    ])
  }
}
