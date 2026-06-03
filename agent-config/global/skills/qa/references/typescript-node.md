# TypeScript/Node.js Integration & E2E Commands

## API Integration Testing

### Auto-Detect Server Framework

```bash
grep -q '"express"' package.json 2>/dev/null && echo "express"
grep -q '"fastify"' package.json 2>/dev/null && echo "fastify"
grep -q '"hono"' package.json 2>/dev/null && echo "hono"
grep -q '"supertest"' package.json 2>/dev/null && echo "supertest available"
```

### Run Integration Tests

```bash
# Convention: integration tests in __integration__/, *.integration.test.ts, or tests/
pnpm vitest run --dir tests/ 2>&1 | tail -50
pnpm vitest run "**/*.integration.test.ts" 2>&1 | tail -50

# Jest equivalent
pnpm jest --testPathPattern="integration" 2>&1 | tail -50
```

### Quick HTTP Verification

```bash
# Start server in background, hit endpoints, kill
pnpm dev &
SERVER_PID=$!
sleep 3

curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health
curl -s http://localhost:3000/api/endpoint | head -20

kill $SERVER_PID
```

### Supertest Pattern

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

## CLI E2E Testing

```bash
# Run command and check output
OUTPUT=$(node dist/cli.js start --name test 2>&1)
echo "$OUTPUT" | grep -q "started" && echo "PASS" || echo "FAIL"

# Check exit code
node dist/cli.js invalid-command 2>/dev/null; [ $? -ne 0 ] && echo "PASS"
```

## Database Integration

```bash
# Check if test DB is available
docker ps | grep -q postgres && echo "DB running"

# Run with test DB
DATABASE_URL=postgresql://localhost:5432/test pnpm vitest run --dir tests/
```
