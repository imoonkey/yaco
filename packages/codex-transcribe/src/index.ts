import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TRANSCRIBE_ENDPOINT = 'https://chatgpt.com/backend-api/transcribe'
const ACCOUNT_ID_CLAIM =
  'https://api.openai.com/auth.chatgpt_account_id'

export type CodexTranscribeStatus =
  | { readonly available: true }
  | {
      readonly available: false
      readonly reason:
        | 'missing_auth'
        | 'unsupported_auth'
        | 'invalid_auth'
        | 'expired_auth'
    }

export type CodexTranscribeInput = {
  readonly audio: Uint8Array<ArrayBuffer>
  readonly filename: string
  readonly mimeType: string
  readonly language?: string
  readonly signal?: AbortSignal
}

export type CodexTranscribeErrorCode =
  | 'not_configured'
  | 'expired_auth'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream'
  | 'network'

type Credentials = {
  readonly accessToken: string
  readonly accountId: string
}

type CredentialsResult =
  | { readonly credentials: Credentials }
  | { readonly reason: Exclude<CodexTranscribeStatus, { available: true }>['reason'] }

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

async function readCredentials(): Promise<CredentialsResult> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  let raw: string
  try {
    raw = await readFile(join(codexHome, 'auth.json'), 'utf8')
  } catch (error) {
    return { reason: isMissingFile(error) ? 'missing_auth' : 'invalid_auth' }
  }

  let auth: unknown
  try {
    auth = JSON.parse(raw)
  } catch {
    return { reason: 'invalid_auth' }
  }
  if (!isRecord(auth) || typeof auth.auth_mode !== 'string') {
    return { reason: 'invalid_auth' }
  }
  if (auth.auth_mode !== 'chatgpt') {
    return { reason: 'unsupported_auth' }
  }
  if (!isRecord(auth.tokens)) return { reason: 'invalid_auth' }

  const accessToken = nonEmptyString(auth.tokens.access_token)
  if (accessToken === undefined) return { reason: 'invalid_auth' }

  const payload = parseJwtPayload(accessToken)
  if (
    payload === undefined ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp)
  ) {
    return { reason: 'invalid_auth' }
  }
  const accountId =
    nonEmptyString(auth.tokens.account_id) ??
    nonEmptyString(payload[ACCOUNT_ID_CLAIM])
  if (accountId === undefined) return { reason: 'invalid_auth' }
  if (payload.exp * 1_000 <= Date.now()) {
    return { reason: 'expired_auth' }
  }

  return { credentials: { accessToken, accountId } }
}

function parseJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    )
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { readonly code?: unknown }).code === 'ENOENT'
  )
}

function platformName(): string {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return process.platform
}
