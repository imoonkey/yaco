// @vitest-environment jsdom
//
// FileSearch (quick-open) Cmd+Enter test (design §F): plain Enter previews the
// highlighted file via onSelect; Cmd+Enter on a FILE routes to onOpenToSide so
// the keyboard chord splits the active editor instead. Both close the overlay.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSearch } from '../WorkspaceSearch'
import type { SearchEntry } from '../../lib/fuzzySearch'

const FILE: SearchEntry = { name: 'a.ts', path: 'src/a.ts', type: 'file' }

// Serve the index synchronously from cache so no async fetch races the keydown.
vi.mock('../quickOpenIndex', () => ({
  getCached: () => [FILE],
  isCacheStale: () => false,
  fetchIndex: () => Promise.resolve([FILE]),
}))

// jsdom has no layout engine; the result-scroll effect calls scrollIntoView.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

function renderSearch() {
  const onSelect = vi.fn()
  const onOpenToSide = vi.fn()
  const onClose = vi.fn()
  render(
    <FileSearch
      projectName="p"
      recentFiles={[FILE.path]}
      onSelect={onSelect}
      onOpenToSide={onOpenToSide}
      onClose={onClose}
    />,
  )
  // Empty query → the one recent file is highlighted at index 0.
  const input = screen.getByPlaceholderText('Search files...') as HTMLInputElement
  return { onSelect, onOpenToSide, onClose, input }
}

describe('FileSearch — quick-open Cmd+Enter open-to-side', () => {
  it('Cmd+Enter opens the highlighted file to the side (not preview) and closes', () => {
    const { onSelect, onOpenToSide, onClose, input } = renderSearch()
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', metaKey: true })
    expect(onOpenToSide).toHaveBeenCalledWith(FILE)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('plain Enter still previews the file via onSelect', () => {
    const { onSelect, onOpenToSide, onClose, input } = renderSearch()
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(FILE)
    expect(onOpenToSide).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
