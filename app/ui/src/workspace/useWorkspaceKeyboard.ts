import { useEffect, useCallback, useRef } from 'react'
import type { UseVoiceReturn } from '../hooks/useVoice'
import type { FileNode } from '../types'
import { writeTextToClipboard } from '../lib/clipboard'
import { splitSideFromGeometry, orthogonalSide } from './panelInstance'
import { editorTabsInGroup } from './panelLayoutModel'
import { useWorkspaceCommands, useWorkspaceSelection, useWorkspaceLayout, useWorkspaceDataContext, useWorkspaceEnv, useOptionalWorkspacePanelResources } from './context'

/** Type of the tree node at `path` (file/dir), or null if not in the tree. */
function findNodeType(nodes: FileNode[] | null, path: string): 'file' | 'dir' | null {
  if (!nodes) return null
  for (const node of nodes) {
    if (node.path === path) return node.type
    const child = node.children ? findNodeType(node.children, path) : null
    if (child) return child
  }
  return null
}

type KeyboardLockHandle = {
  lock?: (keyCodes?: string[]) => Promise<void>
  unlock?: () => void
}

interface UseWorkspaceKeyboardOpts {
  canTogglePreview: boolean
  editorVoiceEligible: boolean
  terminalVoiceEligible: boolean
  recordEditor: () => void
  recordTerminal: () => void
  voice: Pick<UseVoiceReturn, 'state' | 'stop' | 'record' | 'capability'>
  onToggleTextSearch: () => void
  onToggleShortcutSheet: () => void
}

