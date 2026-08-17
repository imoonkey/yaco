import { readCredentials } from './auth.js'
import type { CodexTranscribeStatus } from './auth.js'
import { CodexTranscribeError } from './errors.js'
import { isRecord } from './json.js'

const TRANSCRIBE_ENDPOINT = 'https://chatgpt.com/backend-api/transcribe'

export type { CodexTranscribeStatus } from './auth.js'
export {
  openCodexDictationSession,
  type CodexDictationSession,
  type CodexDictationSessionInput,
} from './dictation.js'
export {
  CodexTranscribeError,
  type CodexTranscribeErrorCode,
} from './errors.js'

export type CodexTranscribeInput = {
  readonly audio: Uint8Array<ArrayBuffer>
  readonly filename: string
  readonly mimeType: string
  readonly language?: string
  readonly signal?: AbortSignal
}

export async function inspectCodexTranscribe(): Promise<CodexTranscribeStatus> {
  const result = await readCredentials()
  return 'credentials' in result
    ? { available: true }
    : { available: false, reason: result.reason }
}

export async function transcribeCodex(
  input: CodexTranscribeInput,
): Promise<string> {
  const auth = await readCredentials()
  if (!('credentials' in auth)) {
    throw new CodexTranscribeError(
      auth.reason === 'expired_auth' ? 'expired_auth' : 'not_configured',
    )
  }

  const form = new FormData()
  form.append(
    'file',
    new Blob([input.audio], { type: input.mimeType }),
    input.filename,
  )
  if (input.language !== undefined) form.append('language', input.language)

  let response: Response
  try {
    response = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.credentials.accessToken}`,
        'ChatGPT-Account-Id': auth.credentials.accountId,
        originator: 'Codex Desktop',
        'User-Agent': `Codex Desktop/0.0.0 (${platformName()}; ${process.arch})`,
        Accept: 'application/json',
      },
      body: form,
      signal: input.signal,
    })
  } catch (cause) {
    throw new CodexTranscribeError('network', { cause })
  }

  if (response.status === 401) {
    throw new CodexTranscribeError('expired_auth')
  }
  if (response.status === 403) {
    throw new CodexTranscribeError('forbidden')
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') ?? undefined
    throw new CodexTranscribeError('rate_limited', { retryAfter })
  }
  if (!response.ok) {
    throw new CodexTranscribeError('upstream')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CodexTranscribeError('upstream')
  }
  if (!isRecord(body) || typeof body.text !== 'string') {
    throw new CodexTranscribeError('upstream')
  }
  return body.text
}

function platformName(): string {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return process.platform
}
