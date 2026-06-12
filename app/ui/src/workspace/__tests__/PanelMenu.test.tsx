// @vitest-environment jsdom
//
// PanelMenu unit test: the flexible-layout header menu wires each item to the
// matching layout command (splitPanel / movePanel / resetLayout) against the live
// panel-layout tree, and renders nothing where there is no tree to rearrange
// (mobile / missing contexts — the panel isolation tests).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PanelMenu } from '../PanelMenu'
import {
  WorkspaceEnvContext, WorkspaceLayoutContext, WorkspaceCommandsContext,
  type WorkspaceEnv, type WorkspaceLayoutContextValue, type WorkspaceCommands,
} from '../context'
import { defaultWorkspacePanelLayout } from '../panelLayoutModel'

afterEach(cleanup)

const desktopEnv = {
  viewport: { isMobile: false, isLandscape: false, isTouch: false },
} as unknown as WorkspaceEnv

const mobileEnv = {
  viewport: { isMobile: true, isLandscape: false, isTouch: true },
} as unknown as WorkspaceEnv

function makeCommands() {
  return {
    splitPanel: vi.fn(),
    movePanel: vi.fn(),
    resetLayout: vi.fn(),
  } as unknown as WorkspaceCommands & {
    splitPanel: ReturnType<typeof vi.fn>
    movePanel: ReturnType<typeof vi.fn>
    resetLayout: ReturnType<typeof vi.fn>
  }
}

function renderMenu(
  panel: Parameters<typeof PanelMenu>[0]['panel'],
  commands: WorkspaceCommands,
  env: WorkspaceEnv,
  withLayout = true,
) {
  const layout = { panelLayout: defaultWorkspacePanelLayout() } as unknown as WorkspaceLayoutContextValue
  const tree = (children: ReactNode) => (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceCommandsContext.Provider value={commands}>
        {withLayout
          ? <WorkspaceLayoutContext.Provider value={layout}>{children}</WorkspaceLayoutContext.Provider>
          : children}
      </WorkspaceCommandsContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  return render(tree(<PanelMenu panel={panel} />))
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Panel menu' }))
}

describe('PanelMenu', () => {
  it('moves the panel left by splitting beside the leftmost OTHER leaf (above)', () => {
    const commands = makeCommands()
    renderMenu('sessions', commands, desktopEnv)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }))
    // Default tree leaves L→R: projects, files, changes, sessions, tasks.
    // Leftmost OTHER leaf is projects; a vertical split keeps a wide panel from
    // overflowing the narrow dock.
    expect(commands.splitPanel).toHaveBeenCalledWith('projects', 'sessions', 'above')
  })

  it('moves the panel right by splitting beside the rightmost OTHER leaf (below)', () => {
    const commands = makeCommands()
    renderMenu('sessions', commands, desktopEnv)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }))
    // Rightmost OTHER leaf (sessions excluded) is tasks.
    expect(commands.splitPanel).toHaveBeenCalledWith('tasks', 'sessions', 'below')
  })

  it('returns the panel to its default placement', () => {
    const commands = makeCommands()
    renderMenu('sessions', commands, desktopEnv)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset position' }))
    expect(commands.movePanel).toHaveBeenCalledWith('sessions', { kind: 'default' })
  })

  it('resets the whole layout', () => {
    const commands = makeCommands()
    renderMenu('sessions', commands, desktopEnv)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset layout' }))
    expect(commands.resetLayout).toHaveBeenCalledTimes(1)
  })

  it('renders nothing on mobile (no desktop tree to rearrange)', () => {
    renderMenu('sessions', makeCommands(), mobileEnv)
    expect(screen.queryByRole('button', { name: 'Panel menu' })).toBeNull()
  })

  it('renders nothing without a layout context (panel isolation tests)', () => {
    renderMenu('sessions', makeCommands(), desktopEnv, false)
    expect(screen.queryByRole('button', { name: 'Panel menu' })).toBeNull()
  })
})
