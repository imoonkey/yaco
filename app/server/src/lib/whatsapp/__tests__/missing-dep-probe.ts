/** Exercises the absent-optional-dependency path for real: a resolve hook makes
 *  `whatsapp-web.js` unresolvable exactly as an install without it would, then
 *  the channel is started through its ordinary entry point.
 *
 *  Runs as a child process (see lazy-load.test.ts) — the hook is process-wide,
 *  and stderr has to be attributable to this one call. */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'whatsapp-web.js') {
      const err: NodeJS.ErrnoException = new Error(`Cannot find package '${specifier}'`)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    return nextResolve(specifier, context)
  },
})

const { initWhatsApp, getLoginState, isInitialized } = await import('../index.js')

await initWhatsApp()

console.log(JSON.stringify({ login: getLoginState(), initialized: isInitialized() }))
process.exit(0)
