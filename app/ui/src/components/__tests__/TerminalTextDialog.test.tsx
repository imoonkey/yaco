// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const { writeTextToClipboard } = vi.hoisted(() => ({ writeTextToClipboard: vi.fn() }))
vi.mock('../../lib/clipboard', () => ({ writeTextToClipboard }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { TerminalTextDialog } from '../TerminalTextDialog'

function mockFetch(response: { ok: boolean; status?: number; body: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const textareaValue = () => (screen.getByRole('textbox', { name: 'Terminal text' }) as HTMLTextAreaElement).value

beforeEach(() => {
  writeTextToClipboard.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TerminalTextDialog', () => {
  it('shows the session pane text in a keyboard-less textarea', async () => {
    const fetchMock = mockFetch({ ok: true, body: { text: '$ ls\nREADME.md' } })
    render(<TerminalTextDialog sessionName="shell-1" onClose={() => {}} />)

    await waitFor(() => expect(textareaValue()).toBe('$ ls\nREADME.md'))
    const textarea = screen.getByRole('textbox', { name: 'Terminal text' }) as HTMLTextAreaElement
    expect(textarea.readOnly).toBe(false)
    expect(textarea.inputMode).toBe('none')
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/shell-1/text', expect.anything())
  })

  it('copies the whole buffer and closes', async () => {
    mockFetch({ ok: true, body: { text: 'hello' } })
    writeTextToClipboard.mockResolvedValue(true)
    const onClose = vi.fn()
    render(<TerminalTextDialog sessionName="worker" onClose={onClose} />)

    const copy = screen.getByRole('button', { name: 'Copy all' })
    await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copy)

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(writeTextToClipboard).toHaveBeenCalledWith('hello')
  })

  it('copies the scratch copy as edited, not the original capture', async () => {
    mockFetch({ ok: true, body: { text: 'noise\nkeep' } })
    writeTextToClipboard.mockResolvedValue(true)
    render(<TerminalTextDialog sessionName="worker" onClose={() => {}} />)

    await waitFor(() => expect(textareaValue()).toBe('noise\nkeep'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal text' }), { target: { value: 'keep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }))

    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalledWith('keep'))
  })

  it('keeps the dialog open when the clipboard write fails', async () => {
    mockFetch({ ok: true, body: { text: 'hello' } })
    writeTextToClipboard.mockResolvedValue(false)
    const onClose = vi.fn()
    render(<TerminalTextDialog sessionName="worker" onClose={onClose} />)

    const copy = screen.getByRole('button', { name: 'Copy all' })
    await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copy)

    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports a failed capture instead of showing empty text', async () => {
    mockFetch({ ok: false, status: 500, body: { error: "can't find session" } })
    render(<TerminalTextDialog sessionName="gone" onClose={() => {}} />)

    expect((await screen.findByRole('alert')).textContent).toBe("can't find session")
    expect((screen.getByRole('button', { name: 'Copy all' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
