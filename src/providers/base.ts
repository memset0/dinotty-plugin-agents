import * as os from 'os'
import * as path from 'path'
import type { Project, Session, Message, SearchResult, AgentSource } from '../types'

/** Expand a leading `~` to the running user's home. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * Resolve an agent's config/session directory.
 *
 * Precedence: env override (an arbitrary absolute path — the agent may live under
 * a different user's home, e.g. /root/.claude or /home/yulun/.codex) > default
 * under the running user's home. The UI forwards a user-set override by injecting
 * `envVar` into `ctx.exec.run`'s env. No path is hardcoded.
 */
export function resolveAgentDir(envVar: string, defaultRel: string): string {
  const env = process.env[envVar]
  if (env && env.trim()) return expandHome(env.trim())
  return path.join(os.homedir(), defaultRel)
}

/** One backend per agent. Read methods MUST degrade gracefully (empty, not throw) when unavailable. */
export interface AgentProvider {
  readonly source: AgentSource
  readonly configDir: string
  /** dir exists and is readable */
  available(): boolean
  listProjects(): Project[]
  listSessions(encodedPath: string): Session[]
  /** Sessions for a given project (absolute cwd) — lets the UI group both agents under one project. */
  listSessionsByProject(projectPath: string): Session[]
  readSession(encodedPath: string, id: string): Message[]
  search(query: string, limit: number): SearchResult[]
  listRecent(limit: number): Session[]
}
