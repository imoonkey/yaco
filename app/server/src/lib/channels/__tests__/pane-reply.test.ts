import { describe, expect, it } from 'vitest'
import { extractPaneReply } from '../pane-reply'

describe('extractPaneReply', () => {
  it('returns only the Codex answer between the submitted and next prompts', () => {
    const pane = [
      '› hhi',
      '',
      '• Hi! What would you like to work on?',
      '',
      '› Improve documentation in @filename',
      '',
      '  quant · main · Context 97% left · gpt-5.6-sol medium · Full Access',
    ].join('\n')

    expect(extractPaneReply(pane, 'hhi', 'codex')).toBe(
      '• Hi! What would you like to work on?',
    )
  })

  it('keeps multiline Codex answers intact', () => {
    const pane = [
      '› explain it',
      '',
      '• The answer has two parts:',
      '',
      '  1. first',
      '  2. second',
      '',
      '› Write tests for @filename',
      '',
      '  repo · main · Context 99% left',
    ].join('\n')

    expect(extractPaneReply(pane, 'explain it', 'codex')).toBe([
      '• The answer has two parts:',
      '',
      '  1. first',
      '  2. second',
    ].join('\n'))
  })

  it('does not confuse a matching bottom placeholder with the submitted prompt', () => {
    const pane = [
      '› Improve documentation in @filename',
      '',
      '• Updated the README.',
      '',
      '› Improve documentation in @filename',
      '',
      '  repo · main · Context 99% left',
    ].join('\n')

    expect(extractPaneReply(pane, 'Improve documentation in @filename', 'codex')).toBe(
      '• Updated the README.',
    )
  })

  it('falls back to the rendered pane for providers without prompt framing', () => {
    expect(extractPaneReply('plain\nrendered output\n', 'hello', 'shell')).toBe(
      'plain\nrendered output',
    )
  })
})
