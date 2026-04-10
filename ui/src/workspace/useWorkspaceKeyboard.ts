import { useEffect, useCallback } from 'react'
import type { MdMode } from '../hooks/workspaceTypes'
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
    setMobilePane: (pane: 'files' | 'editor' | 'terminal') => void
    updateLayout: (patch: Record<string, unknown>) => void
    toggleTasksTab: () => void
  }
  activeSession: string
  orderedSessions: AgentSession[]
  isMobile: boolean
  showSidebar: boolean
  showRightPanel: boolean
  showSearch: boolean
  showTextSearch: boolean
  setShowSearch: (fn: (v: boolean) => boolean) => void
  focusTarget: FocusTarget
  setFocusTarget: (t: FocusTarget) => void
  selectedFilePath: string | null
  canToggleMdMode: boolean
  mdMode: MdMode
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
    isMobile,
    showSidebar,
    showRightPanel,
    showSearch,
    setShowSearch,
    focusTarget,
    setFocusTarget,
    selectedFilePath,
    canToggleMdMode,
    mdMode,
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
      // Cmd+Shift+[1-9]: switch to session N
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
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
      // Cmd+Arrow Up/Down: cycle sessions
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey
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
      if (!showSearch && e.metaKey && !e.ctrlKey && !e.altKey && key === 'c' && focusTarget === 'explorer' && selectedFilePath) {
        e.preventDefault()
        e.stopPropagation()
        void writeTextToClipboard(selectedFilePath)
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'v' && canToggleMdMode) {
        e.preventDefault()
        e.stopPropagation()
        const cycle = { edit: 'split', split: 'preview', preview: 'edit' } as const
        actions.updateLayout({ mdMode: cycle[mdMode] })
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
  }, [actions, activeSession, canToggleMdMode, closeFocusedSurface, editorVoiceEligible, focusTarget, handleEditorVoiceStart, handleTerminalVoiceStart, isMobile, orderedSessions, mdMode, onToggleShortcutSheet, onToggleTextSearch, selectedFilePath, showRightPanel, showSearch, showSidebar, terminalVoiceEligible, voice, setFocusTarget, setShowSearch])

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
