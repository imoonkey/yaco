import wweb from 'whatsapp-web.js'
import type { Message } from 'whatsapp-web.js'
import { spawnSync } from 'node:child_process'
import { readlinkSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRouter, type ChannelReply } from '../channels/router'
import { sweepStaleTaps, shutdownAllTaps } from '../channels/pty-tap'
import { whatsappStore } from './state'
import { authorize, getAuthSnapshot, ensureAuthLoaded } from './auth'
import { channelScopeDir } from '@yaco/cli/core/paths'

const { Client, LocalAuth, MessageMedia } = wweb

const SESSION_DIR = join(channelScopeDir('whatsapp'), 'session')
// LocalAuth nests another "session" directory inside SESSION_DIR for the
// browser profile (userDataDir).
const PROFILE_DIR = join(SESSION_DIR, 'session')

/** If a previous Puppeteer Chrome was orphaned (e.g. unclean exit), its
 *  SingletonLock symlink still references the dead/alive PID. Chrome refuses
 *  to start with a live foreign PID. This sweep:
 *    - parses the lock target `<hostname>-<pid>`
 *    - if the PID is alive AND its cmdline points at our profile dir, kills it
 *    - removes Singleton{Lock,Socket,Cookie} symlinks regardless (Chrome will
 *      recreate them, and stale symlinks confuse some versions)
 *  Runs synchronously at boot; the I/O is a few stat/unlink syscalls. */
function cleanupStaleChromeSingleton(): void {
  if (!existsSync(PROFILE_DIR)) return
  const lockPath = join(PROFILE_DIR, 'SingletonLock')
  let target: string | null = null
  try { target = readlinkSync(lockPath) } catch { /* no symlink → nothing to do */ }

  if (target) {
    const m = /-(\d+)$/.exec(target)
    const pid = m ? Number(m[1]) : null
    if (pid && pid > 0) {
      let cmdline = ''
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { /* dead pid or non-linux */ }
      if (cmdline.includes(PROFILE_DIR)) {
        try {
          process.kill(pid, 'SIGTERM')
          // Give Chrome up to 1s to exit; busy-poll /proc since we're at boot
          // and no event loop work is pending yet.
          const deadline = Date.now() + 1000
          while (Date.now() < deadline) {
            try { readFileSync(`/proc/${pid}/cmdline`) } catch { break }
          }
          // If still alive, escalate.
          try { readFileSync(`/proc/${pid}/cmdline`); process.kill(pid, 'SIGKILL') } catch { /* gone */ }
          console.warn(`[whatsapp] killed orphan Chrome pid=${pid} holding SingletonLock`)
        } catch (e) {
          console.warn(`[whatsapp] failed to kill orphan Chrome pid=${pid}:`, e)
        }
      }
    }
  }

  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { unlinkSync(join(PROFILE_DIR, f)) } catch { /* ignore */ }
  }
}

export type WhatsAppPhase = 'idle' | 'awaiting-qr' | 'authenticating' | 'ready' | 'failed' | 'disconnected'

export interface WhatsAppLoginState {
  phase: WhatsAppPhase
  qrAscii?: string
  qrRaw?: string
  error?: string
  startedAt?: string
  updatedAt?: string
  ready: boolean
  /** The chat JID this bot is locked to, if WHATSAPP_CHAT_JID is set. */
  boundChat?: string
  /** True when running in discovery mode (no env, bot is silent + logging chat JIDs). */
  discoveryMode: boolean
}

let client: Client | null = null
let state: WhatsAppLoginState = { phase: 'idle', ready: false, discoveryMode: false }
let initInflight: Promise<void> | null = null
let myJid: string | null = null
const router = createRouter(whatsappStore)

const BOUND_CHAT_JID = (process.env.WHATSAPP_CHAT_JID ?? '').trim() || null

const queues = new Map<string, Promise<unknown>>()

// Body-content dedup: mark a (chat, body) pair as "we just sent this"
// BEFORE awaiting msg.reply(). When the matching message_create event
// arrives (same chat + same body), it's our reply — skip it.
//
// Why not dedup by message id: msg.reply() returns the sent Message AFTER
// the message_create event already fires, so id-based dedup is racy and
// causes infinite reply loops.
interface SentMarker { chat: string; body: string; ts: number }
const recentlySent: SentMarker[] = []
const SENT_TTL_MS = 10_000

function pruneSent(now: number): void {
  while (recentlySent.length > 0 && now - recentlySent[0].ts > SENT_TTL_MS) {
    recentlySent.shift()
  }
}

function markOurReply(chat: string, body: string): void {
  pruneSent(Date.now())
  recentlySent.push({ chat, body, ts: Date.now() })
}

function consumeOurReply(chat: string, body: string): boolean {
  const now = Date.now()
  pruneSent(now)
  const idx = recentlySent.findIndex(e => e.chat === chat && e.body === body)
  if (idx < 0) return false
  recentlySent.splice(idx, 1)
  return true
}

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

