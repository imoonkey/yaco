# TypeScript/Node.js Verification Commands

## 1. Build

```bash
pnpm tsc --noEmit 2>&1 | tail -30
```

## 2. Lint

```bash
pnpm eslint . 2>&1 | head -30
```

## 3. Tests

```bash
pnpm vitest run 2>&1 | tail -50
```

## 4. Security Scan

```bash
grep -rn "api_key\|apiKey\|API_KEY" --include="*.ts" src/ 2>/dev/null | head -10
grep -rn "sk-\|key-" --include="*.ts" src/ 2>/dev/null | head -10
```
