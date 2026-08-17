export type CodexTranscribeErrorCode =
  | 'not_configured'
  | 'expired_auth'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'aborted'
  | 'timeout'
  | 'protocol'

export class CodexTranscribeError extends Error {
  readonly code: CodexTranscribeErrorCode
  readonly retryAfter?: string

  constructor(
    code: CodexTranscribeErrorCode,
    options: { readonly retryAfter?: string; readonly cause?: unknown } = {},
  ) {
    super(`Codex transcription failed: ${code}`, { cause: options.cause })
    this.name = 'CodexTranscribeError'
    this.code = code
    this.retryAfter = options.retryAfter
  }
}
