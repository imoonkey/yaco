import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { login as sdkLogin } from 'weixin-agent-sdk'
import { initWeChat, isInitialized } from './index'
import { channelScopeDir } from '@yaco/cli/core/paths'

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

const QR_DIR = channelScopeDir('wechat')
const QR_FILE = join(QR_DIR, 'qr.txt')

let state: LoginState = { phase: 'idle' }
let inflight: Promise<void> | null = null
/** Bumped by every start and every cancel. The SDK's login promise cannot be
 *  aborted — it resolves only when the user finally scans, or never — so a
 *  cancelled flow is instead ABANDONED: it keeps running, but a stale
 *  generation makes it stop writing state or touching the channel. Without
 *  this, `inflight` stays set for as long as an unscanned QR is on screen, and
 *  anything guarding on it (turn off, logout) is unreachable forever. */
let generation = 0

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
  if (!existsSync(QR_DIR)) await mkdir(QR_DIR, { recursive: true })
  await writeFile(QR_FILE, text, 'utf-8')
}

/** Start the SDK QR-code login flow. Returns the current state immediately;
 *  the caller polls getLoginState() to observe progress. Idempotent — calling
 *  again while a flow is in progress is a no-op. */
export function startLogin(): LoginState {
  if (inflight) return getLoginState()

  const gen = ++generation
  const isStale = (): boolean => gen !== generation

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
      if (isStale() || !qrCapture) return
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
          if (!isStale() && /scanned|已扫码|已扫描/.test(msg)) {
            setState({ phase: 'awaiting-scan' })
          }
        },
      })
      // A cancelled flow must not resurrect the channel the user just stopped.
      if (isStale()) return
      setState({ phase: 'logged-in', accountId, qrAscii: undefined })
      if (!isInitialized()) {
        await initWeChat()
      }
    } catch (err) {
      if (isStale()) return
      console.error('[wechat-login] flow failed:', err)
      setState({ phase: 'failed', error: (err as Error).message })
    } finally {
      if (pendingFlush) clearTimeout(pendingFlush)
      // Only the active flow owns `console.log` and `inflight`. A stale flow
      // restoring its saved original would drop the interceptor a newer flow
      // installed on top of it, breaking that flow's QR capture.
      if (!isStale()) {
        console.log = origConsoleLog
        inflight = null
      }
      resolve()
    }
  })()

  return getLoginState()
}

/** Abandon any in-flight login and reset to idle. Does not log out.
 *
 *  Always succeeds. A stop action — cancel, turn off, log out — must preempt a
 *  running login rather than be refused by it: the login can sit unscanned
 *  indefinitely, so refusing leaves the user with no way out at all. */
export function resetLoginState(): void {
  generation += 1
  inflight = null
  state = { phase: 'idle' }
}
