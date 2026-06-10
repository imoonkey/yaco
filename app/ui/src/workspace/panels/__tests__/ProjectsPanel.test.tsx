// @vitest-environment jsdom
//
// ProjectsPanel isolation test — render the panel inside a MOCK env provider and
// assert it reproduces the SAME DOM/behavior as the former inline `Projects`
// section (the `projectListBody` + `projectActions` in WorkspaceScreen). The
// mock-provider helper is inlined and ProjectsPanel-prefixed so it never collides
// with the other panels sharing this `__tests__/` directory.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ProjectList } from '../../../components/ProjectList'
import { WorkspaceEnvContext, type WorkspaceEnv } from '../../context'
import type { PanelHeaderSlots } from '../../panelRegistry'
import type { WorktreeInfo } from '../../../hooks/useProjectWorktrees'
import { projectsPanelDef } from '../ProjectsPanel'

afterEach(cleanup)

const projectsTestWorktrees: WorktreeInfo[] = [
  { slug: 'feature-x', dirty: true, branch: 'feat/x', ahead: 2, behind: 0 },
]

// A full env so the body renders its rich DOM (active project, worktree
// sub-items, unread badge, session counts) — the same inputs the inline section
// received. Project-management callbacks are spies so behavior can be asserted.
function makeProjectsTestEnv(overrides: Partial<WorkspaceEnv> = {}): WorkspaceEnv {
  return {
    project: { name: 'alpha', path: '/alpha', effectivePath: '/alpha' },
    viewport: { isMobile: false, isLandscape: false, isTouch: false },
    projects: [
      { name: 'alpha', path: '/alpha' },
      { name: 'beta', path: '/beta' },
    ],
    activeProject: 'alpha',
    worktrees: projectsTestWorktrees,
    activeWorktree: null,
    projectUnreadCounts: { alpha: 3 },
    projectSessionCounts: { alpha: { active: 1, total: 2 } },
    selectProject: vi.fn(),
    selectWorktree: vi.fn(),
    reorderProjects: vi.fn(),
    removeProject: vi.fn(),
    addProject: vi.fn(),
    markAllRead: vi.fn(),
    ...overrides,
  }
}

function renderInProjectsEnv(env: WorkspaceEnv, ui: ReactNode) {
  return render(<WorkspaceEnvContext.Provider value={env}>{ui}</WorkspaceEnvContext.Provider>)
}

// Drives the panel's published header slots the way PanelFrame would.
function ProjectsPanelHeaderHarness() {
  const slots = projectsPanelDef.useHeader!()
  return <>{slots.actions}</>
}

describe('projectsPanelDef — registration metadata', () => {
  it('is a framed browse-dock panel titled "Projects"', () => {
    expect(projectsPanelDef.id).toBe('projects')
    expect(projectsPanelDef.title).toBe('Projects')
    expect(projectsPanelDef.chrome).toBe('framed')
    expect(projectsPanelDef.mobileDock).toBe('browse')
    expect(projectsPanelDef.useHeader).toBeTruthy()
  })
})

describe('ProjectsPanel body — same DOM as the inline projectListBody', () => {
  it('renders byte-identical markup to a direct ProjectList with the same env inputs', () => {
    const env = makeProjectsTestEnv()
    const Body = projectsPanelDef.Component

    const { container: panel } = renderInProjectsEnv(env, <Body />)
    const { container: reference } = render(
      <ProjectList
        projects={env.projects}
        activeProject={env.activeProject}
        activeWorktree={env.activeWorktree}
        worktrees={env.worktrees}
        projectUnreadCounts={env.projectUnreadCounts}
        projectSessionCounts={env.projectSessionCounts}
        onSelect={env.selectProject}
        onWorktreeSelect={env.selectWorktree}
        onReorder={env.reorderProjects}
        onRemove={env.removeProject}
        onMarkAllRead={env.markAllRead}
      />,
    )

    expect(panel.innerHTML).toBe(reference.innerHTML)
  })

  it('selecting a non-active project routes through env.selectProject', () => {
    const env = makeProjectsTestEnv()
    const Body = projectsPanelDef.Component
    renderInProjectsEnv(env, <Body />)

    fireEvent.click(screen.getByText('beta'))
    expect(env.selectProject).toHaveBeenCalledWith('beta')
  })

  it('renders the empty state when there are no projects', () => {
    const env = makeProjectsTestEnv({ projects: [], worktrees: [], projectUnreadCounts: {}, projectSessionCounts: {} })
    const Body = projectsPanelDef.Component
    renderInProjectsEnv(env, <Body />)

    expect(screen.getByText('No projects')).toBeTruthy()
  })
})

describe('ProjectsPanel header — same add-project action as the inline projectActions', () => {
  it('publishes only an "Add project" action (no title/badge/stats override)', () => {
    const env = makeProjectsTestEnv()
    renderInProjectsEnv(env, <ProjectsPanelHeaderHarness />)

    const addButton = screen.getByRole('button', { name: 'Add project' })
    expect(addButton.getAttribute('title')).toBe('Add project')

    fireEvent.click(addButton)
    expect(env.addProject).toHaveBeenCalledTimes(1)
  })

  it('the header hook returns no dynamic title, badge, or stats', () => {
    const env = makeProjectsTestEnv()
    let captured: PanelHeaderSlots | null = null
    function Capture() {
      captured = projectsPanelDef.useHeader!()
      return null
    }
    renderInProjectsEnv(env, <Capture />)

    expect(captured!.title).toBeUndefined()
    expect(captured!.badge).toBeUndefined()
    expect(captured!.stats).toBeUndefined()
    expect(captured!.actions).toBeTruthy()
  })
})
