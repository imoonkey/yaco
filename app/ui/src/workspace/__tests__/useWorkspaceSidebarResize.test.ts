// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import { useWorkspaceSidebarResize } from '../useWorkspaceSidebarResize'
import type { WorkspaceLayout } from '../../hooks/workspaceTypes'

const baseLayout: WorkspaceLayout = {
  showSidebar: true,
  showRightPanel: true,
  showProjects: true,
  showExplorer: true,
  showSessions: true,
  showChanges: true,
  showTasks: false,
  showTextSearch: false,
  autocompleteEnabled: false,
  previewMode: 'edit',
  splitDirection: 'horizontal',
  splitSize: 50,
  leftSize: 240,
  rightSize: 600,
  explorerSize: 200,
  searchSize: 200,
  changesSize: 200,
  sessionSize: 200,
  projectSize: 120,
}

function renderResize(viewportWidth: number, layout: WorkspaceLayout = baseLayout) {
  Object.defineProperty(window, 'innerWidth', { value: viewportWidth, writable: true, configurable: true })
  return renderHook(() => {
    const sidebarRef = useRef<HTMLDivElement | null>(null)
    return useWorkspaceSidebarResize({
      layout,
      sidebarRef,
      showProjects: layout.showProjects,
      showExplorer: layout.showExplorer,
      showChanges: layout.showChanges,
      showTasks: layout.showTasks,
      showSessions: layout.showSessions,
      updateLayout: () => {},
    })
  })
}

afterEach(() => {
  cleanup()
})

describe('useWorkspaceSidebarResize — right panel max', () => {
  it('allows the right panel to grow past the old 900px cap on wide monitors', () => {
    const { result } = renderResize(2400)
    // Old hardcoded max was 900 — try 1500
    act(() => { result.current.right.setSize(1500) })
    expect(result.current.right.size).toBe(1500)
  })

  it('clamps right panel to viewport - sidebar - 200px editor reserve', () => {
    const { result } = renderResize(1200)
    // sidebar = 240, editor reserve = 200 → max = 760
    act(() => { result.current.right.setSize(2000) })
    expect(result.current.right.size).toBe(760)
  })

  it('respects the 250px minimum', () => {
    const { result } = renderResize(2000)
    act(() => { result.current.right.setSize(100) })
    expect(result.current.right.size).toBe(250)
  })

  it('re-clamps right panel when viewport shrinks via window resize', () => {
    const { result } = renderResize(2400)
    act(() => { result.current.right.setSize(1500) })
    expect(result.current.right.size).toBe(1500)

    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    // 1000 - 240 sidebar - 200 reserve = 560
    expect(result.current.right.size).toBe(560)
  })
})
