import { defineConfig } from '@playwright/test'

const UI_PORT = 5173
const API_PORT = 3001
const BASE_URL = `http://127.0.0.1:${UI_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
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
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npx vite --port 5173',
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
})
