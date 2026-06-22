import { describe, it, expect } from 'vitest'
import { speechTextFor, noticeContent, noticeDisplay } from '../attentionContent'
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

describe('noticeDisplay (visual teaser) vs noticeContent (speech)', () => {
  it('returns the message unchanged when it is short', () => {
    const it1 = item({ type: 'session_idle', title: 'Your turn', message: 'short notice' })
    expect(noticeDisplay(it1)).toBe('short notice')
  })

  it('clamps a long message to a 200-char teaser with an ellipsis', () => {
    const long = 'x'.repeat(500)
    const it1 = item({ type: 'session_idle', title: 'Your turn', message: long })
    const shown = noticeDisplay(it1)
    expect(shown).toBe('x'.repeat(200) + '…')
    expect([...shown].length).toBe(201) // 200 codepoints + ellipsis
  })

  it('does not over-ellipsize an exactly-200-codepoint non-BMP teaser', () => {
    const emoji = '😀'.repeat(200) // 200 codepoints, 400 UTF-16 units
    const it1 = item({ type: 'session_idle', title: 'Your turn', message: emoji })
    const shown = noticeDisplay(it1)
    expect(shown).toBe(emoji) // unchanged — not clamped, no ellipsis
    expect([...shown].length).toBe(200)
  })

  it('forks: speech reads the FULL message while the visual teaser is clamped', () => {
    const long = `${'蓝'.repeat(400)} done`
    const it1 = item({ type: 'session_idle', title: 'Your turn', message: long })
    // Speech path keeps the whole message…
    expect(noticeContent(it1)).toBe(long)
    expect(speechTextFor([it1])).toBe(`Your turn. ${long}`)
    // …while the toast/panel/OS-notification get the short teaser.
    expect([...noticeDisplay(it1)].length).toBe(201)
    expect(noticeDisplay(it1).endsWith('…')).toBe(true)
  })
})
