import { useEffect, useCallback } from 'react'
import type { PreviewMode, MobilePane } from '../hooks/workspaceTypes'
import type { UseVoiceReturn } from '../hooks/useVoice'
import type { AgentSession } from '../types'
import { writeTextToClipboard } from '../lib/clipboard'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'
type KeyboardLockHandle = {
  lock?: (keyCodes?: string[]) => Promise<void>
  unlock?: () => void
}

interface UseWorkspaceKeyboardOpts {
  actions: {
    setActiveSession: (name: string) => void
    setActiveTab: (tab: string) => void
    setMobilePane: (pane: MobilePane) => void
    updateLayout: (patch: Record<string, unknown>) => void
    toggleTasksTab: () => void
  }
  activeSession: string
  orderedSessions: AgentSession[]
  openTabs: string[]
  activeTab: string | null
  isMobile: boolean
  showSidebar: boolean
  showRightPanel: boolean
  showSearch: boolean
  showTextSearch: boolean
  setShowSearch: (fn: (v: boolean) => boolean) => void
  focusTarget: FocusTarget
  setFocusTarget: (t: FocusTarget) => void
  selectedFilePath: string | null
  explorerFocusedPath: string | null
  canTogglePreview: boolean
  previewMode: PreviewMode
  closeFocusedSurface: () => boolean
  editorVoiceEligible: boolean
  terminalVoiceEligible: boolean
  handleEditorVoiceStart: () => void
  handleTerminalVoiceStart: () => void
  voice: Pick<UseVoiceReturn, 'state' | 'stop' | 'capability'>
  onToggleTextSearch: () => void
  onToggleShortcutSheet: () => void
}

export function useWorkspaceKeyboard(opts: UseWorkspaceKeyboardOpts) {
  const {
    actions,
    activeSession,
    orderedSessions,
    openTabs,
    activeTab,
    isMobile,
    showSidebar,
    showRightPanel,
    showSearch,
    setShowSearch,
    focusTarget,
    setFocusTarget,
    selectedFilePath,
    explorerFocusedPath,
    canTogglePreview,
    previewMode,
    closeFocusedSurface,
    editorVoiceEligible,
    terminalVoiceEligible,
    handleEditorVoiceStart,
    handleTerminalVoiceStart,
    voice,
    onToggleTextSearch,
    onToggleShortcutSheet,
  } = opts

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
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
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
      // Cmd+Ctrl+Arrow Left/Right: cycle editor tabs
      if (e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey
          && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (openTabs.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const cur = activeTab ? openTabs.indexOf(activeTab) : -1
        const next = cur === -1
          ? (e.key === 'ArrowRight' ? 0 : openTabs.length - 1)
          : e.key === 'ArrowRight'
            ? (cur + 1) % openTabs.length
            : (cur - 1 + openTabs.length) % openTabs.length
        actions.setActiveTab(openTabs[next])
        setFocusTarget('editor')
        if (isMobile) actions.setMobilePane('editor')
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        actions.updateLayout({ showRightPanel: !showRightPanel })
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 't') {
        e.preventDefault()
        e.stopPropagation()
        actions.toggleTasksTab()
        setFocusTarget('editor')
        actions.setMobilePane('editor')
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
        actions.updateLayout({ showSidebar: !showSidebar })
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'p') { e.preventDefault(); setShowSearch(v => !v) }
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
      // Ctrl+Shift+V or F5: toggle voice recording
      if ((key === 'v' && !e.metaKey && e.ctrlKey && !e.altKey && e.shiftKey) || e.key === 'F5') {
        e.preventDefault()
        if (voice.state === 'recording') {
          voice.stop()
        } else if (voice.state === 'idle' && voice.capability.status === 'ready') {
          if (editorVoiceEligible && focusTarget === 'editor') {
            handleEditorVoiceStart()
          } else if (terminalVoiceEligible) {
            handleTerminalVoiceStart()
          }
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [actions, activeSession, activeTab, canTogglePreview, closeFocusedSurface, editorVoiceEligible, explorerFocusedPath, focusTarget, handleEditorVoiceStart, handleTerminalVoiceStart, isMobile, openTabs, orderedSessions, previewMode, onToggleShortcutSheet, onToggleTextSearch, selectedFilePath, showRightPanel, showSearch, showSidebar, terminalVoiceEligible, voice, setFocusTarget, setShowSearch])

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
