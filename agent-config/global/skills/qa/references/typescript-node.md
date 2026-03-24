# TypeScript/Node.js Test Commands

## Auto-Detect Test Runner

```bash
# Check package.json for test runner
grep -q '"vitest"' package.json 2>/dev/null && echo "vitest"
grep -q '"jest"' package.json 2>/dev/null && echo "jest"
```

## Run Tests

```bash
# Vitest
pnpm vitest run 2>&1 | tail -50

# Jest
pnpm jest 2>&1 | tail -50

# Generic (uses package.json "test" script)
pnpm test 2>&1 | tail -50
```

## Run Specific Tests

```bash
# Vitest — by file or pattern
pnpm vitest run src/utils.test.ts
pnpm vitest run -t "should handle edge case"

# Jest — by file or pattern
pnpm jest src/utils.test.ts
pnpm jest -t "should handle edge case"
```

## Coverage

```bash
# Vitest
pnpm vitest run --coverage 2>&1 | tail -30

# Jest
pnpm jest --coverage 2>&1 | tail -30
```
