/** Boots the server the way `npm start` does and reports which optional
 *  WhatsApp modules ended up in the module registry.
 *
 *  This runs as a child process (see lazy-load.test.ts): "did booting load
 *  puppeteer" is only answerable in a process that has just booted, and the
 *  vitest worker has already imported half the tree. Both whatsapp-web.js and
 *  puppeteer are CommonJS, so Node's ESM→CJS interop routes them through the
 *  require cache and `require.cache` is an exact registry of what got loaded. */
import { createRequire } from 'node:module'
import { sep } from 'node:path'
import { loadWweb } from '../load.js'

const require = createRequire(import.meta.url)

const OPTIONAL_MODULES = ['whatsapp-web.js', 'puppeteer', 'puppeteer-core']

function loadedOptionalModules(): string[] {
  const keys = Object.keys(require.cache)
  return OPTIONAL_MODULES.filter((name) => keys.some((k) => k.includes(`${sep}${name}${sep}`)))
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server never answered on port ${port}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const port = Number(process.env.WORKFLOW_PORT)

await import('../../../index.js')
await waitForServer(port)
// The static graph is complete once the entry module resolves; startRuntime()
// runs after it, in the listen callback, and is the only thing that could still
// reach initWhatsApp(). Give it room to get past the channel gate.
await new Promise((r) => setTimeout(r, 1500))

const afterBoot = loadedOptionalModules()

const wweb = await loadWweb()
const afterLoad = loadedOptionalModules()
const constructors = ['Client', 'LocalAuth', 'MessageMedia']
  .filter((name) => typeof (wweb as unknown as Record<string, unknown>)[name] === 'function')

console.log(JSON.stringify({ afterBoot, afterLoad, constructors }))
process.exit(0)
