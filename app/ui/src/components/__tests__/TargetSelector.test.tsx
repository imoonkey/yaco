// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TargetSelector } from '../TargetSelector'
import type { VoiceInstance } from '../GlobalVoiceControl'

const EDITOR_A: VoiceInstance = { kind: 'editor', instanceId: 'editor', label: 'a.ts', filePath: 'a.ts' }
const EDITOR_B: VoiceInstance = { kind: 'editor', instanceId: 'editor:2', label: 'b.ts', filePath: 'b.ts' }
const TERM: VoiceInstance = { kind: 'terminal', instanceId: 'terminal', label: 's1', sessionName: 's1' }

let onSelect: (inst: VoiceInstance) => void

beforeEach(() => { onSelect = vi.fn<(inst: VoiceInstance) => void>() })
afterEach(cleanup)

function renderSelector(over: Partial<Parameters<typeof TargetSelector>[0]> = {}) {
  const props = {
    target: EDITOR_A as VoiceInstance | null,
    instances: [EDITOR_A, EDITOR_B, TERM],
    disabled: false,
    onSelect,
    ...over,
  }
  return render(<TargetSelector {...props} />)
}

describe('TargetSelector — the tray target dropdown', () => {
  it('shows the current target label', () => {
    renderSelector()
    expect(screen.getByRole('button', { name: 'Insert target: a.ts' })).toBeTruthy()
  })

  it('opens the dropdown and selects another instance', () => {
    renderSelector()
    fireEvent.click(screen.getByRole('button', { name: 'Insert target: a.ts' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'b.ts' }))
    expect(onSelect).toHaveBeenCalledWith(EDITOR_B)
  })

  it('marks the current target as checked', () => {
    renderSelector({ target: TERM })
    fireEvent.click(screen.getByRole('button', { name: 'Insert target: s1' }))
    expect(screen.getByRole('menuitemradio', { name: 's1' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'a.ts' }).getAttribute('aria-checked')).toBe('false')
  })

  it('locks the dropdown while a take is in flight', () => {
    renderSelector({ disabled: true })
    const btn = screen.getByRole('button', { name: 'Insert target: a.ts' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes an open menu when a take starts (disabled flips true)', () => {
    const { rerender } = renderSelector()
    fireEvent.click(screen.getByRole('button', { name: 'Insert target: a.ts' }))
    expect(screen.queryByRole('menu')).not.toBeNull()
    rerender(<TargetSelector target={EDITOR_A} instances={[EDITOR_A, EDITOR_B, TERM]} disabled onSelect={onSelect} />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows "No target" and disables the button when nothing is eligible', () => {
    renderSelector({ target: null, instances: [] })
    expect((screen.getByRole('button', { name: 'No insert target' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
