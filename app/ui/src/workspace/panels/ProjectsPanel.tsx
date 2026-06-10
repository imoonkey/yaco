// ProjectsPanel — the project list plus its add-project action.
//
// Design (Panel Encapsulation › ProjectsPanel): "Owns the add-project action and
// renders ProjectList. It consumes project list inputs from env and
// project-management commands from the provider." It is a FRAMED panel: it
// borrows the shared section header (title "Projects" + the add-project action)
// the same way the inline `Projects` section did via `SectionHeader`. The header
// is published through the `useHeader` hook contract from the scaffold; the body
// renders `ProjectList`.
import { Plus } from 'lucide-react'
import { ProjectList } from '../../components/ProjectList'
import { useWorkspaceEnv } from '../context'
import type { PanelDefinition, PanelHeaderSlots } from '../panelRegistry'

// Body: render `ProjectList` from env inputs + project-management callbacks.
// This is byte-identical to the former inline `projectListBody`.
//
// This module co-locates its body/header components with the `PanelDefinition`
// object it exports. That object is a non-component export, so fast refresh
// cannot hot-swap this file — the component-only rule is disabled here.
// eslint-disable-next-line react-refresh/only-export-components
function ProjectsPanelBody() {
  const env = useWorkspaceEnv()
  return (
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
    />
  )
}

// Header: publishes the add-project action into the shared framed header. No
// dynamic title, badge, or stats — the static "Projects" title carries through.
// Byte-identical to the former inline `projectActions`.
function useProjectsHeader(): PanelHeaderSlots {
  const env = useWorkspaceEnv()
  return {
    actions: (
      <button
        type="button"
        onClick={env.addProject}
        aria-label="Add project"
        title="Add project"
        className="section-header-icon-btn"
      >
        <Plus />
      </button>
    ),
  }
}

// Registration object the integrator (phase 3h) assembles into the registry.
export const projectsPanelDef: PanelDefinition = {
  id: 'projects',
  title: 'Projects',
  chrome: 'framed',
  mobileDock: 'browse',
  mobileOrder: 0,
  minSize: { width: 160, height: 60 },
  Component: ProjectsPanelBody,
  useHeader: useProjectsHeader,
}
