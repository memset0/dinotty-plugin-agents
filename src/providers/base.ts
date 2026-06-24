import * as os from 'os'
import * as path from 'path'
import type { Project, Session, Message, SearchResult, AgentSource, ToolUse } from '../types'

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

/** Send a turn: either start a new conversation or resume an existing one. */
export type SendMode = 'new' | 'resume'

export interface SendOpts {
  mode: SendMode
  /** Required for resume; for new, claude may use a caller-supplied id while codex mints its own. */
  sessionId?: string
  prompt: string
  /** Working directory for the turn (new: project root; resume: the session's project dir). */
  cwd?: string
  /** Optional model override; omit to use the agent's configured default / the session's model. */
  model?: string
  /** Optional reasoning effort (Codex: low|medium|high|xhigh); omit to use the model/session default. */
  effort?: string
  /** Optional permission/sandbox (Codex: read-only|workspace-write|danger-full-access). */
  sandbox?: string
}

export interface SendResult {
  sessionId: string
  response: string
  costUsd: number
}

/** Normalized streaming callbacks; each provider maps its own stream onto these. */
export interface StreamCallbacks {
  /** Append a chunk of assistant text (item-level for codex, may be token-level for claude). */
  onDelta(text: string): void
  /** Upserted by `tool.callId`: emit on tool start, again on completion to fill output. */
  onToolUse(tool: ToolUse): void
  /** The session id became known (new chats mint it mid-stream). */
  onSession(sessionId: string): void
  /** Stream finished cleanly. */
  onDone(result: { sessionId: string; costUsd: number }): void
  /** Stream errored. */
  onError(message: string): void
}

/** Handle over an in-flight streamed turn (lives on the CLI/Node side). */
export interface StreamHandle {
  /** Resolves when the underlying agent process exits (after onDone/onError fired). */
  wait(): Promise<void>
  /** Kill the underlying agent process (real cancel for the Stop button). */
  kill(): void
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
  /** Headless blocking send (the floor — always available). */
  send(opts: SendOpts): Promise<SendResult>
  /** Streaming send; returns null when this agent has no usable stream mode (UI falls back to `send`). */
  sendStreaming(opts: SendOpts, cbs: StreamCallbacks): StreamHandle | null
}
