import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveSessionLog, startTurn, streamAgentReply, type AgentEvent, type PendingTurn } from '../channels/agent-output'
import type { AgentSession } from '../agent'

// Tight poll for tests — agent-output polls every 250ms.
const TICK = 350

let tmpDir: string
let jsonlPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-output-test-'))
  jsonlPath = join(tmpDir, 'session.jsonl')
  await writeFile(jsonlPath, '')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function turnFor(provider: 'claude' | 'codex'): Promise<PendingTurn> {
  const stats = await stat(jsonlPath)
  return { jsonlPath, startSize: stats.size, provider }
}

async function appendLine(obj: unknown): Promise<void> {
  await appendFile(jsonlPath, JSON.stringify(obj) + '\n')
}

async function collect(
  gen: AsyncGenerator<AgentEvent>,
  max = 10,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) {
    out.push(ev)
    if (out.length >= max) break
  }
  return out
}

function claudeAssistant(content: unknown[], stop_reason = 'tool_use') {
  return { type: 'assistant', message: { stop_reason, content } }
}

function codexEvent(phase: string, message: string) {
  return { type: 'event_msg', payload: { type: 'agent_message', phase, message } }
}

describe('streamAgentReply (claude)', () => {
  it('yields interim text blocks then final on end_turn', async () => {
    const turn = await turnFor('claude')
    const gen = streamAgentReply(turn, { timeoutMs: 5000 })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: 'Looking into this' }]))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([
      { type: 'tool_use', name: 'Read', input: { path: '/foo' } },
    ]))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: 'Almost done' }]))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant(
      [{ type: 'text', text: 'Here is the answer.' }],
      'end_turn',
    ))

    const events = await collector
    expect(events).toEqual([
      { kind: 'interim', text: 'Looking into this' },
      { kind: 'interim', text: 'Almost done' },
      { kind: 'final', text: 'Here is the answer.' },
    ])
  })

  it('joins multiple text blocks in one assistant entry into one event', async () => {
    const turn = await turnFor('claude')
    const gen = streamAgentReply(turn, { timeoutMs: 3000 })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant(
      [
        { type: 'text', text: 'Line one' },
        { type: 'text', text: 'Line two' },
      ],
      'end_turn',
    ))

    const events = await collector
    expect(events).toEqual([{ kind: 'final', text: 'Line one\nLine two' }])
  })

  it('skips thinking and tool_result lines', async () => {
    const turn = await turnFor('claude')
    const gen = streamAgentReply(turn, { timeoutMs: 3000 })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'thinking', thinking: 'hmm' }]))
    await appendLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    })
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: 'Done' }], 'end_turn'))

    const events = await collector
    expect(events).toEqual([{ kind: 'final', text: 'Done' }])
  })

  it('detects AskUserQuestion: invokes onAskUserQuestion then yields formatted question', async () => {
    const turn = await turnFor('claude')
    const onAsk = vi.fn(async () => undefined)
    const gen = streamAgentReply(turn, { timeoutMs: 3000, onAskUserQuestion: onAsk })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([
      {
        type: 'tool_use',
        name: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Continue?',
            options: [
              { label: 'yes', description: 'keep going' },
              { label: 'no', description: 'stop' },
            ],
          }],
        },
      },
    ]))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: 'cancelled' }], 'end_turn'))

    const events = await collector
    expect(onAsk).toHaveBeenCalledOnce()
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('question')
    expect((events[0] as { text: string }).text).toContain('🤔 Agent asks: Continue?')
    expect((events[0] as { text: string }).text).toContain('1) yes — keep going')
    expect((events[0] as { text: string }).text).toContain('2) no — stop')
    expect((events[0] as { text: string }).text).toContain('Dialog auto-cancelled — just reply with your answer.')
    expect(events[1]).toEqual({ kind: 'final', text: 'cancelled' })
  })

  it('keeps streaming after a question event (does not return)', async () => {
    const turn = await turnFor('claude')
    const gen = streamAgentReply(turn, {
      timeoutMs: 3000,
      onAskUserQuestion: async () => undefined,
    })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([
      {
        type: 'tool_use',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'pick one', options: [{ label: 'a' }] }] },
      },
    ]))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: 'after escape' }], 'end_turn'))

    const events = await collector
    expect(events.map(e => e.kind)).toEqual(['question', 'final'])
  })

  it('skips empty/whitespace-only text blocks', async () => {
    const turn = await turnFor('claude')
    const gen = streamAgentReply(turn, { timeoutMs: 2000 })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: '   \n  ' }]))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(claudeAssistant([{ type: 'text', text: 'real' }], 'end_turn'))

    const events = await collector
    expect(events).toEqual([{ kind: 'final', text: 'real' }])
  })
})

describe('streamAgentReply (codex)', () => {
  it('yields commentary as interim and final_answer as final', async () => {
    const turn = await turnFor('codex')
    const gen = streamAgentReply(turn, { timeoutMs: 5000 })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine(codexEvent('commentary', 'thinking step 1'))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine({ type: 'event_msg', payload: { type: 'token_count', count: 42 } })
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(codexEvent('commentary', 'thinking step 2'))
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(codexEvent('final_answer', 'Final answer here'))

    const events = await collector
    expect(events).toEqual([
      { kind: 'interim', text: 'thinking step 1' },
      { kind: 'interim', text: 'thinking step 2' },
      { kind: 'final', text: 'Final answer here' },
    ])
  })

  it('skips response_item and other event_msg payload types', async () => {
    const turn = await turnFor('codex')
    const gen = streamAgentReply(turn, { timeoutMs: 3000 })
    const collector = collect(gen)

    await new Promise(r => setTimeout(r, TICK))
    await appendLine({ type: 'response_item', payload: { type: 'agent_message', message: 'dup' } })
    await appendLine({ type: 'event_msg', payload: { type: 'task_started' } })
    await appendLine({ type: 'event_msg', payload: { type: 'agent_message', phase: 'user_message', message: 'noise' } })
    await new Promise(r => setTimeout(r, TICK))
    await appendLine(codexEvent('final_answer', 'done'))

    const events = await collector
    expect(events).toEqual([{ kind: 'final', text: 'done' }])
  })
})

describe('streamAgentReply (timeout)', () => {
  it('yields timeout event when nothing finalizes', async () => {
    const turn = await turnFor('claude')
    const gen = streamAgentReply(turn, { timeoutMs: 600 })
    const events = await collect(gen)
    expect(events).toEqual([{ kind: 'timeout' }])
  })
})

describe('provider guards (arbitrary provider strings)', () => {
  const session = (provider: string): AgentSession => ({
    name: 'g1', provider, status: 'idle', project: 'p',
    sessionPath: '/tmp/p', sessionId: 'sid-1', pid: 1,
  })

  it('resolveSessionLog returns null for unknown providers (no codex fallback)', async () => {
    expect(await resolveSessionLog(session('gemini'))).toBeNull()
  })

  it('startTurn returns null for providers without an app-side structured log', async () => {
    expect(await startTurn(session('gemini'))).toBeNull()
  })
})
