// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskGraphNode } from '../TaskGraphNode'
import { EMPTY_HIGHLIGHT } from '../taskGraphSelection'
import { NODE_HEIGHT, type LayoutNode, type TaskGraphTask } from '../taskGraphModel'

afterEach(cleanup)

function node(): LayoutNode {
  return { id: 'T1', x: 0, y: 0, width: 200, height: NODE_HEIGHT, parentId: null, hasChildren: false, depth: 0 }
}

function task(over: Partial<TaskGraphTask> = {}): TaskGraphTask {
  return {
    id: 'T1', title: 'Build it', description: null, parent: null, depends: [],
    state: 'ready', scope: [], acceptCriteria: [], note: null, depth: 0,
    hasChildren: false, worktree: null, estimate: null, workset: 'active',
    priority: 'normal', agents: [], tags: [],
    ...over,
  }
}

function renderNode(props: { isAttentionBlocked?: boolean; isAttentionDone?: boolean; taskOver?: Partial<TaskGraphTask> }) {
  return render(
    <svg>
      <TaskGraphNode
        node={node()}
        task={task(props.taskOver)}
        highlight={EMPTY_HIGHLIGHT}
        isSelected={false}
        isSearchMatch={false}
        isLinkedToActiveSession={false}
        isAttentionBlocked={props.isAttentionBlocked ?? false}
        isAttentionDone={props.isAttentionDone ?? false}
        isCollapsed={false}
        depCount={0}
        scale={1}
        onClick={vi.fn()}
        onOpen={vi.fn()}
        onToggleCollapse={vi.fn()}
        onPointerEnter={vi.fn()}
        onPointerLeave={vi.fn()}
      />
    </svg>,
  )
}

describe('TaskGraphNode — attention chips', () => {
  it('renders a blocked chip for a task_blocked in needs-you', () => {
    const { container } = renderNode({ isAttentionBlocked: true })
    const chip = container.querySelector('[data-attention="blocked"]')
    expect(chip).toBeTruthy()
    expect(chip?.querySelector('circle')?.getAttribute('fill')).toBe('var(--sol-red)')
  })

  it('renders a done chip for a task_done in ready/recent', () => {
    const { container } = renderNode({ isAttentionDone: true, taskOver: { state: 'done' } })
    const chip = container.querySelector('[data-attention="done"]')
    expect(chip).toBeTruthy()
    expect(chip?.querySelector('circle')?.getAttribute('fill')).toBe('var(--sol-green)')
  })

  it('shows no attention chip when neither flag is set', () => {
    const { container } = renderNode({})
    expect(container.querySelector('[data-attention]')).toBeNull()
  })

  it('blocked outranks done when both are set', () => {
    const { container } = renderNode({ isAttentionBlocked: true, isAttentionDone: true })
    expect(container.querySelector('[data-attention="blocked"]')).toBeTruthy()
    expect(container.querySelector('[data-attention="done"]')).toBeNull()
  })
})
