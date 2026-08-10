/** Stops the channel while the optional module is still loading, and reports
 *  whether a browser got launched anyway.
 *
 *  `whatsapp-web.js` is replaced by a fake that takes 300ms to evaluate and
 *  counts its own construction, which makes the interleaving deterministic:
 *  the stop always lands inside the load window, and "did a client get built"
 *  is a counter rather than a timing judgement.
 *
 *  Usage: `node --import tsx stop-during-load-probe.ts shutdown|logout` */
import { registerHooks } from 'node:module'

const FAKE_WWEB = `
globalThis.__fakeWweb = { constructed: 0, initialized: 0 }
await new Promise((resolve) => setTimeout(resolve, 300))
class Client {
  info = { wid: { _serialized: 'fake@c.us' } }
  constructor() { globalThis.__fakeWweb.constructed++ }
  on() {}
  async initialize() { globalThis.__fakeWweb.initialized++ }
  async logout() {}
  async destroy() {}
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

const mode = process.argv[2]
if (mode !== 'shutdown' && mode !== 'logout') throw new Error(`unknown stop mode: ${mode}`)

const { initWhatsApp, shutdownWhatsApp, logoutWhatsApp, getLoginState, isInitialized } =
  await import('../index.js')

void initWhatsApp()
await (mode === 'logout' ? logoutWhatsApp() : shutdownWhatsApp())
// Outlive the fake loader, so a start that ignored the stop has every chance to
// finish and be caught.
await new Promise((resolve) => setTimeout(resolve, 1000))

const fake = (globalThis as unknown as { __fakeWweb?: { constructed: number; initialized: number } }).__fakeWweb

console.log(JSON.stringify({
  constructed: fake?.constructed ?? 0,
  initialized: fake?.initialized ?? 0,
  login: getLoginState(),
  initialized_flag: isInitialized(),
}))
process.exit(0)
