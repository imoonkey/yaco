// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalKeyBar } from '../TerminalKeyBar'
import type { Modifiers } from '../TerminalKeyBar'

let sendInput: (data: string) => void
let onModifierChange: (m: Modifiers) => void
const defaultMods: Modifiers = { ctrl: false, shift: false }

beforeEach(() => {
  sendInput = vi.fn<(data: string) => void>()
  onModifierChange = vi.fn<(m: Modifiers) => void>()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderBar(modifiers = defaultMods) {
  return render(
    <TerminalKeyBar
      sendInput={sendInput}
      modifiers={modifiers}
      onModifierChange={onModifierChange}
    />,
  )
}

function touchButton(label: string) {
  const btn = screen.getByText(label)
  fireEvent.touchStart(btn)
  return btn
}

function pointerDownByAriaLabel(label: string) {
  const btn = screen.getByRole('button', { name: label })
  fireEvent.pointerDown(btn)
  return btn
}

function expandSecondaryRow() {
  pointerDownByAriaLabel(/more terminal keys/)
}

describe('TerminalKeyBar', () => {
  describe('PRIMARY_KEYS produce correct escape sequences', () => {
    it.each([
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['PgU', '\x1b[5~'],
      ['PgD', '\x1b[6~'],
      ['←', '\x1b[D'],
      ['↓', '\x1b[B'],
      ['↑', '\x1b[A'],
      ['→', '\x1b[C'],
    ] as const)('%s sends correct sequence', (label, seq) => {
      renderBar()
      touchButton(label)
      expect(sendInput).toHaveBeenCalledWith(seq)
    })

    it('Enter sends correct sequence', () => {
      renderBar()
      const btn = screen.getByRole('button', { name: 'Enter' })
      fireEvent.touchStart(btn)
      expect(sendInput).toHaveBeenCalledWith('\r')
    })
  })

  describe('SECONDARY_KEYS produce correct escape sequences', () => {
    it.each([
      ['C', '\x03'],
      ['D', '\x04'],
      ['B', '\x02'],
      ['O', '\x0f'],
      ['A', '\x01'],
      ['E', '\x05'],
      ['U', '\x15'],
      ['K', '\x0b'],
      ['W', '\x17'],
    ] as const)('%s sends correct sequence', (label, seq) => {
      renderBar()
      expandSecondaryRow()
      touchButton(label)
      expect(sendInput).toHaveBeenCalledWith(seq)
    })
  })

  describe('expand/collapse', () => {
    it('toggles secondary row visibility via pointerDown', () => {
      const { container } = renderBar()
      const panel = container.querySelector('#terminal-keybar-secondary') as HTMLElement

      expect(panel.style.maxHeight).toBe('0px')

      expandSecondaryRow()
      expect(panel.style.maxHeight).toBe('36px')

      pointerDownByAriaLabel(/Hide more terminal keys/)
      expect(panel.style.maxHeight).toBe('0px')
    })
  })

  describe('modifier toggles', () => {
    it('Ctrl pointerDown toggles ctrl modifier (row 1)', () => {
      renderBar()
      pointerDownByAriaLabel('Control modifier')
      expect(onModifierChange).toHaveBeenCalledWith({ ctrl: true, shift: false })
    })

    it('Shift pointerDown toggles shift modifier (row 2)', () => {
      renderBar()
      expandSecondaryRow()
      pointerDownByAriaLabel('Shift modifier')
      expect(onModifierChange).toHaveBeenCalledWith({ ctrl: false, shift: true })
    })

    it('Ctrl button shows active style when modifier is on', () => {
      renderBar({ ctrl: true, shift: false })
      const btn = screen.getByRole('button', { name: 'Control modifier' })
      expect(btn.className).toContain('bg-[#268bd2]')
    })

    it('Shift button shows active style when modifier is on', () => {
      renderBar({ ctrl: false, shift: true })
      expandSecondaryRow()
      const btn = screen.getByRole('button', { name: 'Shift modifier' })
      expect(btn.className).toContain('bg-[#268bd2]')
    })
  })

  describe('repeat timer', () => {
    it('sends immediately, then repeats after 400ms delay at 80ms intervals', () => {
      renderBar()
      touchButton('→')
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[C')

      vi.advanceTimersByTime(399)
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(80)
      expect(sendInput).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(80)
      expect(sendInput).toHaveBeenCalledTimes(3)
    })

    it('PgUp/PgDn are repeatable', () => {
      renderBar()
      touchButton('PgU')
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(480)
      expect(sendInput).toHaveBeenCalledTimes(2)
    })

    it('does not repeat for non-repeatable keys', () => {
      renderBar()
      touchButton('Esc')
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1000)
      expect(sendInput).toHaveBeenCalledTimes(1)
    })
  })

  describe('repeat cleanup', () => {
    it('touchEnd clears all timers', () => {
      renderBar()
      const btn = touchButton('↑')
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(500)
      const countAfterRepeat = (sendInput as unknown as { mock: { calls: unknown[] } }).mock.calls.length

      fireEvent.touchEnd(btn)

      vi.advanceTimersByTime(1000)
      expect(sendInput).toHaveBeenCalledTimes(countAfterRepeat)
    })

    it('touchEnd before repeat delay prevents any repeats', () => {
      renderBar()
      const btn = touchButton('←')
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(200)
      fireEvent.touchEnd(btn)

      vi.advanceTimersByTime(1000)
      expect(sendInput).toHaveBeenCalledTimes(1)
    })
  })
})
