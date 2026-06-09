import { defineConfig } from '@playwright/test'
import { resolveDevPorts } from './e2ePorts'

// In a worktree, run the worktree's OWN vite + API server on isolated ports so
// e2e tests the worktree's code (not the main checkout) and parallel worktrees
// don't collide. Main checkout → 5173 / 3001 with server reuse, unchanged.
const { ui: UI_PORT, api: API_PORT, isWorktree } = resolveDevPorts()
const BASE_URL = `http://127.0.0.1:${UI_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
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
  webServer: [
    {
      command: 'npx tsx ../server/src/index.ts',
      env: { WORKFLOW_PORT: String(API_PORT) },
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !isWorktree,
      timeout: 30_000,
    },
    {
      command: `npx vite --port ${UI_PORT}`,
      url: BASE_URL,
      reuseExistingServer: !isWorktree,
      timeout: 30_000,
    },
  ],
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
})
