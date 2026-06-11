import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { resolveDevPorts } from './e2ePorts'

// e2e runs ISOLATED by default: its own port + an ephemeral YACO_HOME, never the
// real ~/.yaco. Crucially, the isolated server serves the PRODUCTION BUILD of
// the UI (static dist) + /api + /ws on one port — no vite-dev, so there is no
// per-request module compilation to contend under load (the cause of flaky
// timeouts on a busy machine). Build cost is paid once at startup.
//
// Escape hatch `E2E_REUSE=1`: run against the live dev server (vite 5173 + api
// 3001, real ~/.yaco) for interactive debugging; global-teardown then prunes
// leftover test fixtures from the real registry.
//
// `E2E_SKIP_BUILD=1`: reuse an existing dist-e2e instead of rebuilding — fast
// local iteration when the UI hasn't changed.
const { ui: UI_PORT, api: API_PORT, yacoHome } = resolveDevPorts({ e2e: true })
const isolated = yacoHome !== null

// Isolated → the API server serves the UI too, so target IT. Reuse → vite.
const BASE_URL = `http://127.0.0.1:${isolated ? API_PORT : UI_PORT}`

// e2e builds into its OWN dist so it never clobbers app/ui/dist (which
// `npm run start:app` serves). Absolute path for the server's YACO_UI_DIST.
const E2E_UI_DIST = fileURLToPath(new URL('./dist-e2e', import.meta.url))

const apiServerEnv: Record<string, string> = {
  WORKFLOW_PORT: String(API_PORT),
  // Never start the messaging channels in e2e: they launch headless Chromes
  // (puppeteer) that orphan when Playwright kills the server and pile up. Disable
  // explicitly so an inherited WHATSAPP_ENABLED/WECHAT_ENABLED=1 can't leak in.
  WHATSAPP_ENABLED: '0',
  WECHAT_ENABLED: '0',
}
if (yacoHome) {
  apiServerEnv.YACO_HOME = yacoHome
  apiServerEnv.YACO_UI_DIST = E2E_UI_DIST
}

// Isolated mode boots its OWN server; reuse mode reuses the dev servers.
const reuseExistingServer = !isolated

// Isolated command: build the static UI into dist-e2e (served by the server),
// wipe the ephemeral home (web servers start before globalSetup, so preclean
// here), then boot. A static build has no per-request compilation, so it stays
// responsive under load — the fix for vite-dev's flaky timeouts. Build dominates
// startup → allow time. `import.meta.env.DEV` is false in a build, so dev-only
// test hooks (e.g. the fake MicVAD) don't work here — those specs self-skip and
// run under E2E_REUSE=1 instead. The preclean reads YACO_HOME from the env (not
// a shell-interpolated path) and validates it before any rm.
const buildStep = isolated && !process.env.E2E_SKIP_BUILD ? 'npx vite build --outDir dist-e2e && ' : ''
const apiCommand = isolated
  ? `${buildStep}node tests/e2e/preclean.mjs && npx tsx ../server/src/index.ts`
  : 'npx tsx ../server/src/index.ts'

const apiServer = {
  command: apiCommand,
  env: apiServerEnv,
  url: `http://127.0.0.1:${API_PORT}/api/health`,
  reuseExistingServer,
  timeout: isolated ? 180_000 : 30_000,
}

// Only reuse mode needs a separate vite dev server (proxying /api to our API
// port); isolated mode serves the built UI straight from the API server.
const webServer = isolated
  ? [apiServer]
  : [
      apiServer,
      {
        command: `npx vite --port ${UI_PORT}`,
        env: { VITE_PROXY_API_PORT: String(API_PORT) },
        url: BASE_URL,
        reuseExistingServer,
        timeout: 30_000,
      },
    ]

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  // The static server handles concurrency well, but /api is one process and the
  // box is often busy — two retries absorb the rare transient contention blip.
  retries: 2,
  // Hermetic specs (own fixtures + isolated YACO_HOME) → run FILES in parallel.
  // The built UI removes the vite-dev compile bottleneck, so workers can be
  // higher than dev-mode allowed; tune with E2E_WORKERS.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 6,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    headless: true,
    actionTimeout: 10_000,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer,
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
})
