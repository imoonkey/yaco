// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShortcutSheet } from '../ShortcutSheet'

afterEach(cleanup)

function keysFor(label: string): string | null | undefined {
  return screen.getByText(label).parentElement?.querySelector('kbd')?.textContent
}

describe('ShortcutSheet', () => {
  it('shows the current workspace and task graph shortcuts', () => {
    render(<ShortcutSheet onClose={vi.fn()} />)

    const meta = navigator.platform.startsWith('Mac') ? '⌘' : 'Meta'
    const ctrl = navigator.platform.startsWith('Mac') ? '⌃' : 'Ctrl'
    const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'

    expect(keysFor('Switch project')).toBe(`${meta} 1–9`)
    expect(keysFor('Switch session')).toBe(`${meta} ${ctrl} 1–9`)
    expect(keysFor('Save')).toBe(`${mod} S`)
    expect(keysFor('Collapse all')).toBe('⇧ C')
    expect(keysFor('Expand all')).toBe('⇧ E')
    expect(keysFor('Search tasks')).toBe('/')
    expect(keysFor('Cycle editor view')).toBe(`${meta} ⇧ V`)
    expect(screen.getByText('Prev / next editor tab')).toBeTruthy()
    expect(screen.getByText('Open selected file to side')).toBeTruthy()
    expect(screen.queryByText('Zoom in / out / reset')).toBeNull()
  })
})
