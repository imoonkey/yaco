import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import {
  TerminalOscColorResponder,
  parseTerminalPalette,
  shouldAnswerTerminalOscColor,
  terminalPaletteFromSearchParams,
} from '../terminal-osc'

const PALETTE = {
  foreground: '#657b83',
  background: '#fdf6e3',
  cursor: '#073642',
}

describe('TerminalOscColorResponder', () => {
  it('answers Codex OSC color queries and removes them from forwarded output', () => {
    const responder = new TerminalOscColorResponder(true, PALETTE)

    const result = responder.handle(`before\x1b]10;?\x1b\\middle\x1b]11;?\x07after`)

    expect(result.output).toBe('beforemiddleafter')
    expect(result.responses).toEqual([
      '\x1b]10;rgb:6565/7b7b/8383\x1b\\',
      '\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\',
    ])
  })

  it('keeps partial OSC color queries pending across chunks', () => {
    const responder = new TerminalOscColorResponder(true, PALETTE)

    expect(responder.handle('a\x1b]1')).toEqual({ output: 'a', responses: [] })
    expect(responder.handle('1;?\x1b\\b')).toEqual({
      output: 'b',
      responses: ['\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\'],
    })
  })

  it('passes all data through when disabled', () => {
    const responder = new TerminalOscColorResponder(false, PALETTE)

    expect(responder.handle('\x1b]11;?\x1b\\')).toEqual({
      output: '\x1b]11;?\x1b\\',
      responses: [],
    })
  })

  it('does not consume OSC color setter sequences', () => {
    const responder = new TerminalOscColorResponder(true, PALETTE)

    expect(responder.handle('\x1b]11;rgb:fdfd/f6f6/e3e3\x07')).toEqual({
      output: '\x1b]11;rgb:fdfd/f6f6/e3e3\x07',
      responses: [],
    })
  })

  it('updates the palette used for later responses', () => {
    const responder = new TerminalOscColorResponder(true, PALETTE)
    responder.updatePalette({
      foreground: '#839496',
      background: '#002b36',
      cursor: '#839496',
    })

    expect(responder.handle('\x1b]12;?\x1b\\').responses).toEqual([
      '\x1b]12;rgb:8383/9494/9696\x1b\\',
    ])
  })
})

describe('terminal OSC palette parsing', () => {
  it('accepts full hex palettes', () => {
    expect(parseTerminalPalette({
      foreground: '#657B83',
      background: '#FDF6E3',
      cursor: '#073642',
    })).toEqual(PALETTE)
  })

  it('rejects missing or malformed colors', () => {
    expect(parseTerminalPalette({ foreground: '#657b83', background: '#fdf6e3' })).toBeNull()
    expect(parseTerminalPalette({ foreground: 'red', background: '#fdf6e3', cursor: '#073642' })).toBeNull()
  })

  it('falls back per color channel for invalid URL params', () => {
    const params = new URLSearchParams('fg=bad&bg=%23fdf6e3&cursor=%23073642')

    expect(terminalPaletteFromSearchParams(params)).toEqual({
      foreground: '#657b83',
      background: '#fdf6e3',
      cursor: '#073642',
    })
  })
})

describe('shouldAnswerTerminalOscColor', () => {
  const dir = join(tmpdir(), `yaco-terminal-osc-${process.pid}`)

  it('enables server-side OSC responses only for trusted codex state files', () => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'codex-session.json'), JSON.stringify({ provider: 'codex' }), 'utf-8')
    writeFileSync(join(dir, 'claude-session.json'), JSON.stringify({ provider: 'claude' }), 'utf-8')
    writeFileSync(join(dir, 'bad-session.json'), '{', 'utf-8')

    expect(shouldAnswerTerminalOscColor('codex-session', dir)).toBe(true)
    expect(shouldAnswerTerminalOscColor('claude-session', dir)).toBe(false)
    expect(shouldAnswerTerminalOscColor('shell-1', dir)).toBe(false)
    expect(shouldAnswerTerminalOscColor('bad-session', dir)).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })
})
