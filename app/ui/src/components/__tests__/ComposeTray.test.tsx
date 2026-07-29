// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposeTray } from '../ComposeTray'
import type { InteractionState, VoiceProvider } from '../../hooks/useVoice'

afterEach(cleanup)

function renderTray(over: Partial<Parameters<typeof ComposeTray>[0]> = {}) {
  const props = {
    target: null,
    instances: [],
    onSelectTarget: vi.fn(),
    state: 'composing' as InteractionState,
    elapsedMs: 0,
    appendText: null,
    capability: { status: 'ready' as const, maxUploadBytes: 20_000_000 },
    availableProviders: ['codex', 'groq'] as VoiceProvider[],
    provider: 'codex' as VoiceProvider,
    onProviderChange: vi.fn(),
    formatterAvailable: true,
    autoFormat: true,
    onAutoFormatChange: vi.fn(),
    errorMessage: null,
    notice: null,
    onRecord: vi.fn(),
    onStop: vi.fn(),
    onConfirm: vi.fn(),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onFormat: vi.fn(async (text: string) => ({ text, ok: true })),
    ...over,
  }
  return { ...render(<ComposeTray {...props} />), props }
}

describe('ComposeTray voice preferences', () => {
  it('shows only available providers and reports explicit selection', () => {
    const { props } = renderTray({ availableProviders: ['groq'], provider: 'groq' })

    const select = screen.getByRole('combobox', { name: 'Transcription provider' })
    expect(screen.queryByRole('option', { name: 'Codex' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Groq' })).toBeTruthy()
    fireEvent.change(select, { target: { value: 'groq' } })
    expect(props.onProviderChange).toHaveBeenCalledWith('groq')
  })

  it.each(['requesting_permission', 'recording', 'transcribing'] as InteractionState[])(
    'disables both preferences while %s',
    (state) => {
      renderTray({ state })
      expect((screen.getByRole('combobox', { name: 'Transcription provider' }) as HTMLSelectElement).disabled).toBe(true)
      expect((screen.getByRole('checkbox', { name: 'Auto format' }) as HTMLInputElement).disabled).toBe(true)
    },
  )

  it('enables provider selection and auto-format after an error', () => {
    renderTray({ state: 'error', errorMessage: 'Transcription failed.' })
    expect((screen.getByRole('combobox', { name: 'Transcription provider' }) as HTMLSelectElement).disabled).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'Auto format' }) as HTMLInputElement).disabled).toBe(false)
  })

  it('disables unavailable formatting controls with an honest explanation', () => {
    renderTray({ formatterAvailable: false, autoFormat: false })
    fireEvent.change(screen.getByRole('textbox', { name: 'Compose input' }), { target: { value: 'draft' } })

    const autoFormat = screen.getByRole('checkbox', { name: 'Auto format' }) as HTMLInputElement
    const format = screen.getByRole('button', { name: 'Format' }) as HTMLButtonElement
    expect(autoFormat.disabled).toBe(true)
    expect(format.disabled).toBe(true)
    expect(format.title).toBe('Formatter unavailable')
  })
})
