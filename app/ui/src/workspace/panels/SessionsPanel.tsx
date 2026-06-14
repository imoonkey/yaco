// SessionsPanel — the framed panel that owns the workspace sessions section.
//
// Design (SessionsPanel): consumes the shared `sessions` resource for live
// sessions and OWNS its own `useHistory(projectName)`, live/history tab state,
// session search, collapsed lineage, drag state, and resume loading. This is a
// pure consumer of the workspace contexts/commands — it never reaches into
// another panel or `WorkspaceScreen`. The list rendering + interaction logic is
// reused verbatim from `useWorkspaceSessionSection` (relocated, not rewritten),
// so behavior matches the current inline section exactly.
import {
  useEffect, useMemo, useSyncExternalStore, type ReactNode,
} from 'react'
import { useHistory } from '../../hooks/useApi'
import {
  useWorkspaceEnv, useWorkspaceDataContext,
  useWorkspaceSelection, useWorkspaceCommands, useOptionalWorkspacePanelResources,
} from '../context'
import { useWorkspaceSessionSection } from '../useWorkspaceSessionSection'
import { PANEL_META } from '../panelMeta'
import type { PanelDefinition, PanelHeaderSlots } from '../panelRegistry'

// --- Framed-header bridge ---------------------------------------------------
//
// Sessions is FRAMED: its body and its section-header actions (new-session
// buttons, search toggle, live/history toggle, refresh) are driven by ONE
// `useWorkspaceSessionSection` instance. PanelFrame renders the framed header
// and the body as siblings, so the single hook instance — owned by the body,
// the natural owner of all the list state — publishes its actions node through
// this tiny store, and the header hook reads it back. The app mounts exactly
// one Sessions panel (design invariant: a visible panel id appears once;
// desktop XOR mobile renders), so a module-level store is that one shared seam.
let publishedActions: ReactNode = null
const actionListeners = new Set<() => void>()

function publishActions(node: ReactNode): void {
  publishedActions = node
  actionListeners.forEach((listener) => listener())
}

function subscribeActions(listener: () => void): () => void {
  actionListeners.add(listener)
  return () => { actionListeners.delete(listener) }
}

function readActions(): ReactNode {
  return publishedActions
}

export function SessionsPanel() {
  const env = useWorkspaceEnv()
  const data = useWorkspaceDataContext()
  const selection = useWorkspaceSelection()
  const commands = useWorkspaceCommands()

  const { name: projectName, effectivePath } = env.project
  const { isMobile } = env.viewport

  // Consume the provider-owned, ALWAYS-ON history (it survives section collapse +
  // dock hide, and the provider refreshes it after a session kill/rename via the
  // sessions resource's onSessionChange). The local hook is a fallback for
  // rendering outside the provider (isolation tests); inert when the provider
  // supplies history (null project → no fetch).
  const resources = useOptionalWorkspacePanelResources()
  const ownHistory = useHistory(resources ? null : projectName)
  const history = resources?.history ?? ownHistory

  // Adapt the shared sessions resource to the SessionsMgr shape the (unchanged)
  // session section consumes; detach belongs to the command surface.
  const sessionsMgr = useMemo(() => ({
    orderedSessions: data.sessions.orderedSessions,
    projectSessions: data.sessions.projectSessions,
    pinnedSet: data.sessions.pinnedSet,
    getSessionBadge: data.sessions.getSessionBadge,
    isSessionReady: data.sessions.isSessionReady,
    killSession: data.sessions.killSession,
    handleNewSession: data.sessions.startSession,
    handleRenameSession: data.sessions.renameSession,
    togglePin: data.sessions.togglePin,
    handlePinnedReorder: data.sessions.reorderPinned,
    markSubtreeRead: data.sessions.markSubtreeRead,
    detachActiveSession: commands.detachSession,
  }), [data.sessions, commands.detachSession])

  // Desktop can show multiple terminal tabs at once, so every bound session reads
  // as shown. Mobile projects only one terminal body, so only the active terminal's
  // bound session should read as shown; otherwise rows look open but are not visible.
  const shownSessions = useMemo(
    () => {
      if (isMobile) return selection.activeSession ? new Set([selection.activeSession]) : new Set<string>()
      return new Set(Object.values(selection.terminalBindings).filter(Boolean))
    },
    [isMobile, selection.activeSession, selection.terminalBindings],
  )

  const { sessionsActions, sessionsSearch, sessionsBody } = useWorkspaceSessionSection({
    sessionsMgr,
    shownSessions,
    isMobile,
    history,
    projectPath: effectivePath,
    projectName,
    clickSession: commands.clickSession,
    openBeside: commands.openBeside,
    refreshSessions: data.sessions.refresh,
  })

  // Publish the section actions to the framed header (see bridge above).
  useEffect(() => {
    publishActions(sessionsActions)
    return () => publishActions(null)
  }, [sessionsActions])

  // Search is a sibling above the scrollable list, matching the file-search
  // panel shape: controls stay fixed while only results scroll.
  return (
    <div className="h-full min-h-0 flex flex-col">
      {sessionsSearch}
      <div className="flex-1 min-h-0 overflow-y-auto py-1" aria-live="polite">
        {sessionsBody}
      </div>
    </div>
  )
}

/** Framed-header hook: surfaces the section actions the body publishes. */
// eslint-disable-next-line react-refresh/only-export-components
export function useSessionsHeader(): PanelHeaderSlots {
  const actions = useSyncExternalStore(subscribeActions, readActions, readActions)
  return { actions }
}

// eslint-disable-next-line react-refresh/only-export-components
export const sessionsPanelDef: PanelDefinition = {
  ...PANEL_META.sessions,
  Component: SessionsPanel,
  useHeader: useSessionsHeader,
}
