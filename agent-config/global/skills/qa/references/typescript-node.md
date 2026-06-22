# TypeScript/Node — integration & E2E

Detect the server framework, then supertest vs. live-HTTP:

```bash
grep -q '"express"' package.json 2>/dev/null && echo "express"
grep -q '"fastify"' package.json 2>/dev/null && echo "fastify"
grep -q '"hono"' package.json 2>/dev/null && echo "hono"
grep -q '"supertest"' package.json 2>/dev/null && echo "supertest available"
```

Integration specs conventionally live in `tests/`, `__integration__/`, or `*.integration.test.ts`.

```bash
pnpm vitest run --dir tests/ 2>&1 | tail -50
pnpm vitest run "**/*.integration.test.ts" 2>&1 | tail -50
pnpm jest --testPathPattern=integration 2>&1 | tail -50   # jest equivalent
```

## Quick HTTP smoke (live server)

Start in background, capture the PID, poll, kill — `-w "%{http_code}"` asserts status without a body:

```bash
pnpm dev & SERVER_PID=$!
sleep 3
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health
curl -s http://localhost:3000/api/endpoint | head -20
kill $SERVER_PID
```

## Supertest (in-process, no network)

```typescript
import request from 'supertest';
import { app } from '../src/app';

test('POST /items returns 201', async () => {
  const res = await request(app)
    .post('/items')
    .send({ name: 'test' })
    .expect(201);
  expect(res.body.id).toBeDefined();
});
```

## CLI E2E

```bash
node dist/cli.js start --name test 2>&1 | grep -q started && echo PASS || echo FAIL
node dist/cli.js invalid-command 2>/dev/null; [ $? -ne 0 ] && echo "non-zero exit OK"
```

## Database-backed

```bash
docker ps | grep -q postgres || echo "test DB not running"
DATABASE_URL=postgresql://localhost:5432/test pnpm vitest run --dir tests/
```
