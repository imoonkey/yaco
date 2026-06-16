// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GlobalVoiceControl, type VoiceInstance } from '../GlobalVoiceControl'
import type { CapabilityState, InteractionState } from '../../hooks/useVoice'

const READY: CapabilityState = { status: 'ready', maxUploadBytes: 1_000_000 }

const EDITOR_A: VoiceInstance = { kind: 'editor', instanceId: 'editor', label: 'a.ts', filePath: 'a.ts' }

let onRecord: () => void
let onStop: () => void

beforeEach(() => {
  onRecord = vi.fn<() => void>()
  onStop = vi.fn<() => void>()
})
afterEach(cleanup)

function renderControl(over: Partial<Parameters<typeof GlobalVoiceControl>[0]> = {}) {
  const props = {
    capability: READY,
    state: 'idle' as InteractionState,
    target: EDITOR_A,
    onRecord, onStop,
    ...over,
  }
  return render(<GlobalVoiceControl {...props} />)
}

describe('GlobalVoiceControl — the nav mic', () => {
  it('shows an enabled mic when idle with a target', () => {
    renderControl()
    const mic = screen.getByRole('button', { name: 'Start voice recording' })
    expect((mic as HTMLButtonElement).disabled).toBe(false)
  })

  it('records into the target when the mic is clicked while idle', () => {
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Start voice recording' }))
    expect(onRecord).toHaveBeenCalledTimes(1)
  })

  it('stops the take when the mic is clicked while recording', () => {
    renderControl({ state: 'recording' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onRecord).not.toHaveBeenCalled()
  })

  it('does nothing on a mic click while processing', () => {
    renderControl({ state: 'transcribing' })
    fireEvent.click(screen.getByRole('button', { name: 'Voice processing' }))
    expect(onRecord).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('disables the mic when no target is eligible', () => {
    renderControl({ target: null })
    expect((screen.getByRole('button', { name: 'Start voice recording' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the mic when the voice capability is unavailable', () => {
    renderControl({ capability: { status: 'unavailable', reason: 'server', message: 'down' } })
    expect((screen.getByRole('button', { name: 'Start voice recording' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
