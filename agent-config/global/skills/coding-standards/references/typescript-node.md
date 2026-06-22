# TypeScript/Node.js house style

- Files: `kebab-case` (`session-manager.ts`).
- Exports: named only — no `export default`. Re-export the public API through a barrel `index.ts`.
- Explicit return types on public APIs (don't rely on inference at the boundary).
- `readonly` on config/data structures.
- Avoid `any` — use `unknown` and narrow at the boundary.

## Result envelope

Model fallible operations as a discriminated union, not thrown exceptions across boundaries:

```typescript
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }
```

## Errors

- Never swallow: `catch (e) {}` and `catch (e) { /* ignore */ }` are always wrong.
- Handle the known cases; re-throw the rest so unexpected errors surface:

```typescript
try {
  return { ok: true, data: await riskyOperation() }
} catch (e) {
  if (e instanceof SkillError) return { ok: false, error: e.message }
  throw e  // re-throw unexpected errors
}
```

## Async

- No floating promises — always `await` or `.catch()`.
