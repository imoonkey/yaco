// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectList } from '../ProjectList'
import type { AttentionBadge } from '../../hooks/useAttention'

afterEach(cleanup)

function renderList(
  badgesByProject: Record<string, AttentionBadge>,
  sessionCounts: Record<string, { active: number; total: number }> = {},
  onSelect = vi.fn(),
) {
  const view = render(
    <ProjectList
      projects={[{ name: 'alpha', path: '/alpha' }]}
      activeProject="alpha"
      badgesByProject={badgesByProject}
      projectSessionCounts={sessionCounts}
      onSelect={onSelect}
      onReorder={vi.fn()}
      onRemove={vi.fn()}
      onMarkAllRead={vi.fn()}
    />,
  )
  return { ...view, onSelect }
}

describe('ProjectList — attention badge vs status counts', () => {
  it('shows the actionable badge with the tier color', () => {
    const { container } = renderList({ alpha: { count: 2, color: 'red' } })
    const badge = screen.getByText('2')
    expect(badge).toBeTruthy()
    expect((badge as HTMLElement).style.backgroundColor).toContain('--sol-red')
    expect(container).toBeTruthy()
  })

  it('renders the actionable badge SEPARATELY from the active/total status count', () => {
    renderList({ alpha: { count: 1, color: 'orange' } }, { alpha: { active: 1, total: 3 } })
    expect(screen.getByText('1')).toBeTruthy()       // attention badge
    expect(screen.getByText('1/3')).toBeTruthy()      // status count (distinct indicator)
  })

  it('shows no badge when the project has no attention', () => {
    renderList({}, { alpha: { active: 0, total: 2 } })
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getByText('0/2')).toBeTruthy()
  })
})

describe('ProjectList — projects only (worktrees moved to the Files header, §P2)', () => {
  it('renders no worktree rows under a project (the sub-list is gone)', () => {
    const { container } = renderList({}, { alpha: { active: 0, total: 0 } })
    // The worktree sub-rows used a GitBranch glyph; no worktree affordance remains.
    expect(container.querySelector('.lucide-git-branch')).toBeNull()
  })

  it('clicking the active project re-selects it instead of resetting a worktree', () => {
    const { onSelect } = renderList({}, {})
    fireEvent.click(screen.getByText('alpha'))
    // Old behavior reset the worktree on active-project click; now it just selects.
    expect(onSelect).toHaveBeenCalledWith('alpha')
  })
})
