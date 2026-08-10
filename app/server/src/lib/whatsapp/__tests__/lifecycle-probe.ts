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
import { registerHooks } from 'node:module'

const LOAD_DELAY_MS = 300
const DESTROY_DELAY_MS = 300

interface FakeWweb {
  constructed: number
  initialized: number
  destroyed: number
  clients: { emit: (event: string, ...args: unknown[]) => void }[]
}

const FAKE_WWEB = `
import { EventEmitter } from 'node:events'
globalThis.__fakeWweb = { constructed: 0, initialized: 0, destroyed: 0, clients: [] }
await new Promise((resolve) => setTimeout(resolve, ${LOAD_DELAY_MS}))
class Client extends EventEmitter {
  info = { wid: { _serialized: 'fake@c.us' } }
  constructor() {
    super()
    globalThis.__fakeWweb.constructed++
    globalThis.__fakeWweb.clients.push(this)
  }
  async initialize() { globalThis.__fakeWweb.initialized++ }
  async logout() {}
  async destroy() {
    globalThis.__fakeWweb.destroyed++
    await new Promise((resolve) => setTimeout(resolve, ${DESTROY_DELAY_MS}))
  }
}
class LocalAuth {}
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

const MODES = ['shutdown-during-load', 'logout-during-load', 'ghost-event', 'restart-during-stop'] as const
type Mode = typeof MODES[number]

const mode = process.argv[2] as Mode
if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`)

const { initWhatsApp, shutdownWhatsApp, logoutWhatsApp, getLoginState, isInitialized } =
  await import('../index.js')

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
  // The restart is requested while the stop is still inside destroy().
  case 'restart-during-stop': {
    await initWhatsApp()
    const stopped = shutdownWhatsApp()
    await initWhatsApp()
    await stopped
    break
  }
}

// Long enough for a start that ignored a stop to finish and be caught.
await settle(LOAD_DELAY_MS + DESTROY_DELAY_MS + 400)

const { constructed, initialized, destroyed } = fake()
console.log(JSON.stringify({
  constructed,
  initialized,
  destroyed,
  login: getLoginState(),
  isInitialized: isInitialized(),
}))
process.exit(0)
