import { spawn } from 'node:child_process'
import { Hono } from 'hono'
import { fail } from '../lib/response'
import { buildChildProcessEnv } from '../lib/ssh-auth'
import { YACO_AGENT_USAGE_TIMEOUT_MS, YACO_PATH } from '../lib/constants'

type StatusCode = 400 | 404 | 409 | 429 | 500

interface CliFailure {
  code: string
  message: string
  details?: unknown
}

class CliEnvelopeError extends Error {
  code: string
  details?: unknown

  constructor(error: CliFailure) {
    super(error.message)
    this.name = 'CliEnvelopeError'
    this.code = error.code
    this.details = error.details
  }
}

interface UsageError {
  code: string
  message: string
}

interface UsageWindow {
  window: string
  scope?: string
  percent: number
  resetsAt?: string
}

interface ProviderUsage {
  provider: string
  plan?: string
  checkedAt: string
  windows: UsageWindow[]
  error?: UsageError
}

interface RawCliEnvelope {
  ok: boolean
  data?: unknown
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
}

function parseYacoEnvelope(raw: string): unknown {
  const parsed = JSON.parse(raw) as RawCliEnvelope
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`unexpected yaco agent usage output: ${raw.slice(0, 200)}`)
  }
  if (!('ok' in parsed)) {
    throw new Error(`unexpected yaco agent usage output: ${raw.slice(0, 200)}`)
  }
  if (parsed.ok === false) {
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : 'INTERNAL'
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : 'yaco agent usage failed'
    throw new CliEnvelopeError({ code, message, details: parsed.error?.details })
  }
  if (parsed.ok !== true || !('data' in parsed)) {
    throw new Error(`unexpected yaco agent usage output: ${raw.slice(0, 200)}`)
  }
  return parsed.data
}

function parseFailureEnvelope(raw: string): CliFailure | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as RawCliEnvelope
    if (!parsed || typeof parsed !== 'object' || parsed.ok !== false) return null
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : undefined
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : undefined
    if (!code || !message) return null
    return { code, message, details: parsed.error?.details }
  } catch {
    return null
  }
}

function isCliFailure(error: unknown): CliFailure | null {
  if (error instanceof CliEnvelopeError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return null
}

async function runYacoAgentJson(args: string[]): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn(YACO_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildProcessEnv(),
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('yaco agent usage command timed out'))
    }, YACO_AGENT_USAGE_TIMEOUT_MS)

    proc.stdout.on('data', (chunk) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk) => { err += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(out)
        return
      }
      const failure = parseFailureEnvelope(err)
      if (failure) {
        reject(new CliEnvelopeError(failure))
        return
      }
      reject(new Error(`yaco agent usage command failed [${code ?? 'unknown'}]: ${err || 'process exited with no output'}`))
    })

    proc.on('error', (procErr) => {
      clearTimeout(timer)
      reject(procErr)
    })
  })

  return parseYacoEnvelope(raw)
}

function failFromCli(c: Parameters<typeof fail>[0], error: { code: string, message: string }): ReturnType<typeof fail> {
  const statusByCode: Record<string, StatusCode> = {
    USAGE: 400,
    INVALID: 400,
    NOT_FOUND: 404,
    CONFLICT: 409,
    LOCK: 409,
    RATE_LIMIT: 429,
  }
  const status = statusByCode[error.code] ?? 500
  return fail(c, status, error.message)
}

function isUsagePayload(payload: unknown): payload is ProviderUsage[] {
  if (!Array.isArray(payload)) return false
  return payload.every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const usage = entry as Record<string, unknown>
    const provider = typeof usage.provider === 'string'
    const checkedAt = typeof usage.checkedAt === 'string'
    const windows = Array.isArray(usage.windows) ? usage.windows : null
    const hasWindows = windows?.every((window) => {
      if (!window || typeof window !== 'object') return false
      const detail = window as Record<string, unknown>
      const windowName = typeof detail.window === 'string' && detail.window.trim() !== ''
      const isPercent =
        typeof detail.percent === 'number'
        && Number.isFinite(detail.percent)
        && detail.percent >= 0
      return windowName && isPercent
    }) ?? false
    const hasError = usage.error === undefined
      || (typeof usage.error === 'object'
        && usage.error !== null
        && typeof (usage.error as { code?: unknown }).code === 'string'
        && typeof (usage.error as { message?: unknown }).message === 'string')
    if (!provider || !checkedAt || windows === null || !hasWindows) return false
    return hasError
  })
}

const app = new Hono()

app.get('/', async (c) => {
  const args = ['agent', 'usage', '--json']
  try {
    const payload = await runYacoAgentJson(args)
    if (!isUsagePayload(payload)) {
      return fail(c, 500, 'invalid yaco agent usage payload')
    }
    return c.json(payload)
  } catch (error) {
    const parsed = isCliFailure(error)
    if (parsed) {
      return failFromCli(c, parsed)
    }
    const message = error instanceof Error ? error.message : `HTTP route error: ${String(error)}`
    return fail(c, 500, message)
  }
})

app.post('/refresh', async (c) => {
  const args = ['agent', 'usage', '--fresh', '--json']
  try {
    const payload = await runYacoAgentJson(args)
    if (!isUsagePayload(payload)) {
      return fail(c, 500, 'invalid yaco agent usage payload')
    }
    return c.json(payload)
  } catch (error) {
    const parsed = isCliFailure(error)
    if (parsed) {
      return failFromCli(c, parsed)
    }
    const message = error instanceof Error ? error.message : `HTTP route error: ${String(error)}`
    return fail(c, 500, message)
  }
})

export const usageRoutes = app
