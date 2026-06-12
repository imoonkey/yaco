// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionItem } from '../WorkspaceSessionList'
import type { AgentSession } from '../../types'
import type { AttentionBadge } from '../../hooks/useAttention'

afterEach(cleanup)

function makeSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    name: 'sess',
    provider: 'codex',
    status: 'idle',
    project: 'proj',
    summary: '',
    ...over,
  }
}

function baseProps() {
  return {
    isActive: false,
    onClick: vi.fn(),
    onKill: vi.fn(),
  }
}

describe('SessionItem — attention surfaces', () => {
  it('renders a rollup badge with the tier color on a collapsed parent', () => {
    const badge: AttentionBadge = { count: 3, color: 'red' }
    const { container } = render(
      <SessionItem {...baseProps()} session={makeSession({ name: 'parent' })} hasChildren collapsed rollupBadge={badge} />,
    )
    expect(screen.getByText('3')).toBeTruthy()
    // Status dot stays self-only (idle = base1), never recolored to the rollup tier.
    const dot = container.querySelector('span[aria-label="idle"]')
    expect(dot?.className).toContain('bg-[var(--sol-base1)]')
    expect(dot?.className).not.toContain('--sol-red')
  })

  it('shows the "↩ your turn" chip on an owned-idle leaf without recoloring the dot', () => {
    const { container } = render(
      <SessionItem {...baseProps()} session={makeSession({ name: 'mine', status: 'idle' })} yourTurn />,
    )
    expect(screen.getByText('your turn')).toBeTruthy()
    const dot = container.querySelector('span[aria-label="idle"]')
    expect(dot?.className).toContain('bg-[var(--sol-base1)]')
  })

  it('delegated-idle leaf (no yourTurn, no badge) shows neither chip nor badge', () => {
    render(<SessionItem {...baseProps()} session={makeSession({ name: 'theirs' })} />)
    expect(screen.queryByText('your turn')).toBeNull()
  })
})

describe('SessionItem — mark subtree read', () => {
  it('offers "Mark subtree read" in a parent session context menu and invokes the handler', () => {
    const onMarkSubtreeRead = vi.fn()
    const { container } = render(
      <SessionItem
        {...baseProps()}
        session={makeSession({ name: 'parent' })}
        hasChildren
        onRename={vi.fn()}
        onMarkSubtreeRead={onMarkSubtreeRead}
      />,
    )
    fireEvent.contextMenu(container.firstChild as Element)
    const item = screen.getByRole('menuitem', { name: 'Mark subtree read' })
    fireEvent.click(item)
    expect(onMarkSubtreeRead).toHaveBeenCalledTimes(1)
  })

  it('omits "Mark subtree read" for a leaf session (no children)', () => {
    const { container } = render(
      <SessionItem
        {...baseProps()}
        session={makeSession({ name: 'leaf' })}
        onRename={vi.fn()}
        onMarkSubtreeRead={vi.fn()}
      />,
    )
    fireEvent.contextMenu(container.firstChild as Element)
    expect(screen.queryByRole('menuitem', { name: 'Mark subtree read' })).toBeNull()
  })
})
