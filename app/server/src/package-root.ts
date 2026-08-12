/** Where this package's own files live, for code that runs after it is installed.
 *
 *  The built UI ships *inside* the package, so the server has to name it relative
 *  to the package rather than to a checkout — and the distance from a *source
 *  file* to the package root is not the distance from the *built bundle* to it.
 *  esbuild rewrites neither `import.meta.url` nor the `../` next to it, so a
 *  source-relative asset path silently retargets the moment it is bundled. The
 *  expression this replaces, `resolve(dirname(fileURLToPath(import.meta.url)),
 *  '../../ui/dist')` in `index.ts`, named `app/ui/dist` from the checkout and a
 *  directory two levels *above* the package from the tarball.
 *
 *  This module sits one level below the package root in both layouts the app
 *  ships — `src/package-root.ts` when the server runs from source under `tsx`,
 *  and inlined into `dist/yaco-app.mjs` when it runs from an install — so `../`
 *  is the package root in both, and callers name assets instead of counting
 *  directories. Same construction as `yaco-cli`'s `src/package-root.ts`: the
 *  mechanism is shared, the constant cannot be, because each package's root is
 *  its own.
 */
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
