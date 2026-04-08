import { describe, it, expect } from 'vitest'
import {
  buildWhisperPrompt,
  buildFormatterPrompt,
  FILE_TYPE_MAP,
} from '../voice-prompts'

describe('buildWhisperPrompt', () => {
  it('returns a bilingual string with Chinese and English', () => {
    const prompt = buildWhisperPrompt()
    // Contains Chinese (中文)
    expect(prompt).toContain('IDE')
    // Contains English product names that Whisper commonly misrecognizes
    expect(prompt).toContain('Claude')
    expect(prompt).toContain('Codex')
    // Mentions the three target surfaces
    expect(prompt).toContain('editor')
    expect(prompt).toContain('terminal')
  })
})

describe('buildFormatterPrompt', () => {
  it('returns core prompt when no context provided', () => {
    const prompt = buildFormatterPrompt()
    expect(prompt).toContain('converting speech into written text')
    expect(prompt).not.toContain('Context:')
  })

  it('appends terminal context snippet for terminal surface', () => {
    const prompt = buildFormatterPrompt('terminal')
    expect(prompt).toContain('Context: terminal/agent chatbox')
  })

  it('appends file context with type label for known extension', () => {
    const prompt = buildFormatterPrompt(undefined, 'src/hooks/useVoice.ts')
    expect(prompt).toContain('Context: editing file src/hooks/useVoice.ts (TypeScript)')
  })

  it('appends file context without type label for unknown extension', () => {
    const prompt = buildFormatterPrompt(undefined, 'data/config.xyz')
    expect(prompt).toContain('Context: editing file data/config.xyz')
    expect(prompt).not.toContain('Context: editing file data/config.xyz (')
  })

  it('prefers filePath over surface when both provided', () => {
    const prompt = buildFormatterPrompt('terminal', 'app.py')
    expect(prompt).toContain('Context: editing file app.py (Python)')
    expect(prompt).not.toContain('terminal session')
  })

  it('returns core prompt for editor surface without filePath', () => {
    const prompt = buildFormatterPrompt('editor')
    expect(prompt).not.toContain('Context:')
  })

  it('includes bilingual few-shot examples in core prompt', () => {
    const prompt = buildFormatterPrompt()
    // English example
    expect(prompt).toContain('git commit -m')
    // Chinese example
    expect(prompt).toContain('帮我看一下这个 error')
    // Structure examples
    expect(prompt).toContain('1. Set up the database')
    // Contrastive example (prose with ordinal stays prose)
    expect(prompt).toContain('First of all, I think')
  })

  it('adds markdown formatting hint for .md files', () => {
    const prompt = buildFormatterPrompt(undefined, 'docs/README.md')
    expect(prompt).toContain('Use markdown formatting')
  })

  it('does not add markdown hint for non-md files', () => {
    const prompt = buildFormatterPrompt(undefined, 'src/app.ts')
    expect(prompt).not.toContain('Use markdown formatting')
  })

  it('includes structure detection rules', () => {
    const prompt = buildFormatterPrompt()
    expect(prompt).toContain('Structure detection')
    expect(prompt).toContain('Require 2+ sibling markers')
  })
})

describe('FILE_TYPE_MAP', () => {
  it('maps common extensions to human-readable labels', () => {
    expect(FILE_TYPE_MAP.ts).toBe('TypeScript')
    expect(FILE_TYPE_MAP.tsx).toBe('TypeScript (React)')
    expect(FILE_TYPE_MAP.py).toBe('Python')
    expect(FILE_TYPE_MAP.go).toBe('Go')
    expect(FILE_TYPE_MAP.md).toBe('Markdown')
    expect(FILE_TYPE_MAP.sh).toBe('Shell')
  })

  it('treats yml and yaml as equivalent', () => {
    expect(FILE_TYPE_MAP.yml).toBe(FILE_TYPE_MAP.yaml)
  })
})
