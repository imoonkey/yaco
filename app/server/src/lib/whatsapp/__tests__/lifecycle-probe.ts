/** Drives one start/stop interleaving of the WhatsApp channel and reports what
 *  actually happened, so the assertions are counters rather than timing calls.
 *
 *  `whatsapp-web.js` is replaced by a fake with two deliberate delays — module
 *  evaluation and `destroy()` — which are the two windows a stop or a restart
 *  can land inside. The fake keeps every client it builds, so a test can make a
 *  torn-down client emit late and see whether the state survives it.
 *
 *  Runs as a child process (see lazy-load.test.ts): the hooks are process-wide
 *  and the channel module holds per-process state.
 *
 *  Usage: `node --import tsx lifecycle-probe.ts <mode>` */
import { existsSync, mkdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { channelScopeDir } from 'yaco-cli/core/paths'

const LOAD_DELAY_MS = 300
const DESTROY_DELAY_MS = 300

interface FakeWweb {
  constructed: number
  initialized: number
  destroyed: number
  /** Ordered, so a test can assert that a replacement session only starts once
   *  the previous one has finished handing its resources back. */
  log: string[]
  /** Whether the session directory still existed each time LocalAuth was built
   *  — logout deletes it, and must not delete a replacement's. */
  sessionDirAtStart: boolean[]
  clients: { emit: (event: string, ...args: unknown[]) => void }[]
}

const FAKE_WWEB = `
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
const fake = { constructed: 0, initialized: 0, destroyed: 0, log: [], sessionDirAtStart: [], clients: [] }
globalThis.__fakeWweb = fake
await new Promise((resolve) => setTimeout(resolve, ${LOAD_DELAY_MS}))
class Client extends EventEmitter {
  info = { wid: { _serialized: 'fake@c.us' } }
  constructor() {
    super()
    fake.constructed++
    fake.log.push('construct#' + fake.constructed)
    fake.clients.push(this)
  }
  async initialize() { fake.initialized++ }
  async logout() {}
  async destroy() {
    const n = ++fake.destroyed
    fake.log.push('destroy#' + n + ':start')
    await new Promise((resolve) => setTimeout(resolve, ${DESTROY_DELAY_MS}))
    fake.log.push('destroy#' + n + ':end')
  }
}
// LocalAuth is built immediately before the Client, and holds the profile
// directory — the resource a teardown has to release first.
class LocalAuth {
  constructor(opts) { fake.sessionDirAtStart.push(existsSync(opts.dataPath)) }
}
class MessageMedia {}
export default { Client, LocalAuth, MessageMedia }
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'whatsapp-web.js') {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_WWEB)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const MODES = [
  'shutdown-during-load',
  'logout-during-load',
  'ghost-event',
  'restart-during-shutdown',
  'restart-during-logout',
  'stale-readiness',
] as const
type Mode = typeof MODES[number]

const mode = process.argv[2] as Mode
if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`)

const { initWhatsApp, shutdownWhatsApp, logoutWhatsApp, getLoginState, isInitialized } =
  await import('../index.js')
const { getAuthSnapshot } = await import('../auth.js')

// The real LocalAuth creates this; the fake does not, so plant it and let
// logout's `rm -rf` be the only thing that can take it away.
mkdirSync(join(channelScopeDir('whatsapp'), 'session'), { recursive: true })

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Absent counters would read the same as "the stop worked", so a fake that
 *  never loaded is a probe failure rather than a pass. */
function fake(): FakeWweb {
  const f = (globalThis as unknown as { __fakeWweb?: FakeWweb }).__fakeWweb
  if (!f) throw new Error('the fake whatsapp-web.js was never loaded')
  return f
}

switch (mode) {
  // The stop lands while the optional module is still evaluating, so there is
  // no client for it to find.
  case 'shutdown-during-load':
    void initWhatsApp()
    await shutdownWhatsApp()
    break
  case 'logout-during-load':
    void initWhatsApp()
    await logoutWhatsApp()
    break
  // A client torn down by a stop keeps emitting until destroy() finishes.
  case 'ghost-event': {
    await initWhatsApp()
    const stopped = shutdownWhatsApp()
    fake().clients[0].emit('ready')
    await stopped
    fake().clients[0].emit('ready')
    break
  }
  // The restart is requested while the stop is still inside its teardown.
  case 'restart-during-shutdown':
  case 'restart-during-logout': {
    await initWhatsApp()
    const stopped = mode === 'restart-during-logout' ? logoutWhatsApp() : shutdownWhatsApp()
    await initWhatsApp()
    await stopped
    break
  }
  // A message arrives at the replacement before it has said it is ready. The
  // previous session had said so, and its readiness must not carry over.
  case 'stale-readiness': {
    await initWhatsApp()
    fake().clients[0].emit('ready')
    await settle(50)
    const stopped = shutdownWhatsApp()
    await initWhatsApp()
    await stopped
    fake().clients[1].emit('message_create', {
      fromMe: true,
      hasMedia: false,
      body: '/help',
      id: { remote: '10000000000@c.us' },
      reply: async () => { fake().log.push('replied') },
    })
    break
  }
}

// Long enough for a start that ignored a stop to finish and be caught.
await settle(LOAD_DELAY_MS + DESTROY_DELAY_MS + 400)

const { constructed, initialized, destroyed, log, sessionDirAtStart } = fake()
console.log(JSON.stringify({
  constructed,
  initialized,
  destroyed,
  log,
  sessionDirAtStart,
  sessionDirExists: existsSync(join(channelScopeDir('whatsapp'), 'session')),
  tofuBound: getAuthSnapshot().tofuBound,
  login: getLoginState(),
  isInitialized: isInitialized(),
}))
process.exit(0)
