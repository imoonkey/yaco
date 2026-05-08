import wweb from 'whatsapp-web.js'
import type { Message } from 'whatsapp-web.js'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRouter } from '../channels/router'
import { sweepStaleTaps, shutdownAllTaps } from '../channels/pty-tap'
import { whatsappStore } from './state'
import { authorize } from './auth'

const { Client, LocalAuth } = wweb

const SESSION_DIR = join(homedir(), '.workflow', 'whatsapp-session')

export type WhatsAppPhase = 'idle' | 'awaiting-qr' | 'authenticating' | 'ready' | 'failed' | 'disconnected'

export interface WhatsAppLoginState {
  phase: WhatsAppPhase
  qrAscii?: string
  qrRaw?: string
  error?: string
  startedAt?: string
  updatedAt?: string
  ready: boolean
}

let client: Client | null = null
let state: WhatsAppLoginState = { phase: 'idle', ready: false }
let initInflight: Promise<void> | null = null
const router = createRouter(whatsappStore)

// Per-conversation FIFO queue — WhatsApp can deliver concurrent messages but
// our session is single-threaded.
const queues = new Map<string, Promise<unknown>>()

function serialize<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(conversationId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => undefined)
  queues.set(conversationId, tail)
  void tail.then(() => {
    if (queues.get(conversationId) === tail) queues.delete(conversationId)
  })
  return next
}

function setState(patch: Partial<WhatsAppLoginState>): void {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() }
}

export function getLoginState(): WhatsAppLoginState {
  return { ...state }
}

export function isReady(): boolean {
  return state.ready
}

export function isInitialized(): boolean {
  return client !== null
}

/** Render a raw QR string to ASCII via qrcode-terminal. Falls back to the
 *  raw string if the lib isn't available. */
async function renderQrAscii(qrRaw: string): Promise<string> {
  try {
    // @ts-expect-error qrcode-terminal ships no types
    const mod = await import('qrcode-terminal') as {
      default: { generate: (text: string, opts: { small: boolean }, cb: (qr: string) => void) => void }
    }
    return await new Promise<string>((resolve) => {
      mod.default.generate(qrRaw, { small: true }, (qr: string) => resolve(qr))
    })
  } catch {
    return qrRaw
  }
}

async function handleInbound(msg: Message): Promise<void> {
  // Skip our own messages and status broadcasts
  if (msg.fromMe) return
  if (msg.from === 'status@broadcast') return

  const conversationId = msg.from
  const text = msg.body ?? ''

  if (await authorize(conversationId) === 'deny') return

  // hasMedia is true for image/audio/video/document attachments — V1 unsupported
  if (msg.hasMedia) {
    await msg.reply('media not supported in V1')
    return
  }

  await serialize(conversationId, async () => {
    const reply = await router.handleMessage({ conversationId }, text)
    if (reply) {
      try { await msg.reply(reply) } catch (e) {
        console.error('[whatsapp] reply failed:', e)
      }
    }
  })
}

/** Start (or reconnect to) the WhatsApp client. Idempotent — concurrent
 *  callers reuse the in-flight initialize promise. Persists session to
 *  ~/.workflow/whatsapp-session via LocalAuth so subsequent boots auto-resume. */
export function initWhatsApp(): Promise<void> {
  if (initInflight) return initInflight
  if (client) return Promise.resolve()

  sweepStaleTaps()

  setState({
    phase: 'awaiting-qr',
    startedAt: new Date().toISOString(),
    qrAscii: undefined,
    qrRaw: undefined,
    error: undefined,
    ready: false,
  })

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  })

  client.on('qr', (qrRaw: string) => {
    setState({ phase: 'awaiting-qr', qrRaw, ready: false })
    void renderQrAscii(qrRaw).then((ascii) => setState({ qrAscii: ascii })).catch(() => undefined)
  })

  client.on('authenticated', () => {
    setState({ phase: 'authenticating', qrAscii: undefined, qrRaw: undefined })
  })

  client.on('auth_failure', (msg) => {
    setState({ phase: 'failed', error: `auth_failure: ${msg}`, ready: false })
  })

  client.on('ready', () => {
    setState({ phase: 'ready', ready: true, qrAscii: undefined, qrRaw: undefined, error: undefined })
    console.log('[whatsapp] client ready')
  })

  client.on('disconnected', (reason) => {
    setState({ phase: 'disconnected', ready: false, error: `disconnected: ${reason}` })
    console.warn('[whatsapp] disconnected:', reason)
  })

  client.on('message', (msg) => { void handleInbound(msg) })

  initInflight = client.initialize()
    .catch((err) => {
      setState({ phase: 'failed', error: (err as Error).message, ready: false })
      console.error('[whatsapp] initialize failed:', err)
    })
    .finally(() => { initInflight = null })

  return initInflight
}

/** Disconnect the client and wipe local session so the next initWhatsApp()
 *  triggers a fresh QR scan. */
export async function logoutWhatsApp(): Promise<void> {
  if (!client) {
    // No client — just clear the saved session dir.
    spawnSync('rm', ['-rf', SESSION_DIR], { stdio: 'ignore' })
    setState({ phase: 'idle', ready: false, qrAscii: undefined, qrRaw: undefined })
    return
  }
  try {
    await client.logout()
  } catch (e) {
    console.warn('[whatsapp] logout call failed (continuing anyway):', e)
  }
  try {
    await client.destroy()
  } catch (e) {
    console.warn('[whatsapp] destroy failed:', e)
  }
  client = null
  spawnSync('rm', ['-rf', SESSION_DIR], { stdio: 'ignore' })
  setState({ phase: 'idle', ready: false, qrAscii: undefined, qrRaw: undefined, error: undefined })
}

export async function shutdownWhatsApp(): Promise<void> {
  if (client) {
    try { await client.destroy() } catch { /* noop */ }
    client = null
  }
  setState({ phase: 'idle', ready: false })
  await shutdownAllTaps()
}