export function useWorkspaceKeyboard(opts: UseWorkspaceKeyboardOpts) {
  const {
    canTogglePreview,
    editorVoiceEligible,
    terminalVoiceEligible,
    recordEditor,
    recordTerminal,
    voice,
    onToggleTextSearch,
    onToggleShortcutSheet,
  } = opts

  const commands = useWorkspaceCommands()
  const actions = commands.actions
  const setFocusTarget = commands.setFocusTarget
  const closeFocusedSurface = commands.closeFocusedSurface
  const toggleTasks = commands.toggleTasks
  const toggleDock = commands.toggleDock
  const toggleActivity = commands.toggleActivity
  const splitEditor = commands.splitEditor
  const splitTerminal = commands.splitTerminal
  const openToSide = commands.openToSide
  const setShowSearch = commands.actions.setShowSearch
  const { activeSession, activeGroupId, activeEditorTabId, focusedPane, focusTarget, explorerFocusedPath, showSearch } = useWorkspaceSelection()
  const { orderedSessions } = useWorkspaceDataContext().sessions
  const { layout, panelLayout } = useWorkspaceLayout()
  const { previewMode } = layout
  const { isMobile } = useWorkspaceEnv().viewport
  // The file tree the explorer renders (provider-owned, always-on). Used to gate
  // Cmd+Enter open-to-side to FILES — the explorer reports a focused path for
  // directories too, and openToSide would otherwise open a bogus side editor.
  const fileTree = useOptionalWorkspacePanelResources()?.fileTree.data ?? null

  // Cmd+K arms the orthogonal-split prefix; the next Cmd+\ flips the axis. A plain
  // ref (no timer) — the next keydown either completes the chord or cancels it.
  const chordPendingRef = useRef(false)

  const getKeyboardLock = useCallback((): KeyboardLockHandle | null => {
    if (!window.isSecureContext) return null
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardLockHandle }).keyboard
    if (!keyboard?.lock || !keyboard.unlock) return null
    return keyboard
  }, [])

  const lockCloseShortcut = useCallback(async () => {
    const keyboard = getKeyboardLock()
    if (!keyboard?.lock) return
    try {
      await keyboard.lock(['KeyW'])
    } catch {
      // Browser support varies
    }
  }, [getKeyboardLock])

  const unlockCloseShortcut = useCallback(() => {
    const keyboard = getKeyboardLock()
    keyboard?.unlock?.()
  }, [getKeyboardLock])

  // Main keydown handler
  useEffect(() => {
    // Split the focused editor/terminal along its live geometry's default axis
    // (wide → right, tall → below), or the orthogonal axis when Cmd+K armed it.
    const splitFocusedPane = (orthogonal: boolean) => {
      if (focusedPane.kind !== 'editor' && focusedPane.kind !== 'terminal') return
      const el = document.querySelector<HTMLElement>(`[data-instance-id="${focusedPane.instanceId}"]`)
      if (!el) return
      const base = splitSideFromGeometry(el.offsetWidth, el.offsetHeight)
      const side = orthogonal ? orthogonalSide(base) : base
      if (focusedPane.kind === 'editor') splitEditor(focusedPane.instanceId, side)
      else splitTerminal(focusedPane.instanceId, side)
    }

    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      // Cmd+K prefix completion: only a clean Cmd+\ flips the split axis. Any
      // other key (incl. a bare '\' after Cmd was released) cancels the prefix
      // and is handled normally below — no preventDefault.
      if (chordPendingRef.current) {
        chordPendingRef.current = false
        if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'Backslash') {
          e.preventDefault()
          e.stopPropagation()
          splitFocusedPane(true)
          return
        }
      }
      // Cmd+Ctrl+[1-9]: switch to session N
      if (e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        const target = orderedSessions[Number(e.code.slice(5)) - 1]
        if (target) {
          actions.setActiveSession(target.name)
          setFocusTarget('session')
          if (isMobile) actions.setMobilePane('terminal')
        }
        return
      }
      // Cmd+Ctrl+Arrow Up/Down: cycle sessions
      if (e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey
          && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (orderedSessions.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const cur = orderedSessions.findIndex(s => s.name === activeSession)
        const next = cur === -1
          ? (e.key === 'ArrowDown' ? 0 : orderedSessions.length - 1)
          : e.key === 'ArrowDown'
            ? (cur + 1) % orderedSessions.length
            : (cur - 1 + orderedSessions.length) % orderedSessions.length
        actions.setActiveSession(orderedSessions[next].name)
        setFocusTarget('terminal')
        if (isMobile) actions.setMobilePane('terminal')
        return
      }
      // Cmd+Ctrl+Arrow Left/Right: cycle the active group's editor tabs
      if (e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey
          && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const openTabIds = editorTabsInGroup(panelLayout.desktop, activeGroupId).flatMap((t) => (t.kind === 'editor' ? [t.tabId] : []))
        if (openTabIds.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const cur = activeEditorTabId ? openTabIds.indexOf(activeEditorTabId) : -1
        const next = cur === -1
          ? (e.key === 'ArrowRight' ? 0 : openTabIds.length - 1)
          : e.key === 'ArrowRight'
            ? (cur + 1) % openTabIds.length
            : (cur - 1 + openTabIds.length) % openTabIds.length
        actions.setActiveTab(openTabIds[next])
        setFocusTarget('editor')
        if (isMobile) actions.setMobilePane('editor')
        return
      }
      // Cmd+\: split the focused pane along its geometry-default axis.
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'Backslash') {
        e.preventDefault()
        e.stopPropagation()
        splitFocusedPane(false)
        return
      }
      // Cmd+K: arm the orthogonal-split prefix (completed by Cmd+\ above).
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault()
        e.stopPropagation()
        chordPendingRef.current = true
        return
      }
      // Cmd+Enter in the explorer: open the focused FILE beside the active editor
      // (directories report a focused path too, but must not open a side editor).
      if (!showSearch && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
          && e.key === 'Enter' && focusTarget === 'explorer' && explorerFocusedPath
          && findNodeType(fileTree, explorerFocusedPath) === 'file') {
        e.preventDefault()
        e.stopPropagation()
        openToSide(explorerFocusedPath)
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        toggleActivity()
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 't') {
        e.preventDefault()
        e.stopPropagation()
        toggleTasks()
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        onToggleTextSearch()
        return
      }
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        toggleDock()
        return
      }
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === 'p') {
        e.preventDefault()
        e.stopImmediatePropagation()
        e.stopPropagation()
        setShowSearch(v => !v)
        return
      }
      if (!showSearch && e.metaKey && !e.ctrlKey && !e.altKey && key === 'c' && focusTarget === 'explorer' && explorerFocusedPath) {
        e.preventDefault()
        e.stopPropagation()
        void writeTextToClipboard(explorerFocusedPath)
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'v' && canTogglePreview) {
        e.preventDefault()
        e.stopPropagation()
        const cycle = { edit: 'split', split: 'preview', preview: 'edit' } as const
        actions.updateLayout({ previewMode: cycle[previewMode] })
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'w' && closeFocusedSurface()) {
        e.preventDefault()
        e.stopPropagation()
      }
      // ? : toggle shortcut cheatsheet (ignore when typing in input/textarea/contenteditable)
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName
        const editable = (e.target as HTMLElement).isContentEditable
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !editable) {
          e.preventDefault()
          onToggleShortcutSheet()
          return
        }
      }
      // Ctrl+Shift+V or F5: voice take — stop while recording, append another
      // take while the tray is open, or open+record from idle.
      if ((key === 'v' && !e.metaKey && e.ctrlKey && !e.altKey && e.shiftKey) || e.key === 'F5') {
        e.preventDefault()
        const vs = voice.state
        if (vs === 'recording') {
          voice.stop()
        } else if (vs === 'requesting_permission' || vs === 'transcribing') {
          // a take is already in flight — ignore
        } else if (vs === 'composing' || vs === 'recoverable' || vs === 'error') {
          voice.record() // append into the open tray (frozen target)
        } else if (vs === 'idle' && voice.capability.status === 'ready') {
          if (editorVoiceEligible && focusTarget === 'editor') {
            recordEditor()
          } else if (terminalVoiceEligible) {
            recordTerminal()
          }
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [actions, activeSession, activeEditorTabId, activeGroupId, panelLayout, canTogglePreview, closeFocusedSurface, editorVoiceEligible, explorerFocusedPath, fileTree, focusedPane, focusTarget, openToSide, recordEditor, recordTerminal, isMobile, orderedSessions, previewMode, onToggleShortcutSheet, onToggleTextSearch, showSearch, splitEditor, splitTerminal, terminalVoiceEligible, toggleActivity, toggleDock, toggleTasks, voice, setFocusTarget, setShowSearch])

  // Unlock keyboard lock on blur/visibility change
  useEffect(() => {
    const handleBlur = () => { unlockCloseShortcut() }
    const handleVisibilityChange = () => {
      if (document.hidden) unlockCloseShortcut()
    }
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      unlockCloseShortcut()
    }
  }, [unlockCloseShortcut])

  return { lockCloseShortcut }
}
