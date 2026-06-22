# Web/Playwright

Detect: `grep -q '"@playwright/test"' package.json`. If absent, scaffold with `npm init playwright@latest`.

Run a spec headed/with inspector while diagnosing a failure; the trace viewer replays a recorded run:

```bash
npx playwright test                             # whole suite
npx playwright test --ui                        # interactive runner
npx playwright test path/to.spec.ts --headed    # visible browser
npx playwright test path/to.spec.ts --debug     # step inspector
npx playwright show-report                       # open the HTML report
npx playwright show-trace trace.zip             # needs use:{ trace:'on-first-retry' } in config
```

## Wait for the response, then click — never the reverse

Listening after the click races the network and flakes. Arm the wait first:

```typescript
await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/data') && r.status() === 200),
  page.getByRole('button', { name: 'Load' }).click(),
]);
```

## Visual regression

First run writes the reference snapshot (no assertion); later runs diff against it. Use `maxDiffPixelRatio` to tolerate antialiasing noise; regenerate intentional changes with `--update-snapshots`.

```typescript
await expect(page).toHaveScreenshot('homepage.png');                                   // full page
await expect(page.locator('.card')).toHaveScreenshot('card.png', { maxDiffPixelRatio: 0.01 });  // element
```
