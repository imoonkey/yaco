# Web/Playwright Testing Commands

## Setup Check

```bash
npx playwright --version 2>/dev/null || echo "Playwright not installed"
grep -q '"@playwright/test"' package.json 2>/dev/null && echo "Found in package.json"
```

If not installed: `npm init playwright@latest`

## Test Commands

```bash
# Run all tests
npx playwright test

# Run specific test file
npx playwright test tests/example.spec.ts

# Run with UI mode (interactive)
npx playwright test --ui

# Run headed (visible browser)
npx playwright test --headed

# Show HTML report after run
npx playwright show-report
```

## Writing a Basic Test

```typescript
import { test, expect } from '@playwright/test';

test('page loads and shows title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/My App/);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});
```

## Common Patterns

### Navigation & Assertions

```typescript
await page.goto('/dashboard');
await expect(page).toHaveURL(/dashboard/);
await expect(page.locator('.status')).toHaveText('Active');
```

### Form Filling

```typescript
await page.getByLabel('Email').fill('user@example.com');
await page.getByLabel('Password').fill('secret');
await page.getByRole('button', { name: 'Sign in' }).click();
await expect(page.getByText('Welcome back')).toBeVisible();
```

### Waiting for Network

```typescript
await Promise.all([
  page.waitForResponse(resp => resp.url().includes('/api/data') && resp.status() === 200),
  page.getByRole('button', { name: 'Load' }).click(),
]);
```

## Visual Regression

```typescript
// Screenshot comparison (generates reference on first run)
await expect(page).toHaveScreenshot('homepage.png');

// Element screenshot
await expect(page.locator('.card')).toHaveScreenshot('card.png', {
  maxDiffPixelRatio: 0.01,
});
```

Update snapshots: `npx playwright test --update-snapshots`

## Debugging

```bash
# Debug mode (opens inspector)
npx playwright test --debug

# Trace viewer (after test with trace enabled)
npx playwright show-trace trace.zip
```

Enable tracing in config:
```typescript
use: { trace: 'on-first-retry' }
```
