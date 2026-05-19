import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Integration test: drive channels/router.ts passthroughText end-to-end
 *  against a synthetic JSONL fixture and prove that:
 *    1) the SEND phase returns quickly (handleMessage resolves before stream)
 *    2) every text-bearing assistant entry produces a separate onReply call
 *    3) interim events get the ⏳ prefix, final gets ✅
 *    4) a per-session lock keeps two rapid same-session turns ordered
 *  No live WhatsApp client / no real multmux required.
 */

const { homeDir, projectsRoot } = vi.hoisted(() => ({
  homeDir: { value: '' },
  projectsRoot: { value: '' },
}))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

// Track sendToSession calls; never spawn multmux for real.
const sendCalls: { handle: string; message: string; at: number }[] = []
vi.mock('../multmux', async (orig) => {
  const actual = await orig<typeof import('../multmux')>()
  return {
    ...actual,
    sendToSession: vi.fn(async (handle: string, message: string) => {
      sendCalls.push({ handle, message, at: Date.now() })
    }),
  }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'channel-stream-home-'))
projectsRoot.value = await mkdtemp(join(tmpdir(), 'channel-stream-projects-'))
await mkdir(join(homeDir.value, '.workflow'), { recursive: true })

const projectPath = join(projectsRoot.value, 'alpha')
await mkdir(projectPath, { recursive: true })

await writeFile(
  join(homeDir.value, '.workflow', 'projects.json'),
  JSON.stringify([{ name: 'alpha', path: projectPath }]),
)

// multmux state file describing one claude session
const multmuxDir = join(homeDir.value, '.multmux', 'sessions')
await mkdir(multmuxDir, { recursive: true })
const SESSION_HANDLE = 'claude-1'
const SESSION_ID = 'sess-1'
await writeFile(
  join(multmuxDir, `${SESSION_HANDLE}.json`),
  JSON.stringify({
    handle: SESSION_HANDLE,
    provider: 'claude',
    sessionPath: projectPath,
    pid: 1234,
    sessionId: SESSION_ID,
    status: 'idle',
    createdAt: '2026-05-08T00:00:00Z',
  }),
)

// Claude JSONL path mirrors encodeProjectPath(projectPath) — see session-summary.ts:21
const encoded = projectPath.replace(/\/+$/, '').replace(/\//g, '-')
const jsonlDir = join(homeDir.value, '.claude', 'projects', encoded)
const jsonlPath = join(jsonlDir, `${SESSION_ID}.jsonl`)
await mkdir(jsonlDir, { recursive: true })
await writeFile(jsonlPath, '')

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

function claudeAssistant(content: unknown[], stop_reason = 'tool_use') {
  return { type: 'assistant', message: { stop_reason, content } }
}
async function appendJsonl(path: string, obj: unknown): Promise<void> {
  await appendFile(path, JSON.stringify(obj) + '\n')
}

afterAll(async () => {
  await rm(homeDir.value, { recursive: true, force: true })
  await rm(projectsRoot.value, { recursive: true, force: true })
})

describe('channel passthrough streaming', () => {
  beforeAll(() => {
    sendCalls.length = 0
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

    // handleMessage with plain text → passthroughText → awaits sendToSession,
    // then queueSessionStream fires off streamAgentReply in background.
    const t0 = Date.now()
    await router.handleMessage({ conversationId: 'conv-1' }, 'do the thing', onReply)
    const sendReturnedAt = Date.now() - t0

    // The send phase should resolve quickly — well under PASSTHROUGH_TIMEOUT.
    expect(sendReturnedAt).toBeLessThan(2000)
    // Streaming has NOT fired yet (no events to read).
    expect(replies).toHaveLength(0)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]).toMatchObject({ handle: SESSION_HANDLE, message: 'do the thing' })

    // Now drip-feed JSONL entries the way Claude would for a multi-step turn.
    await new Promise(r => setTimeout(r, 300))
    await appendJsonl(jsonlPath, claudeAssistant([{ type: 'text', text: 'Looking up the file' }]))
    await new Promise(r => setTimeout(r, 350))
    await appendJsonl(jsonlPath, claudeAssistant([
      { type: 'tool_use', name: 'Read', input: { path: '/x' } },
    ]))
    await new Promise(r => setTimeout(r, 350))
    await appendJsonl(jsonlPath, claudeAssistant([{ type: 'text', text: 'Patching now' }]))
    await new Promise(r => setTimeout(r, 350))
    await appendJsonl(
      jsonlPath,
      claudeAssistant([{ type: 'text', text: 'All done — fixed line 42.' }], 'end_turn'),
    )

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

  it('serializes two same-session turns under the per-session lock', async () => {
    sendCalls.length = 0
    const order: string[] = []

    let resolveDone: () => void
    const done = new Promise<void>(r => { resolveDone = r })

    const onReply = vi.fn(async (reply: { kind: string; text?: string }) => {
      if (reply.kind === 'text' && reply.text) {
        order.push(reply.text)
        // Resolve once we've seen both final markers.
        if (order.filter(t => t.startsWith('✅')).length >= 2) resolveDone()
      }
    })

    // Truncate JSONL so stream starts clean.
    await writeFile(jsonlPath, '')

    // Fire two messages back-to-back — both target the same session, so the
    // per-session lock should make stream B wait for stream A's `final`.
    await router.handleMessage({ conversationId: 'conv-1' }, 'first request', onReply)
    await router.handleMessage({ conversationId: 'conv-1' }, 'second request', onReply)

    // Both sends already happened (serialize+await), reply streams are queued.
    expect(sendCalls.map(s => s.message)).toEqual(['first request', 'second request'])

    // Emit turn A: interim + final.
    await new Promise(r => setTimeout(r, 300))
    await appendJsonl(jsonlPath, claudeAssistant([{ type: 'text', text: 'A-interim' }]))
    await new Promise(r => setTimeout(r, 350))
    await appendJsonl(jsonlPath, claudeAssistant([{ type: 'text', text: 'A-final' }], 'end_turn'))

    // Give stream A time to complete BEFORE turn B's content lands.
    await new Promise(r => setTimeout(r, 600))

    // Emit turn B.
    await appendJsonl(jsonlPath, claudeAssistant([{ type: 'text', text: 'B-final' }], 'end_turn'))

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
