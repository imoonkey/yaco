# TypeScript/Node.js Coding Standards

## TypeScript Idioms

### Naming

```typescript
// Classes/Interfaces/Types: PascalCase
class SessionManager {}
interface SkillManifest {}
type OperationResult = ...

// Functions/variables: camelCase
function processEvent() {}
const isRunning: boolean = true

// Constants: SCREAMING_SNAKE
const MAX_RETRIES = 3

// Files: kebab-case
// session-manager.ts, skill-manifest.ts
```

### Strict Typing

```typescript
// Prefer explicit types for public APIs
function parseHar(input: HarLog): ParsedRequest[] { ... }

// Use union types / discriminated unions for state
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// Avoid `any`
```

### Immutability

```typescript
// Prefer const
const state: SessionState = { ... }

// Use spread for modifications
const newState = { ...state, status: 'running' }

// Use readonly for data structures
interface Config {
  readonly baseUrl: string
  readonly timeout: number
}

// Avoid let unless necessary
```

### Discriminated Unions for State

```typescript
type OperationResult<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; error: string; code: number }
  | { status: 'pending' }
```

## Node.js Patterns

### Async/Await

```typescript
// Proper async with error handling
async function fetchData(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new HttpError(response.status)
  return response.json()
}

// Concurrent operations
const [users, posts] = await Promise.all([
  fetchUsers(),
  fetchPosts(),
])

// Avoid unhandled promises — always await or .catch()
```

### Error Handling

```typescript
// Custom error classes
class SkillError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'SkillError'
  }
}

// Structured error handling
try {
  const result = await riskyOperation()
  return { ok: true, data: result }
} catch (e) {
  if (e instanceof SkillError) {
    logger.error(`Skill error [${e.code}]: ${e.message}`)
    return { ok: false, error: e.message }
  }
  throw e  // Re-throw unexpected errors
}

// Never swallow: try { await riskyOperation() } catch (e) { }
```

### Module Organization

```typescript
// Named exports (prefer over default)
export function parseHar(har: HarLog): ParsedRequest[] { ... }
export interface ParsedRequest { ... }

// Barrel files for public API
// index.ts
export { parseHar } from './parser.js'
export type { ParsedRequest } from './types.js'
```
