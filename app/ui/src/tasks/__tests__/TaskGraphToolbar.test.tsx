// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskGraphToolbar } from '../TaskGraphToolbar'
import type { TaskState } from '../taskGraphModel'
import type { Workset } from '../useTaskGraphInteraction'

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  useIsWideViewport: () => true,
}))

afterEach(cleanup)

function renderToolbar() {
  return render(
    <TaskGraphToolbar
      layout="stacked"
      stateFilters={new Set<TaskState>(['ready', 'running', 'done', 'blocked', 'cancelled'])}
      worksets={new Set<Workset>(['active', 'backlog'])}
      searchQuery=""
      searchMatchCount={0}
      allCollapsed={false}
      allExpanded={false}
      onSetLayout={vi.fn()}
      onToggleState={vi.fn()}
      onToggleWorkset={vi.fn()}
      onSearchChange={vi.fn()}
      onSearchSubmit={vi.fn()}
      onCollapseAll={vi.fn()}
      onExpandAll={vi.fn()}
    />,
  )
}

describe('TaskGraphToolbar shortcuts', () => {
  it('focuses task search when slash is pressed outside text entry', () => {
    renderToolbar()

    const search = screen.getByPlaceholderText('Search tasks...')
    fireEvent.keyDown(document, { key: '/', bubbles: true, cancelable: true })

    expect(document.activeElement).toBe(search)
  })

  it('does not steal slash from a focused textarea', () => {
    renderToolbar()

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()

    const allowedDefault = fireEvent.keyDown(textarea, { key: '/', bubbles: true, cancelable: true })

    expect(allowedDefault).toBe(true)
    expect(document.activeElement).toBe(textarea)
    textarea.remove()
  })
})
