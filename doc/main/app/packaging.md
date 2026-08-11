# Packaging

> How `app/` becomes `@yaco/app` on npm: one bundle, the built UI inside it, native dependencies left outside.

Last updated: 2026-08-11 · Code: `app/server/scripts/build.mjs`, `app/server/package.json`, `app/ui/vite.config.ts` · Parent: [README.md](README.md)

| Package | Contents | Artifact |
|---|---|---|
| `@yaco/cli` | CLI + the agent skills | esbuild command bundle + a `tsc` module emit -> See: [../cli/architecture.md](../cli/architecture.md) |
| `@yaco/app` | `app/server` + the built UI | one esbuild bundle, `dist/yaco-app.mjs`, which is also the `bin` |

**Two packages, not one.** `@yaco/cli` has one small runtime dependency. Merging
would make everyone running `yaco agent list` install `node-pty` and compile it
from source on Linux, plus ~40 MB of SDKs. The CLI's near-zero-dependency install
is its most valuable distribution property.

**Two, not three.** `app/ui` and `packages/codex-transcribe` stay `private` and are
never published: the UI ships as built files inside `@yaco/app`, and
codex-transcribe (one consumer, no dependencies) is inlined into the bundle.

## The package root

`app/server/src/package-root.ts` holds one expression,
`fileURLToPath(new URL("../", import.meta.url))`, and it is correct in both
layouts the app runs in because the module sits one level below the package root
in each: `src/package-root.ts` under `tsx`, and inlined into `dist/yaco-app.mjs`
from an install. Bundling rewrites neither `import.meta.url` nor the `../` beside
it, so a source-relative asset path silently retargets the moment it is bundled —
which is why nothing else in `app/server` computes one. Same construction as the
CLI's `src/package-root.ts`; the constant cannot be shared, because each
package's root is its own.

The only asset resolved through it is the UI, at `<package-root>/ui`.
`app/ui`'s vite build writes **there**, not to `app/ui/dist`, so one path is
right from a checkout and from an install alike. A copy staged at pack time would
have been the alternative, and it cannot work: `vite build --watch` — the shape
the `yaco-ui-build` service runs — never reaches a `&&`-chained copy step.
-> See: [backend/server.md](backend/server.md#ui-serving) for what serves it.

## What is in the bundle and what is beside it

**A declared dependency is external; everything else is inlined.**
`scripts/build.mjs` reads the externals straight out of `package.json`, so the
manifest is not documentation — it is the build's only input for that decision.
`@yaco/codex-transcribe` is inlined precisely *by not being a dependency*, which
is also the only correct published manifest, since it is not published.

Both ways of breaking that rule are silent in a checkout, where npm's hoisting
makes everything resolve either way: an undeclared import ships a copy of someone
else's library inside our bundle, and a declared-but-unimported package makes
every consumer install it for nothing. `test/manifest.test.ts` audits esbuild's
own metafile in both directions — the resolver is the only thing that knows what
actually entered the bundle — plus refuses the two routes the resolver cannot
follow: a non-literal `import(name)`, which survives into the bundle unresolved
and fails on a consumer's machine, and `require`/`createRequire`, which reaches a
package with no import statement to find.

## Optional dependencies

Optional here means "the install tolerates its absence", not "rarely wanted".
Each is loaded through a dynamic `import()` so a missing package degrades one
feature instead of stopping the server at load.

| Package | Why optional |
|---|---|
| `msedge-tts` | Ships `preinstall: npx only-allow pnpm`, which refuses under npm and **aborts `npm install --global` of anything requiring it**. Optional is the one classification npm tolerates that failure for. Absent, `/api/voice/speak` answers 502 and the browser speaks instead. Every 2.x has the gate. |
| `whatsapp-web.js` | Hard-depends on puppeteer, whose Chromium is 626 MB. |
| `qrcode-terminal` | The WhatsApp QR render, and reachable only from that path. |

## Releasing

`@yaco/cli` and `@yaco/app` carry one shared version and release together; the
app depends on the CLI by published range, never by workspace `*`. `prepack`
cleans, builds the UI into `<package-root>/ui`, and bundles the server, so a
successful `npm pack` has also proved the build. `files` ships `dist`, `ui` and
`LICENSE` — no sources.

Until `@yaco/cli` is on the registry, the two tarballs install together in one
command; npm satisfies the app's dependency edge from the co-installed CLI.

```bash
npm pack --workspace @yaco/cli --workspace @yaco/app
npm install --global yaco-cli-<v>.tgz yaco-app-<v>.tgz
yaco-app                       # serves the UI + API on WORKFLOW_PORT (default 3001)
```

`cd app/server && npm run test:integration` is that whole sequence as a test: it
packs, installs into a clean prefix under an isolated HOME, and fetches the UI
over HTTP from a directory with no checkout above it. It is not part of
`scripts/verify.sh` — a clean-prefix install compiles `node-pty` from source —
so run it when packaging, dependencies, or the served UI change.

## Invariants

- Nothing in `app/server` resolves an asset relative to a source file; the only
  package-relative expression is `src/package-root.ts`.
- Every package the bundle leaves external is declared, and every declared
  package is imported — enforced against esbuild's metafile, not against a grep.
- `node-pty` keeps its own install behavior: prebuilt on macOS/Windows, compiled
  on Linux, which is why the README's `build-essential` note stands.

## -> See

- [README.md](README.md) — app documentation map
- [backend/server.md](backend/server.md#ui-serving) — how the served build is negotiated and cached
- [../../dev/app/workflow.md](../../dev/app/workflow.md#build) — building and running it locally
- [../cli/architecture.md](../cli/architecture.md) — the CLI's own artifacts
