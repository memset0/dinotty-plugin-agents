export type AgentSource = 'claude-code' | 'codex'

export interface Session {
  id: string
  project: string
  encodedPath: string
  firstPrompt: string
  lastTimestamp: string
  messageCount: number
  gitBranch?: string
  source: AgentSource
  /** Optional human name (Codex thread_name; Claude derives from firstPrompt). */
  name?: string
}

export interface Message {
  uuid: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  model?: string
  source?: AgentSource
  toolUses?: ToolUse[]
}

export interface ToolUse {
  name: string
  summary: string
  filePath?: string
  oldString?: string
  newString?: string
  content?: string
  replaceAll?: boolean
  /** Raw call arguments (e.g. Codex function_call.arguments JSON). */
  args?: string
  /** Tool result (e.g. Codex function_call_output, paired by callId). */
  output?: string
  /** Pairing id for call ↔ output (Codex). */
  callId?: string
}

export interface FileChange {
  filePath: string
  additions: number
  deletions: number
  toolType: 'Edit' | 'Write'
}

export interface Project {
  path: string
  encodedPath: string
  sessionCount: number
  /** Primary source when produced by one provider; `sources` is filled when aggregated across agents. */
  source?: AgentSource
  sources?: AgentSource[]
}

export interface SearchResult {
  session: Session
  match: string
}
