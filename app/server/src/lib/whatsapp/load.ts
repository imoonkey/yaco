/** The whatsapp-web.js module, loaded on demand.
 *
 *  It is an optional dependency: it hard-depends on puppeteer, whose Chromium
 *  measures ~626 MB. Importing it at module scope would charge that graph to
 *  every boot, including the majority of boots that never switch the channel
 *  on. Nothing outside this file may import 'whatsapp-web.js' for its value —
 *  type-only imports are fine, they erase. */

export type WwebModule = typeof import('whatsapp-web.js')

export const WHATSAPP_MISSING_DEPENDENCY =
  'whatsapp-web.js is not installed (it is an optional dependency). Install it with ' +
  '`npm install --workspace app/server whatsapp-web.js`, then fetch the browser it needs ' +
  'with `npx puppeteer browsers install chrome`.'

let cached: WwebModule | null = null

/** Resolves the same module object on every call, so callers may await it at
 *  any point rather than threading it down from init. */
export async function loadWweb(): Promise<WwebModule> {
  if (cached) return cached
  try {
    // The package is CommonJS with `export =`, so `module.exports` arrives on
    // `default`. The named exports Node synthesises for it are incomplete —
    // `Client` comes through but `LocalAuth` and `MessageMedia` do not — so
    // `default` is the only complete handle. TypeScript models `export =` as
    // the namespace itself and does not know about that wrapper: hence the cast.
    const ns = await import('whatsapp-web.js') as unknown as { default: WwebModule }
    cached = ns.default
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(WHATSAPP_MISSING_DEPENDENCY)
    }
    throw err
  }
  return cached
}
