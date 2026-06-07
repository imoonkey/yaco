import { describe, it, expect } from 'vitest'
import { sanitizeSummary } from '../sanitizeSummary'

describe('sanitizeSummary', () => {
  it('returns empty for missing summary', () => {
    expect(sanitizeSummary(undefined, 'x')).toBe('')
    expect(sanitizeSummary(null, 'x')).toBe('')
    expect(sanitizeSummary('', 'x')).toBe('')
  })

  it('strips system-reminder blocks entirely', () => {
    expect(
      sanitizeSummary('<system-reminder> The user named this session "foo" </system-reminder>', 'name'),
    ).toBe('')
  })

  it('strips command-message/name/args blocks', () => {
    expect(
      sanitizeSummary('<command-message>frontend-design</command-message><command-args>x</command-args>kept', 'name'),
    ).toBe('kept')
  })

  it('removes stray/truncated tags', () => {
    expect(sanitizeSummary('<command-args>partial', 'name')).toBe('partial')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeSummary('  a   b\n\tc  ', 'name')).toBe('a b c')
  })

  it('renders nothing when summary equals the name', () => {
    expect(sanitizeSummary('codex-independent', 'codex-independent')).toBe('')
  })

  it('renders nothing when summary is a prefix of the name', () => {
    expect(sanitizeSummary('codex', 'codex-independent')).toBe('')
  })

  it('keeps a distinct summary', () => {
    expect(sanitizeSummary('Implements the diff view', 'codex-independent')).toBe('Implements the diff view')
  })
})
