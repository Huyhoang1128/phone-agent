/**
 * sseChat.ts
 * ==========
 * SSE (Server-Sent Events) chat service for communicating with the agent_teams
 * service. Uses XMLHttpRequest + a 100 ms polling interval so that streaming
 * responses are read incrementally even in environments (like React Native) that
 * do not support the native EventSource API.
 *
 * Usage:
 *   const svc = new SSEChatService()
 *   svc.onEvent(handler)
 *   svc.onError(handler)
 *   svc.onComplete(handler)
 *   svc.sendMessage({ url, message, token, userId, sessionId })
 *   // later:
 *   svc.close()
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEEvent {
  event: string
  run_id?: string
  session_id?: string
  content?: string
  [key: string]: unknown
}

export interface SSEChatOptions {
  /** Full URL of the agent/team/workflow runs endpoint. */
  url: string
  /** The user's message / prompt. */
  message: string
  /** JWT Bearer token (without the "Bearer " prefix). */
  token: string
  /** Agno user_id to pass in the form body. */
  userId?: string
  /** Agno session_id to pass in the form body. */
  sessionId?: string
  /** Optional model override sent to AgentOS. */
  model?: string
}

type EventHandler = (event: SSEEvent) => void
type ErrorHandler = (error: Error) => void
type CompleteHandler = () => void

// ---------------------------------------------------------------------------
// Event normalisation
// ---------------------------------------------------------------------------

/**
 * AgentOS can emit events with different prefixes depending on whether you are
 * talking to an agent, a team, or a workflow. Normalise all of them to Team*.
 *
 * Examples:
 *   RunStarted          → TeamRunStarted
 *   AgentRunStarted     → TeamRunStarted
 *   WorkflowRunStarted  → TeamRunStarted
 *   TeamRunContent      → TeamRunContent  (already normalised)
 */
function normalizeEventName(raw: string): string {
  // Already normalised
  if (raw.startsWith('Team')) return raw

  // Strip known prefixes so we always end up with Run* for run events
  const stripped = raw
    .replace(/^WorkflowRun/, 'Run')
    .replace(/^AgentRun/, 'Run')

  // Prefix with "TeamRun" for run events
  if (stripped.startsWith('Run')) {
    return `Team${stripped}`
  }

  // Other events (ToolCallStarted, ReasoningStarted, etc.) – keep as-is
  return raw
}

// ---------------------------------------------------------------------------
// SSEChatService
// ---------------------------------------------------------------------------

export class SSEChatService {
  private xhr: XMLHttpRequest | null = null
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private lastLength = 0

  private eventHandler: EventHandler | null = null
  private errorHandler: ErrorHandler | null = null
  private completeHandler: CompleteHandler | null = null

  // ── Callback registration ─────────────────────────────────────────────────

  onEvent(handler: EventHandler): this {
    this.eventHandler = handler
    return this
  }

  onError(handler: ErrorHandler): this {
    this.errorHandler = handler
    return this
  }

  onComplete(handler: CompleteHandler): this {
    this.completeHandler = handler
    return this
  }

  // ── Send a message ────────────────────────────────────────────────────────

  sendMessage(options: SSEChatOptions): void {
    // Close any existing connection first
    this.close()
    this.lastLength = 0

    const { url, message, token, userId, sessionId, model } = options

    // Build form-encoded body as per the AgentOS SSE spec
    const params = new URLSearchParams()
    params.set('message', message)
    params.set('stream', 'true')
    if (userId) params.set('user_id', userId)
    if (sessionId) params.set('session_id', sessionId)
    if (model) params.set('model', model)

    const xhr = new XMLHttpRequest()
    this.xhr = xhr

    xhr.open('POST', url, true)
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded')
    xhr.setRequestHeader('Accept', 'text/event-stream')
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    // Poll every 100 ms to read newly arrived response text
    this.pollInterval = setInterval(() => {
      const current = xhr.responseText
      if (current.length > this.lastLength) {
        const newData = current.slice(this.lastLength)
        this.lastLength = current.length
        this._processData(newData)
      }
    }, 100)

    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.DONE) return

      this._clearPoll()

      if (xhr.status === 429) {
        // Rate limit exceeded – parse the server's error payload
        try {
          const body = JSON.parse(xhr.responseText)
          this.errorHandler?.(
            new Error(body.message ?? `Rate limit exceeded (used ${body.used}/${body.limit})`)
          )
        } catch {
          this.errorHandler?.(new Error('Rate limit exceeded'))
        }
        return
      }

      if (xhr.status >= 400) {
        this.errorHandler?.(new Error(`Server error: HTTP ${xhr.status}`))
      }
    }

    xhr.onerror = () => {
      this._clearPoll()
      this.errorHandler?.(new Error('Network error – could not reach agent service'))
    }

    xhr.send(params.toString())
  }

  // ── Close / abort ─────────────────────────────────────────────────────────

  close(): void {
    this._clearPoll()
    if (this.xhr) {
      this.xhr.abort()
      this.xhr = null
    }
    this.lastLength = 0
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _clearPoll(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  /**
   * Parse a chunk of SSE text.
   * Each SSE event looks like:  data: <JSON>\n\n
   */
  private _processData(chunk: string): void {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const json = line.slice(6).trim()
      if (!json || json === '[DONE]') continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(json) as Record<string, unknown>
      } catch {
        continue // skip malformed lines
      }

      const rawEvent = String(parsed.event ?? '')
      const normalizedEvent = normalizeEventName(rawEvent)
      const sseEvent: SSEEvent = { ...parsed, event: normalizedEvent }

      this.eventHandler?.(sseEvent)

      // Terminal events – stop reading and invoke the complete callback
      if (normalizedEvent === 'TeamRunCompleted' || normalizedEvent === 'TeamRunError') {
        this._clearPoll()
        this.completeHandler?.()
        this.close()
        return
      }
    }
  }
}

// Export a default singleton for convenience (components can also instantiate
// their own instance if they need independent connections).
export const sseChatService = new SSEChatService()
