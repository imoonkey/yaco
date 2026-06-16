import { useCallback, useEffect } from 'react'
import type { UseVoiceReturn } from '../hooks/useVoice'
import type { LayoutNode, PreviewMode } from '../hooks/workspaceTypes'
import type { FocusTarget, InsertRequest } from './context'
import { isEditorVoiceEligible, editorVoiceTab } from '../components/GlobalVoiceControl'

/** A confirmed transcript routed to one editor/terminal instance. `instanceId`
 *  rides the existing `editorInsert`/`terminalSend` key-bump channel so only the
 *  matching pane consumes it; the editor insert also carries `filePath` so the
 *  pane can reject a take whose file is no longer active (design: §B/§E — same
 *  treatment as `jumpRequest`). Terminal sends stay `{ text, key, instanceId }`. */
export type VoiceInsert = InsertRequest & { instanceId: string; filePath?: string }

interface UseWorkspaceVoiceOpts {
  voice: UseVoiceReturn
  // The active editor/terminal instance — the mobile per-pane mic and the F5
  // quick-record path dictate into whichever instance is active.
  activeEditorId: string
  activeTerminalId: string | null
  // Active-editor/terminal surface state, for the (active-pane) eligibility the
  // mobile mic + keyboard read.
  activeFilePath: string | null
  attachedSession: string | null
  activeDiffTab: boolean
  isPreviewable: boolean
  previewMode: PreviewMode
  // The home editor is hidden behind the tasks panel — its take is lost.
  showingTasks: boolean
  // The group tree, for instanceId-checked confirm + target-loss: the frozen run
  // target must still be presented, editably, by the exact tab it was bound to.
  tree: LayoutNode
  terminalBindings: Record<string, string>
  setEditorInsert: (v: VoiceInsert | null) => void
  setTerminalSend: (v: VoiceInsert | null) => void
  focusPane: (kind: FocusTarget, instanceId: string) => void
}

/** Is editor instance `id` still presenting `filePath` in an *editable* Editor?
 *  Reuses the shared eligibility predicate (no diff, no preview render, not hidden
 *  by tasks) so a take never lands where no Editor is mounted, then pins the active
 *  tab to the exact target file. */
function editorTargetValid(
  tree: LayoutNode, id: string, filePath: string | undefined,
  previewMode: PreviewMode, showingTasks: boolean,
): boolean {
  if (!filePath) return false
  const tab = editorVoiceTab(tree, id)
  if (!isEditorVoiceEligible(tab, previewMode, showingTasks)) return false
  return tab?.kind === 'editor' && tab.tabId === filePath
}

export function useWorkspaceVoice(opts: UseWorkspaceVoiceOpts) {
  const {
    voice, activeEditorId, activeTerminalId, activeFilePath, attachedSession,
    activeDiffTab, isPreviewable, previewMode, showingTasks,
    tree, terminalBindings,
    setEditorInsert, setTerminalSend, focusPane,
  } = opts

  const editorVoiceEligible = !!activeFilePath && !activeDiffTab && !(isPreviewable && previewMode === 'preview')
  const terminalVoiceEligible = !!attachedSession

  // Open the compose tray (idle: type / paste, with the in-tray Record button),
  // bound to the active instance.
  const openEditorCompose = useCallback(() => {
    if (!activeFilePath) return
    voice.open({ surface: 'editor', filePath: activeFilePath, instanceId: activeEditorId })
  }, [voice, activeFilePath, activeEditorId])

  const openTerminalCompose = useCallback(() => {
    if (!attachedSession || !activeTerminalId) return
    voice.open({ surface: 'terminal', sessionName: attachedSession, instanceId: activeTerminalId })
  }, [voice, attachedSession, activeTerminalId])

  // Start a take directly into the active instance (the F5 / Ctrl+Shift+V quick-
  // record path from idle, and the mobile per-pane mic).
  const recordEditor = useCallback(() => {
    if (!activeFilePath) return
    voice.record({ surface: 'editor', filePath: activeFilePath, instanceId: activeEditorId })
  }, [voice, activeFilePath, activeEditorId])

  const recordTerminal = useCallback(() => {
    if (!attachedSession || !activeTerminalId) return
    voice.record({ surface: 'terminal', sessionName: attachedSession, instanceId: activeTerminalId })
  }, [voice, attachedSession, activeTerminalId])

  // Route Insert by the run's FROZEN target instance, not the active pane, and
  // only when that pane still presents the target file editably — text captured
  // for one editor/terminal can never land in another pane or a different file.
  const handleVoiceConfirm = useCallback((text: string) => {
    const target = voice.target
    const id = target?.instanceId
    if (!target || !id) return
    if (target.surface === 'editor') {
      if (!editorTargetValid(tree, id, target.filePath, previewMode, showingTasks)) return
      setEditorInsert({ text, key: Date.now(), instanceId: id, filePath: target.filePath })
    } else {
      if ((terminalBindings[id] ?? '') !== target.sessionName) return
      setTerminalSend({ text, key: Date.now(), instanceId: id })
      focusPane('terminal', id)
    }
    voice.confirm(text)
  }, [voice, tree, terminalBindings, previewMode, showingTasks, setEditorInsert, setTerminalSend, focusPane])

  // Detect target loss while the tray is open: the bound instance stopped
  // presenting the target file editably / stopped being bound to the target session.
  useEffect(() => {
    if (!voice.target) return
    if (voice.state === 'idle') return
    const t = voice.target
    const id = t.instanceId
    if (!id) { voice.markTargetLost(); return }
    if (t.surface === 'editor') {
      if (!editorTargetValid(tree, id, t.filePath, previewMode, showingTasks)) voice.markTargetLost()
    } else if ((terminalBindings[id] ?? '') !== t.sessionName) {
      voice.markTargetLost()
    }
  }, [voice, tree, terminalBindings, previewMode, showingTasks])

  return {
    editorVoiceEligible,
    terminalVoiceEligible,
    openEditorCompose,
    openTerminalCompose,
    recordEditor,
    recordTerminal,
    handleVoiceConfirm,
  }
}
