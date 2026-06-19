// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from '../NotificationBell'
import type { AttentionItem, AttentionSnapshot } from '../../hooks/useAttention'

afterEach(cleanup)

function sessionItem(over: Partial<AttentionItem> & { project: string; sessionName: string }): AttentionItem {
  const { project, sessionName, ...rest } = over
  return {
    generation: `${project}::${sessionName}:0`,
    type: 'session_blocked',
    tier: 'action',
    group: 'needs-you',
    subject: { kind: 'session', project, sessionName },
    title: 'needs approval',
    message: '',
    tsMs: Date.now(),
    count: 1,
    interrupt: false,
    ...rest,
  }
}

function taskItem(over: Partial<AttentionItem> & { project: string; taskId: string }): AttentionItem {
  const { project, taskId, ...rest } = over
  return {
    generation: `${project}::${taskId}:0`,
    type: 'task_done',
    tier: 'handoff',
    group: 'ready',
    subject: { kind: 'task', project, taskId, sessionNames: [] },
    title: 'task done',
    message: '',
    tsMs: Date.now(),
    count: 1,
    interrupt: false,
    ...rest,
  }
}

function makeSnapshot(over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    needsYou: [],
    ready: [],
    recent: [],
    badgesByProject: {},
    badgesBySession: {},
    global: { count: 0, color: null },
    ...over,
  }
}

function makeProps(snapshot: AttentionSnapshot) {
  return {
    snapshot,
    onItemClick: vi.fn(),
    ackSession: vi.fn(),
    ackTask: vi.fn(),
    ackProject: vi.fn(),
    dismissNeedsYou: vi.fn(),
    clear: vi.fn(),
    requestPermission: vi.fn(),
  }
}

describe('NotificationBell', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('shows the global badge count + does NOT request permission on mount', () => {
    const requestPermission = vi.fn()
    render(
      <NotificationBell
        {...makeProps(makeSnapshot({ global: { count: 4, color: 'red' } }))}
        requestPermission={requestPermission}
      />,
    )
    expect(screen.getByText('4')).toBeTruthy()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('requests OS permission on the first bell interaction (user gesture)', () => {
    const props = makeProps(makeSnapshot())
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(props.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('renders the three sections from the snapshot', () => {
    const snapshot = makeSnapshot({
      needsYou: [sessionItem({ project: 'p', sessionName: 'crashy', type: 'session_crashed', tier: 'critical', title: 'crashed' })],
      ready: [taskItem({ project: 'p', taskId: 'T1' })],
      recent: [sessionItem({ project: 'p', sessionName: 'old', group: 'recent', tier: 'fyi', title: 'went idle' })],
    })
    render(<NotificationBell {...makeProps(snapshot)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText('Recent')).toBeTruthy()
  })

  it('clicking a Ready item acks it and routes via onItemClick', () => {
    const item = taskItem({ project: 'p', taskId: 'T7' })
    const props = makeProps(makeSnapshot({ ready: [item] }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(screen.getByText('task done'))
    expect(props.ackTask).toHaveBeenCalledWith('p', 'T7')
    expect(props.onItemClick).toHaveBeenCalledWith(item)
  })

  it('clicking a Needs-you item routes but does NOT ack (it self-resolves)', () => {
    const item = sessionItem({ project: 'p', sessionName: 'blocky', title: 'needs approval' })
    const props = makeProps(makeSnapshot({ needsYou: [item] }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(screen.getByText('needs approval'))
    expect(props.onItemClick).toHaveBeenCalledWith(item)
    expect(props.ackSession).not.toHaveBeenCalled()
    expect(props.ackTask).not.toHaveBeenCalled()
  })

  it('Clear calls clear() once per distinct project in Recent', () => {
    const props = makeProps(makeSnapshot({
      recent: [
        sessionItem({ project: 'p1', sessionName: 'a', group: 'recent', tier: 'fyi', title: 'idle a' }),
        sessionItem({ project: 'p1', sessionName: 'b', group: 'recent', tier: 'fyi', title: 'idle b' }),
        sessionItem({ project: 'p2', sessionName: 'c', group: 'recent', tier: 'fyi', title: 'idle c' }),
      ],
    }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(screen.getByText('Clear'))
    expect(props.clear).toHaveBeenCalledTimes(2)
    expect(props.clear).toHaveBeenCalledWith('p1')
    expect(props.clear).toHaveBeenCalledWith('p2')
  })

  it('Mark all read acks each distinct project in Ready and NOT the Needs-you ones (F5)', () => {
    const props = makeProps(makeSnapshot({
      needsYou: [
        // A blocked session in p3 — open ACT, no read concept; must not be acked.
        sessionItem({ project: 'p3', sessionName: 'blocky', title: 'needs approval' }),
      ],
      ready: [
        sessionItem({ project: 'p1', sessionName: 'a', group: 'ready', type: 'session_idle', tier: 'handoff', title: 'your turn a' }),
        taskItem({ project: 'p1', taskId: 'T1', title: 'task done T1' }),
        taskItem({ project: 'p2', taskId: 'T2', title: 'task done T2' }),
      ],
    }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(screen.getByText('Mark all read'))
    // One ackProject per distinct Ready project (p1 deduped across its 2 items).
    expect(props.ackProject).toHaveBeenCalledTimes(2)
    expect(props.ackProject).toHaveBeenCalledWith('p1')
    expect(props.ackProject).toHaveBeenCalledWith('p2')
    // Needs-you project p3 is never acked.
    expect(props.ackProject).not.toHaveBeenCalledWith('p3')
  })

  it('Mark all read is absent when Ready is empty', () => {
    const props = makeProps(makeSnapshot({
      needsYou: [sessionItem({ project: 'p', sessionName: 'blocky', title: 'needs approval' })],
    }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.queryByText('Mark all read')).toBeNull()
  })

  it('shows the empty state when the snapshot has no items', () => {    render(<NotificationBell {...makeProps(makeSnapshot())} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Nothing needs you')).toBeTruthy()
    // No Clear when there is nothing recent.
    expect(screen.queryByText('Clear')).toBeNull()
  })
})
