import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

export type Credentials = {
  readonly accessToken: string
  readonly accountId: string
}

export type CredentialsResult =
  | { readonly credentials: Credentials }
  | {
      readonly reason: Exclude<
        CodexTranscribeStatus,
        { available: true }
      >['reason']
    }

export async function readCredentials(): Promise<CredentialsResult> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
