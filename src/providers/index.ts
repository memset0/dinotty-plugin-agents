import type { Project, Session, SearchResult, AgentSource } from '../types'
import { type AgentProvider } from './base'
import { ClaudeProvider } from './claude'

export * from './base'

let _providers: AgentProvider[] | null = null

/** Registry of agent backends. Add new agents (Codex, opencode) here. */
export function getProviders(): AgentProvider[] {
  if (!_providers) _providers = [new ClaudeProvider() /* , new CodexProvider() — Phase 1 next */]
  return _providers
}

export function getProvider(source: string): AgentProvider | undefined {
  return getProviders().find(p => p.source === source)
}

function ts(s: string): number { return s ? new Date(s).getTime() : 0 }

/** Recent sessions merged across all available agents, newest first. */
export function aggregateRecent(limit: number): Session[] {
  const all = getProviders().filter(p => p.available()).flatMap(p => {
    try { return p.listRecent(limit) } catch { return [] }
  })
  return all.sort((a, b) => ts(b.lastTimestamp) - ts(a.lastTimestamp)).slice(0, limit)
}

/** Projects merged by absolute cwd; a project that exists for multiple agents collapses into one (`sources`). */
export function aggregateProjects(): Project[] {
  const map = new Map<string, Project>()
  for (const p of getProviders().filter(p => p.available())) {
    let list: Project[] = []
    try { list = p.listProjects() } catch { list = [] }
    for (const proj of list) {
      const ex = map.get(proj.path)
      if (ex) {
        ex.sessionCount += proj.sessionCount
        ex.sources = Array.from(new Set([...(ex.sources || []), ...(proj.source ? [proj.source] : [])])) as AgentSource[]
      } else {
        map.set(proj.path, { ...proj, sources: proj.source ? [proj.source] : [] })
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.sessionCount - a.sessionCount)
}

/** Search merged across all available agents, capped at `limit`. */
export function aggregateSearch(query: string, limit: number): SearchResult[] {
  const out: SearchResult[] = []
  for (const p of getProviders().filter(p => p.available())) {
    if (out.length >= limit) break
    try { out.push(...p.search(query, limit - out.length)) } catch { /* skip */ }
  }
  return out.slice(0, limit)
}
