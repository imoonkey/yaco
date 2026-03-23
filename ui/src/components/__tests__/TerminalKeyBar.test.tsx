// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalKeyBar } from '../TerminalKeyBar'

let sendInput: ReturnType<typeof vi.fn>

beforeEach(() => {
  sendInput = vi.fn()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function touchButton(label: string) {
  const btn = screen.getByText(label)
  fireEvent.touchStart(btn)
  return btn
}

describe('TerminalKeyBar', () => {
  describe('PRIMARY_KEYS produce correct escape sequences', () => {
    it.each([
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['←', '\x1b[D'],
      ['↓', '\x1b[B'],
      ['↑', '\x1b[A'],
      ['→', '\x1b[C'],
      ['^C', '\x03'],
    ] as const)('%s sends correct sequence', (label, seq) => {
      render(<TerminalKeyBar sendInput={sendInput} />)
      touchButton(label)
      expect(sendInput).toHaveBeenCalledWith(seq)
    })
  })

  describe('SECONDARY_KEYS produce correct escape sequences', () => {
    it.each([
      ['^D', '\x04'],
      ['^Z', '\x1a'],
      ['^L', '\x0c'],
      ['^R', '\x12'],
      ['^A', '\x01'],
      ['^E', '\x05'],
      ['^W', '\x17'],
      ['^U', '\x15'],
    ] as const)('%s sends correct sequence', (label, seq) => {
      render(<TerminalKeyBar sendInput={sendInput} />)
      // expand secondary row
      fireEvent.click(screen.getByText('···'))
      touchButton(label)
      expect(sendInput).toHaveBeenCalledWith(seq)
    })
  })

  describe('expand/collapse', () => {
    it('toggles secondary row visibility on ··· click', () => {
      const { container } = render(<TerminalKeyBar sendInput={sendInput} />)
      const toggle = screen.getByText('···')
      const panel = container.querySelector(
        '.overflow-hidden',
      ) as HTMLElement

      expect(panel.style.maxHeight).toBe('0px')

      fireEvent.click(toggle)
      expect(panel.style.maxHeight).toBe('40px')

      fireEvent.click(toggle)
      expect(panel.style.maxHeight).toBe('0px')
    })
  })

  describe('repeat timer', () => {
    it('sends immediately, then repeats after 400ms delay at 80ms intervals', () => {
      render(<TerminalKeyBar sendInput={sendInput} />)
      touchButton('→')
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[C')

      // 399ms — no repeat yet
      vi.advanceTimersByTime(399)
      expect(sendInput).toHaveBeenCalledTimes(1)

      // at 400ms the interval starts but hasn't fired
      vi.advanceTimersByTime(1)
      expect(sendInput).toHaveBeenCalledTimes(1)

      // first interval tick at 480ms
      vi.advanceTimersByTime(80)
      expect(sendInput).toHaveBeenCalledTimes(2)

      // second tick at 560ms
      vi.advanceTimersByTime(80)
      expect(sendInput).toHaveBeenCalledTimes(3)
    })

    it('does not repeat for non-repeatable keys', () => {
      render(<TerminalKeyBar sendInput={sendInput} />)
      touchButton('Esc')
      expect(sendInput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1000)
      expect(sendInput).toHaveBeenCalledTimes(1)
    })
  })

  describe('repeat cleanup', () => {
    it('touchEnd clears all timers', () => {
      render(<TerminalKeyBar sendInput={sendInput} />)
      const btn = touchButton('↑')
      expect(sendInput).toHaveBeenCalledTimes(1)

      // let the repeat interval start
      vi.advanceTimersByTime(500)
      const countAfterRepeat = sendInput.mock.calls.length

      fireEvent.touchEnd(btn)

      // no more calls after touchEnd
      vi.advanceTimersByTime(1000)
      expect(sendInput).toHaveBeenCalledTimes(countAfterRepeat)
    })

    it('touchEnd before repeat delay prevents any repeats', () => {
      render(<TerminalKeyBar sendInput={sendInput} />)
      const btn = touchButton('←')
      expect(sendInput).toHaveBeenCalledTimes(1)

      // release before the 400ms delay
      vi.advanceTimersByTime(200)
      fireEvent.touchEnd(btn)

      vi.advanceTimersByTime(1000)
      expect(sendInput).toHaveBeenCalledTimes(1)
    })
  })
})
