// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
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
