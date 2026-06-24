type ExecFn = (args: string[], options?: { timeout?: number; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>

export interface SendResult { sessionId: string; response: string; costUsd: number }

/**
 * Generic blocking send for any agent (`agent-call <source> --new|--resume <id> <prompt>`).
 * For a new chat pass `sessionId: ''` — claude mints a UUID, codex returns the id it minted.
 */
export async function sendAgent(
  exec: ExecFn,
  source: string,
  mode: 'new' | 'resume',
  sessionId: string,
  prompt: string,
  options?: { cwd?: string; model?: string; effort?: string; permission?: string }
): Promise<SendResult> {
  const flag = mode === 'new' ? '--new' : '--resume'
  const res = await exec(['agent-call', source, flag, sessionId || '', options?.model || '', options?.effort || '', options?.permission || '', prompt], { timeout: 600_000, cwd: options?.cwd })
  if (res.code !== 0) throw new Error(res.stderr || `${source} exited with code ${res.code}`)
  try {
    const data = JSON.parse(res.stdout)
    return { sessionId: data.sessionId || sessionId, response: data.response || '', costUsd: data.costUsd || 0 }
  } catch {
    return { sessionId, response: res.stdout.trim(), costUsd: 0 }
  }
}

// Back-compat thin wrappers (Claude). New code should call sendAgent with an explicit source.
export async function createConversation(exec: ExecFn, prompt: string, options?: { cwd?: string }): Promise<SendResult> {
  return sendAgent(exec, 'claude-code', 'new', '', prompt, options)
}

export async function continueConversation(exec: ExecFn, sessionId: string, prompt: string, options?: { cwd?: string }): Promise<{ response: string; costUsd: number }> {
  const r = await sendAgent(exec, 'claude-code', 'resume', sessionId, prompt, options)
  return { response: r.response, costUsd: r.costUsd }
}
