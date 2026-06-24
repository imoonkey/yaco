// @vitest-environment jsdom
//
// Unit tests for the shared-buffer GC (mi-state, design §B). They pin the keep
// rule directly on useFileState: a buffer survives iff some open view still
// references it OR it is dirty — so a structural close never silently loses
// unsaved work, and a clean unreferenced buffer is reclaimed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

// useFileState wires useSSERefresh (opens an EventSource jsdom lacks). Stub it.
vi.mock('../useSSE', () => ({
  useSSERefresh: () => {},
  addSSEListener: () => () => {},
}))

import { useFileState } from '../useFileState'

beforeEach(() => {
  // No tabs open → nothing fetches; stub defensively so nothing escapes.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mountFileState() {
  const openTabsRef = { current: [] as string[] }
  return renderHook(() => useFileState('proj', '/repo/proj', null, {}, [], openTabsRef))
}

describe('gcBuffers keep rule', () => {
  it('keeps a referenced clean buffer and keeps every dirty buffer; drops a clean unreferenced one', () => {
    const { result } = mountFileState()

    // A dirty buffer (a draft) and a clean buffer (a viewport-only entry).
    act(() => { result.current.updateDraft('dirty.ts', 'edited') })
    act(() => { result.current.updateViewport('clean.ts', 5) })
    expect(result.current.files['dirty.ts'].status).toBe('dirty')
    expect(result.current.files['clean.ts'].status).toBe('clean')

    // GC with only clean.ts referenced: clean.ts kept (referenced), dirty.ts kept (dirty).
    act(() => { result.current.gcBuffers(new Set(['clean.ts'])) })
    expect(result.current.files['clean.ts']).toBeDefined()
    expect(result.current.files['dirty.ts']).toBeDefined()

    // GC with NOTHING referenced: the clean buffer is reclaimed; the dirty buffer
    // survives — closing/reset never silently loses unsaved work (design §B).
    act(() => { result.current.gcBuffers(new Set()) })
    expect(result.current.files['clean.ts']).toBeUndefined()
    expect(result.current.files['dirty.ts']).toBeDefined()
  })

  it('is a no-op (same files ref) when nothing needs dropping', () => {
    const { result } = mountFileState()
    act(() => { result.current.updateViewport('a.ts', 2) })
    const before = result.current.files
    act(() => { result.current.gcBuffers(new Set(['a.ts'])) })
    expect(result.current.files).toBe(before) // referenced → unchanged reference
  })
})
