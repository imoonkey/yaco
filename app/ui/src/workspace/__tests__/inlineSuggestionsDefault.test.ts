// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { DEFAULT_LAYOUT, layoutKey } from '../../hooks/workspaceTypes'
import { usePersistence } from '../../hooks/usePersistence'

describe('inline suggestions default', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { cleanup(); localStorage.clear() })

  it('ships disabled by default', () => {
    expect(DEFAULT_LAYOUT.autocompleteEnabled).toBe(false)
  })

  it('keeps the disabled default when no layout is persisted', () => {
    const { result } = renderHook(() => usePersistence('proj', '/repo/proj'))
    expect(result.current.initialLayout.layout.autocompleteEnabled).toBe(false)
  })

  it('restores an opted-in value from persisted layout', () => {
    localStorage.setItem(
      layoutKey('proj'),
      JSON.stringify({ layout: { ...DEFAULT_LAYOUT, autocompleteEnabled: true } }),
    )
    const { result } = renderHook(() => usePersistence('proj', '/repo/proj'))
    expect(result.current.initialLayout.layout.autocompleteEnabled).toBe(true)
  })
})
