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

  it('renders the notice as line-2 content alongside the location', () => {
    const snapshot = makeSnapshot({
      needsYou: [sessionItem({ project: 'demo', sessionName: 'worker', title: 'Has a question', message: 'Ship v1 or wait for review?' })],
      global: { count: 1, color: 'orange' },
    })
    render(<NotificationBell {...makeProps(snapshot)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Has a question')).toBeTruthy()
    // Line 2 is the location PLUS the captured content — not the old redundant
    // `project · name` template repeated under the title.
    const line2 = screen.getByText((_t, el) => el?.textContent === 'demo / worker — Ship v1 or wait for review?')
    expect(line2).toBeTruthy()
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

  it("clicking a Needs-you row's ✕ dismisses that generation without navigating; the row body still routes", () => {
    const item = sessionItem({ project: 'p', sessionName: 'blocky', title: 'needs approval' })
    const props = makeProps(makeSnapshot({ needsYou: [item], global: { count: 1, color: 'orange' } }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))

    // The ✕ tombstones THIS generation and stops propagation, so it must not
    // also navigate the row it sits in.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(props.dismissNeedsYou).toHaveBeenCalledWith(item)
    expect(props.onItemClick).not.toHaveBeenCalled()

    // The row BODY still routes — and an ACT row never acks (dismiss is the only
    // way it leaves the badge; the condition itself self-resolves in live status).
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

  it('Mark all read is present in a Needs-you-only snapshot (Ready empty)', () => {
    // The capstone of the clearable-ACT axiom: the badge must be drivable to zero
    // even when nothing is Ready, so Mark-all-read surfaces on the Needs-you section.
    const props = makeProps(makeSnapshot({
      needsYou: [sessionItem({ project: 'p', sessionName: 'blocky', title: 'needs approval' })],
      global: { count: 1, color: 'orange' },
    }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Mark all read')).toBeTruthy()
  })

  it('Mark all read dismisses every Needs-you row by generation and acks each Ready row by subject (never ackProject)', () => {
    const blockedSession = sessionItem({ project: 'p1', sessionName: 'blocky', title: 'needs approval' })
    const blockedTask = taskItem({ project: 'p2', taskId: 'T9', type: 'task_blocked', tier: 'action', group: 'needs-you', title: 'task blocked' })
    const readyIdle = sessionItem({ project: 'p1', sessionName: 'idle1', group: 'ready', type: 'session_idle', tier: 'handoff', title: 'your turn' })
    const readyDone = taskItem({ project: 'p3', taskId: 'T1', title: 'task done' })
    const props = makeProps(makeSnapshot({
      needsYou: [blockedSession, blockedTask],
      ready: [readyIdle, readyDone],
      global: { count: 4, color: 'orange' },
    }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.click(screen.getByText('Mark all read'))

    // Every surfaced Needs-you (ACT) row is dismissed by ITS OWN generation.
    expect(props.dismissNeedsYou).toHaveBeenCalledTimes(2)
    expect(props.dismissNeedsYou).toHaveBeenCalledWith(blockedSession)
    expect(props.dismissNeedsYou).toHaveBeenCalledWith(blockedTask)
    // Every Ready (REVIEW) row is acked by its own subject — session vs task scope.
    expect(props.ackSession).toHaveBeenCalledWith('p1', 'idle1')
    expect(props.ackTask).toHaveBeenCalledWith('p3', 'T1')
    // It deliberately does NOT advance a project-level read watermark — that could
    // pre-suppress a delegated block that escalates later (design r1 MAJOR-3).
    expect(props.ackProject).not.toHaveBeenCalled()
  })

  it('a task block and its bound blocked session render as two independent rows, each ✕ dismissing its own generation (no fold)', () => {
    // The pair is genuinely bound — the task lists the blocked worker in
    // sessionNames — yet the panel renders TWO rows, not one folded row.
    const blockedTask = taskItem({
      project: 'p', taskId: 'uxr',
      type: 'task_blocked', tier: 'action', group: 'needs-you', title: 'task blocked',
      generation: 'task_blocked:p::uxr:T1',
      subject: { kind: 'task', project: 'p', taskId: 'uxr', sessionNames: ['worker'] },
    })
    const blockedSession = sessionItem({
      project: 'p', sessionName: 'worker', title: 'needs approval',
      generation: 'session_blocked:p::worker:T1',
    })
    const props = makeProps(makeSnapshot({ needsYou: [blockedTask, blockedSession] }))
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))

    // Two distinct rows, each with its own dismiss control (no fold to one count).
    expect(screen.getByText('task blocked')).toBeTruthy()
    expect(screen.getByText('needs approval')).toBeTruthy()
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' })
    expect(dismissButtons).toHaveLength(2)

    // Each ✕ dismisses ITS OWN generation — the task and worker clear independently.
    fireEvent.click(dismissButtons[0])
    expect(props.dismissNeedsYou).toHaveBeenNthCalledWith(1, expect.objectContaining({ generation: 'task_blocked:p::uxr:T1' }))
    fireEvent.click(dismissButtons[1])
    expect(props.dismissNeedsYou).toHaveBeenNthCalledWith(2, expect.objectContaining({ generation: 'session_blocked:p::worker:T1' }))
    expect(props.dismissNeedsYou).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state when the snapshot has no items', () => {    render(<NotificationBell {...makeProps(makeSnapshot())} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Nothing needs you')).toBeTruthy()
    // No Clear when there is nothing recent.
    expect(screen.queryByText('Clear')).toBeNull()
  })
})
