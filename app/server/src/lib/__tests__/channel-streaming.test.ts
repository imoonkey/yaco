import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentEvent, PendingTurn } from '../channels/agent-output'

/** Integration test: drive channels/router.ts passthroughText end-to-end and
 *  prove the app-owned streaming behavior, independent of the CLI:
 *    1) the SEND phase returns quickly (handleMessage resolves before stream)
 *    2) every text-bearing event produces a separate onReply call
 *    3) interim events get the ⏳ prefix, final gets ✅
 *    4) the shared per-handle lock keeps two rapid same-session turns ordered
 *    5) two SEPARATE routers bound to one session never stream concurrently
 *       (at most one output-follow child per handle, process-wide)
 *
 *  Provider log location + line parsing now live entirely in the CLI behind
 *  `yaco agent output-cursor|output-follow`, so the CLI-backed startTurn/
 *  streamAgentReply are scripted here — no real yaco binary, no JSONL fixtures.
 *  The REAL shared serializer (queueHandleStream) and cancelAgentOutput are kept
 *  so the cross-router lock under test is genuinely exercised. The CLI's own
 *  classifier/follower is covered by cli/test/unit/agent-output.test.ts, and the
 *  app-side consumption seam by __tests__/agent-output.test.ts. */

const { homeDir, projectsRoot, streamScripts, followLive, followMax } = vi.hoisted(() => ({
  homeDir: { value: '' },
  projectsRoot: { value: '' },
  // FIFO of per-call scripts; the shared per-handle lock makes streamAgentReply
  // calls run in order, so script[0] drives the first turn, script[1] the second.
  streamScripts: [] as Array<Array<{ ev: AgentEvent; delayMs: number }>>,
  // Live / peak concurrent scripted streams PER handle — peak must stay 1 to
  // prove a single live follower per session across routers.
  followLive: new Map<string, number>(),
  followMax: new Map<string, number>(),
}))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

// Track sendToSession calls; never spawn yaco agent for real.
const sendCalls: { handle: string; message: string; at: number }[] = []
vi.mock('../agent', async (orig) => {
  const actual = await orig<typeof import('../agent')>()
  return {
    ...actual,
    sendToSession: vi.fn(async (handle: string, message: string) => {
      sendCalls.push({ handle, message, at: Date.now() })
    }),
  }
})

// Keep the REAL shared per-handle serializer (queueHandleStream) + cancelAgentOutput
// so the lock under test runs across router instances; only the CLI-backed
// startTurn/streamAgentReply are scripted. startTurn echoes the session handle so
// streamAgentReply can key its live-stream counter by handle; streamAgentReply
// replays the next queued script with delays so the SEND phase observably returns
// before any reply lands.
vi.mock('../channels/agent-output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channels/agent-output')>()
  return {
    ...actual,
    startTurn: vi.fn(async (session: { name: string }) => ({
      handle: session.name, cursor: 'oc1_x', offset: 0,
    })),
    streamAgentReply: vi.fn(async function* (turn: PendingTurn) {
      const h = turn.handle
      const live = (followLive.get(h) ?? 0) + 1
      followLive.set(h, live)
      followMax.set(h, Math.max(followMax.get(h) ?? 0, live))
      try {
        const script = streamScripts.shift() ?? []
        for (const step of script) {
          if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs))
          yield step.ev
        }
      } finally {
        followLive.set(h, (followLive.get(h) ?? 1) - 1)
      }
    }),
  }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'channel-stream-home-'))
projectsRoot.value = await mkdtemp(join(tmpdir(), 'channel-stream-projects-'))
await mkdir(join(homeDir.value, '.yaco'), { recursive: true })

const projectPath = join(projectsRoot.value, 'alpha')
await mkdir(projectPath, { recursive: true })

await writeFile(
  join(homeDir.value, '.yaco', 'projects.json'),
  JSON.stringify([{ id: 'alpha', path: projectPath }]),
)

// agent state files — read by listSessions so the bound session resolves before
// streaming starts. SESSION_HANDLE drives the single-router tests; SHARED_HANDLE
// is bound in two routers for the cross-router singleton test.
const agentDir = join(homeDir.value, '.yaco', 'sessions')
await mkdir(agentDir, { recursive: true })
const SESSION_HANDLE = 'claude-1'
const SHARED_HANDLE = 'shared-1'
for (const [handle, sessionId, pid] of [[SESSION_HANDLE, 'sess-1', 1234], [SHARED_HANDLE, 'sess-2', 5678]] as const) {
  await writeFile(
    join(agentDir, `${handle}.json`),
    JSON.stringify({
      handle, provider: 'claude', sessionPath: projectPath,
      pid, sessionId, status: 'idle', createdAt: '2026-05-08T00:00:00Z',
    }),
  )
}

// Import AFTER mocks + home dir setup so module-scope reads see the right env.
const { createRouter } = await import('../channels/router')
const { createBindingStore } = await import('../channels/state')

const store = createBindingStore('test-stream')
await store.setBinding('conv-1', {
  project: 'alpha',
  session: SESSION_HANDLE,
  boundAt: '2026-05-08T00:00:00Z',
})

const router = createRouter(store)

const interim = (text: string): AgentEvent => ({ kind: 'interim', text })
const final = (text: string): AgentEvent => ({ kind: 'final', text })

afterAll(async () => {
  await rm(homeDir.value, { recursive: true, force: true })
  await rm(projectsRoot.value, { recursive: true, force: true })
})