async function handleMessage(msg: Message): Promise<void> {
  if (!msg.fromMe) return // only react to messages YOU send

  const conversationId = msg.id.remote

  // Skip group chats — bot is single-conversation by design.
  if (conversationId.endsWith('@g.us')) return

  const text = msg.body ?? ''
  if (!text.trim() && !msg.hasMedia) return

  // Strict explicit override: if WHATSAPP_CHAT_JID is set, only that chat.
  if (BOUND_CHAT_JID && conversationId !== BOUND_CHAT_JID) return

  // Otherwise: TOFU. authorize() atomically binds the first chat seen
  // and persists to ${YACO_HOME}/channels/whatsapp/auth.json. Subsequent
  // boots restore the binding. Other chats return 'deny' and are silently
  // dropped — your normal contact conversations are protected.
  if (!BOUND_CHAT_JID) {
    const before = getAuthSnapshot().tofuBound
    const decision = await authorize(conversationId)
    if (decision === 'deny') return
    if (!before) {
      console.log(`[whatsapp] TOFU-bound to chat ${conversationId} (persisted to \${YACO_HOME}/channels/whatsapp/auth.json)`)
    }
  }

  // Body-content dedup: skip our own bot replies that fired message_create.
  if (consumeOurReply(conversationId, text)) return

  if (msg.hasMedia) {
    const replyText = 'media not supported in V1'
    markOurReply(conversationId, replyText)
    try { await msg.reply(replyText) } catch (e) { console.error('[whatsapp] media reply failed:', e) }
    return
  }

  const sendReply = async (reply: ChannelReply): Promise<void> => {
    if (reply.kind === 'text') {
      if (!reply.text) return
      // Mark BEFORE awaiting reply — message_create can fire before reply resolves.
      markOurReply(conversationId, reply.text)
      try {
        await msg.reply(reply.text)
      } catch (e) {
        console.error('[whatsapp] reply failed:', e)
      }
      return
    }
    // file attachment
    try {
      const media = MessageMedia.fromFilePath(reply.path)
      media.filename = reply.filename
      // Caption (if any) becomes a separate message.body — also dedup it.
      if (reply.caption) markOurReply(conversationId, reply.caption)
      await msg.reply(media, undefined, reply.caption ? { caption: reply.caption } : undefined)
    } catch (e) {
      console.error('[whatsapp] file reply failed:', e)
      const errText = `failed to send ${reply.filename}: ${(e as Error).message}`
      markOurReply(conversationId, errText)
      try { await msg.reply(errText) } catch { /* swallow */ }
    }
  }

  // Read-only commands (/help, /p, /s, /who, /last, /file) bypass the
  // per-conversation queue so they respond instantly even if a passthrough
  // is in flight. State-changing commands (/use, /new, /exit) and
  // passthroughs stay queued to preserve ordering of binding mutations.
  const command = router.parseCommand(text)
  if (command && router.isReadOnlyCommand(command.name)) {
    const reply = await router.dispatch({ conversationId }, command)
    await sendReply(reply)
    return
  }

  await serialize(conversationId, async () => {
    await router.handleMessage({ conversationId }, text, sendReply)
  })
}

export function initWhatsApp(): Promise<void> {
  if (initInflight) return initInflight
  // If a prior init failed or the client got disconnected, the `client` ref
  // may still be set but is unusable. Destroy it and re-init from scratch.
  if (client && (state.phase === 'failed' || state.phase === 'disconnected')) {
    const stale = client
    client = null
    void stale.destroy().catch(() => { /* best-effort */ })
  }
  if (client) return Promise.resolve()

  // Belt-and-suspenders: if any Chrome from a prior unclean exit still
  // holds our profile's SingletonLock, kill it now so puppeteer can take
  // the lock cleanly.
  cleanupStaleChromeSingleton()

  sweepStaleTaps()

  // Eager-load any persisted TOFU binding so status reports it correctly
  // before the first inbound message arrives.
  void ensureAuthLoaded().then(() => {
    setState({ boundChat: BOUND_CHAT_JID ?? getAuthSnapshot().tofuBound ?? undefined })
  })

  setState({
    phase: 'awaiting-qr',
    startedAt: new Date().toISOString(),
    qrAscii: undefined,
    qrRaw: undefined,
    error: undefined,
    ready: false,
    boundChat: BOUND_CHAT_JID ?? undefined,
    discoveryMode: false,
  })

  if (!BOUND_CHAT_JID) {
    const tofuBound = getAuthSnapshot().tofuBound
    if (tofuBound) {
      console.log(`[whatsapp] TOFU mode: previously bound to chat ${tofuBound}`)
    } else {
      console.log('[whatsapp] TOFU mode: send a message in your intended chat (e.g. "Message yourself"); first chat seen will be bound and persisted.')
    }
  } else {
    console.log(`[whatsapp] strict mode (env override): bot will only respond in chat ${BOUND_CHAT_JID}`)
  }

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
    try {
      myJid = client?.info.wid._serialized ?? null
    } catch (e) {
      console.warn('[whatsapp] could not read own JID:', e)
    }
    setState({ phase: 'ready', ready: true, qrAscii: undefined, qrRaw: undefined, error: undefined })
    console.log(`[whatsapp] client ready (jid=${myJid ?? 'unknown'})`)
  })

  client.on('disconnected', (reason) => {
    setState({ phase: 'disconnected', ready: false, error: `disconnected: ${reason}` })
    myJid = null
    console.warn('[whatsapp] disconnected:', reason)
  })

  client.on('message_create', (msg) => {
    if (!myJid) return
    void handleMessage(msg)
  })

  initInflight = client.initialize()
    .catch((err) => {
      setState({ phase: 'failed', error: (err as Error).message, ready: false })
      console.error('[whatsapp] initialize failed:', err)
    })
    .finally(() => { initInflight = null })

  return initInflight
}

export async function logoutWhatsApp(): Promise<void> {
  if (!client) {
    spawnSync('rm', ['-rf', SESSION_DIR], { stdio: 'ignore' })
    setState({ phase: 'idle', ready: false, qrAscii: undefined, qrRaw: undefined })
    return
  }
  try { await client.logout() } catch (e) {
    console.warn('[whatsapp] logout call failed:', e)
  }
  try { await client.destroy() } catch (e) {
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
