import { describe, it, expect } from 'vitest'
import { speechTextFor } from '../attentionContent'
import type { AttentionItem } from '../../hooks/useAttention'

/** Minimal AttentionItem for the pure text helper — only the fields speechTextFor
 *  reads (type/title/message) matter; the rest carry inert defaults. */
function item(over: Partial<AttentionItem> & Pick<AttentionItem, 'type' | 'title' | 'message'>): AttentionItem {
  return {
    generation: 'g',
    tier: 'handoff',
    group: 'ready',
    subject: { kind: 'session', project: 'p', sessionName: 's' },
    tsMs: 0,
    count: 1,
    interrupt: true,
    ...over,
  }
}

describe('speechTextFor', () => {
  it('reads state then notice for a single item', () => {
    expect(speechTextFor([item({ type: 'session_idle', title: 'Your turn', message: 'Finished the parser refactor' })]))
      .toBe('Your turn. Finished the parser refactor')
  })

  it('collapses to the state alone when the notice is empty', () => {
    expect(speechTextFor([item({ type: 'session_crashed', title: 'Crashed (exit 1)', message: '' })]))
      .toBe('Crashed (exit 1)')
  })

  it('uses the identity-free state label for task rows', () => {
    expect(speechTextFor([item({ type: 'task_done', title: 'Task done: T1', message: 'Ran the suite' })]))
      .toBe('Done. Ran the suite')
  })

  it('reads a count summary for a burst, never N messages', () => {
    const burst = [
      item({ type: 'session_idle', title: 'Your turn', message: 'a' }),
      item({ type: 'session_blocked', title: 'Needs approval', message: 'b' }),
      item({ type: 'task_done', title: 'Task done: T2', message: 'c' }),
    ]
    expect(speechTextFor(burst)).toBe('3 agents need your attention')
  })

  it('says nothing for an empty batch', () => {
    expect(speechTextFor([])).toBe('')
  })
})