describe('channel passthrough streaming', () => {
  beforeAll(() => {
    sendCalls.length = 0
    streamScripts.length = 0
  })

  it('streams multiple onReply calls per agent turn with ⏳/✅ prefixes', async () => {
    const replies: string[] = []
    let resolveDone: () => void
    const done = new Promise<void>(r => { resolveDone = r })

    const onReply = vi.fn(async (reply: { kind: string; text?: string }) => {
      if (reply.kind === 'text' && reply.text) {
        replies.push(reply.text)
        if (reply.text.startsWith('✅')) resolveDone()
      }
    })

    // Script the turn: delays keep every event AFTER the send phase resolves.
    streamScripts.push([
      { ev: interim('Looking up the file'), delayMs: 100 },
      { ev: interim('Patching now'), delayMs: 100 },
      { ev: final('All done — fixed line 42.'), delayMs: 100 },
    ])

    // handleMessage with plain text → passthroughText → awaits sendToSession,
    // then queueHandleStream fires off streamAgentReply in background.
    const t0 = Date.now()
    await router.handleMessage({ conversationId: 'conv-1' }, 'do the thing', onReply)
    const sendReturnedAt = Date.now() - t0

    // The send phase should resolve quickly — well under the first event delay.
    expect(sendReturnedAt).toBeLessThan(2000)
    // Streaming has NOT fired yet (first event is 100ms out).
    expect(replies).toHaveLength(0)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]).toMatchObject({ handle: SESSION_HANDLE, message: 'do the thing' })

    // Wait for the ✅ final reply to land.
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for ✅ reply')), 8000)),
    ])

    expect(replies).toEqual([
      '⏳ Looking up the file',
      '⏳ Patching now',
      '✅ All done — fixed line 42.',
    ])
  }, 12_000)

  it('serializes two same-session turns under the shared per-handle lock', async () => {
    sendCalls.length = 0
    streamScripts.length = 0
    const order: string[] = []

    let resolveDone: () => void
    const done = new Promise<void>(r => { resolveDone = r })

    const onReply = vi.fn(async (reply: { kind: string; text?: string }) => {
      if (reply.kind === 'text' && reply.text) {
        order.push(reply.text)
        if (order.filter(t => t.startsWith('✅')).length >= 2) resolveDone()
      }
    })

    // Turn A streams interim + final; turn B streams a single final. The lock
    // must hold B's stream until A's generator completes.
    streamScripts.push([
      { ev: interim('A-interim'), delayMs: 50 },
      { ev: final('A-final'), delayMs: 50 },
    ])
    streamScripts.push([
      { ev: final('B-final'), delayMs: 50 },
    ])

    // Fire two messages back-to-back — both target the same session.
    await router.handleMessage({ conversationId: 'conv-1' }, 'first request', onReply)
    await router.handleMessage({ conversationId: 'conv-1' }, 'second request', onReply)

    // Both sends already happened (serialize+await), reply streams are queued.
    expect(sendCalls.map(s => s.message)).toEqual(['first request', 'second request'])

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for both finals')), 8000)),
    ])

    // Critical assertion: A's events arrive before B's (per-session lock).
    const aFinalIdx = order.indexOf('✅ A-final')
    const bFinalIdx = order.indexOf('✅ B-final')
    expect(aFinalIdx).toBeGreaterThanOrEqual(0)
    expect(bFinalIdx).toBeGreaterThan(aFinalIdx)
  }, 15_000)
})

describe('cross-router follower singleton', () => {
  it('never streams the same handle concurrently across two router instances', async () => {
    streamScripts.length = 0
    followLive.set(SHARED_HANDLE, 0)
    followMax.set(SHARED_HANDLE, 0)

    // Two independent channel routers (think wechat + whatsapp), each with its
    // own binding store, both bound to the SAME session. With a per-router lock
    // each would spawn its own output-follow child; the shared per-handle lock
    // must keep them sequential — peak concurrency 1.
    const storeA = createBindingStore('rtr-a')
    const storeB = createBindingStore('rtr-b')
    await storeA.setBinding('cA', { project: 'alpha', session: SHARED_HANDLE, boundAt: '2026-05-08T00:00:00Z' })
    await storeB.setBinding('cB', { project: 'alpha', session: SHARED_HANDLE, boundAt: '2026-05-08T00:00:00Z' })
    const routerA = createRouter(storeA)
    const routerB = createRouter(storeB)

    let finals = 0
    let resolveDone: () => void
    const done = new Promise<void>(r => { resolveDone = r })
    const onReply = vi.fn(async (reply: { kind: string; text?: string }) => {
      if (reply.kind === 'text' && reply.text?.startsWith('✅')) {
        finals++
        if (finals >= 2) resolveDone()
      }
    })

    // Each stream takes time; without a shared lock the two routers would overlap.
    streamScripts.push([{ ev: interim('A-1'), delayMs: 60 }, { ev: final('A-done'), delayMs: 60 }])
    streamScripts.push([{ ev: interim('B-1'), delayMs: 60 }, { ev: final('B-done'), delayMs: 60 }])

    // Near-simultaneous sends through the two routers to the same handle.
    await Promise.all([
      routerA.handleMessage({ conversationId: 'cA' }, 'from A', onReply),
      routerB.handleMessage({ conversationId: 'cB' }, 'from B', onReply),
    ])

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for both finals')), 8000)),
    ])

    // Both turns streamed, but never at the same time: one follower per handle.
    expect(finals).toBe(2)
    expect(followMax.get(SHARED_HANDLE)).toBe(1)
    expect(followLive.get(SHARED_HANDLE)).toBe(0)
  }, 12_000)
})
