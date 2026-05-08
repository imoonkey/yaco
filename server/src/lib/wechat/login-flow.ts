import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { login as sdkLogin } from 'weixin-agent-sdk'
import { initWeChat, isInitialized } from './index'

export type LoginPhase = 'idle' | 'awaiting-qr' | 'awaiting-scan' | 'logged-in' | 'failed'

export interface LoginState {
  phase: LoginPhase
  /** Plain-text ASCII QR (block characters from qrcode-terminal). UI renders it
   *  in a monospace <pre> for the user to scan. */
  qrAscii?: string
  accountId?: string
  error?: string
  startedAt?: string
  updatedAt?: string
}

const WORKFLOW_DIR = join(homedir(), '.workflow')
const QR_FILE = join(WORKFLOW_DIR, 'wechat-qr.txt')

let state: LoginState = { phase: 'idle' }
let inflight: Promise<void> | null = null

export function getLoginState(): LoginState {
  return { ...state }
}

function setState(patch: Partial<LoginState>): void {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() }
}

/** True iff the string looks like a row of qrcode-terminal output (block chars). */
function isQrLine(s: string): boolean {
  // qrcode-terminal renders rows using one of these block chars per cell.
  return /[▀▄█▐▖-▟]/.test(s)
}

async function persistQrText(text: string): Promise<void> {
  if (!existsSync(WORKFLOW_DIR)) await mkdir(WORKFLOW_DIR, { recursive: true })
  await writeFile(QR_FILE, text, 'utf-8')
}

/** Start the SDK QR-code login flow. Returns the current state immediately;
 *  the caller polls getLoginState() to observe progress. Idempotent — calling
 *  again while a flow is in progress is a no-op. */
export function startLogin(): LoginState {
  if (inflight) return getLoginState()

  setState({
    phase: 'awaiting-qr',
    startedAt: new Date().toISOString(),
    qrAscii: undefined,
    accountId: undefined,
    error: undefined,
  })

  // Claim the slot synchronously so two concurrent callers can't both pass
  // the guard in the same microtask tick before the IIFE assigns it.
  let resolve!: () => void
  inflight = new Promise<void>((r) => { resolve = r })

  void (async () => {
    // The SDK writes the QR via console.log(qr) directly — not through our
    // log callback — so intercept console.log briefly to capture it.
    const origConsoleLog = console.log
    let qrCapture = ''
    let pendingFlush: NodeJS.Timeout | null = null

    const flushQr = () => {
      pendingFlush = null
      if (!qrCapture) return
      const captured = qrCapture
      setState({ phase: 'awaiting-qr', qrAscii: captured })
      void persistQrText(captured).catch(() => undefined)
      // Reset capture so a refreshed QR starts a fresh accumulation.
      qrCapture = ''
    }

    console.log = ((...args: unknown[]) => {
      const msg = args.map(a => typeof a === 'string' ? a : String(a)).join(' ')
      if (isQrLine(msg)) {
        qrCapture = qrCapture ? `${qrCapture}\n${msg}` : msg
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(flushQr, 100)
      }
      origConsoleLog.apply(console, args as [unknown, ...unknown[]])
    }) as typeof console.log

    try {
      const accountId = await sdkLogin({
        log: (msg) => {
          console.log(`[wechat-login] ${msg}`)
          if (/scanned|已扫码|已扫描/.test(msg)) {
            setState({ phase: 'awaiting-scan' })
          }
        },
      })
      setState({ phase: 'logged-in', accountId, qrAscii: undefined })
      if (!isInitialized()) {
        await initWeChat()
      }
    } catch (err) {
      console.error('[wechat-login] flow failed:', err)
      setState({ phase: 'failed', error: (err as Error).message })
    } finally {
      console.log = origConsoleLog
      if (pendingFlush) clearTimeout(pendingFlush)
      inflight = null
      resolve()
    }
  })()

  return getLoginState()
}

/** True when a login flow is currently in progress. */
export function isLoginInflight(): boolean {
  return inflight !== null
}

/** Reset the login flow back to idle (does not log out). */
export function resetLoginState(): void {
  if (inflight) return
  state = { phase: 'idle' }
}
