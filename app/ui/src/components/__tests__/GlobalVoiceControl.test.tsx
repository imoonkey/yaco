// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GlobalVoiceControl, type VoiceInstance } from '../GlobalVoiceControl'
import type { CapabilityState, InteractionState } from '../../hooks/useVoice'

const READY: CapabilityState = { status: 'ready', maxUploadBytes: 1_000_000 }

const EDITOR_A: VoiceInstance = { kind: 'editor', instanceId: 'editor', label: 'a.ts', filePath: 'a.ts' }
const EDITOR_B: VoiceInstance = { kind: 'editor', instanceId: 'editor:2', label: 'b.ts', filePath: 'b.ts' }
const TERM: VoiceInstance = { kind: 'terminal', instanceId: 'terminal', label: 's1', sessionName: 's1' }

let onSelect: (inst: VoiceInstance) => void
let onRecord: () => void
let onStop: () => void

beforeEach(() => {
  onSelect = vi.fn<(inst: VoiceInstance) => void>()
  onRecord = vi.fn<() => void>()
  onStop = vi.fn<() => void>()
})
afterEach(cleanup)

function renderControl(over: Partial<Parameters<typeof GlobalVoiceControl>[0]> = {}) {
  const props = {
    capability: READY,
    state: 'idle' as InteractionState,
    target: EDITOR_A,
    instances: [EDITOR_A, EDITOR_B, TERM],
    locked: false,
    onSelect, onRecord, onStop,
    ...over,
  }
  return render(<GlobalVoiceControl {...props} />)
}

describe('GlobalVoiceControl', () => {
  it('shows the current target label and an enabled mic when idle', () => {
    renderControl()
    expect(screen.getByRole('button', { name: 'Voice target: a.ts' })).toBeTruthy()
    const mic = screen.getByRole('button', { name: 'Start voice recording' })
    expect((mic as HTMLButtonElement).disabled).toBe(false)
  })

  it('records into the target when the mic is clicked while idle', () => {
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Start voice recording' }))
    expect(onRecord).toHaveBeenCalledTimes(1)
  })

  it('opens the dropdown and selects an instance', () => {
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Voice target: a.ts' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'b.ts' }))
    expect(onSelect).toHaveBeenCalledWith(EDITOR_B)
  })

  it('marks the current target as checked in the dropdown', () => {
    renderControl({ target: TERM })
    fireEvent.click(screen.getByRole('button', { name: 'Voice target: s1' }))
    expect(screen.getByRole('menuitemradio', { name: 's1' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'a.ts' }).getAttribute('aria-checked')).toBe('false')
  })

  it('stops the take when the mic is clicked while recording', () => {
    renderControl({ state: 'recording' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onRecord).not.toHaveBeenCalled()
  })

  it('locks the target dropdown while a take is in flight', () => {
    renderControl({ state: 'recording', locked: true })
    const chip = screen.getByRole('button', { name: 'Voice target: a.ts' }) as HTMLButtonElement
    expect(chip.disabled).toBe(true)
    fireEvent.click(chip)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does nothing on a mic click while processing', () => {
    renderControl({ state: 'transcribing' })
    const mic = screen.getByRole('button', { name: 'Voice processing' })
    fireEvent.click(mic)
    expect(onRecord).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('disables the mic and dropdown when nothing is eligible', () => {
    renderControl({ target: null, instances: [] })
    expect((screen.getByRole('button', { name: 'Start voice recording' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'No voice target' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the mic when the voice capability is unavailable', () => {
    renderControl({ capability: { status: 'unavailable', reason: 'server', message: 'down' } })
    expect((screen.getByRole('button', { name: 'Start voice recording' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
