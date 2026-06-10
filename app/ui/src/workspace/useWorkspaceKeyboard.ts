import { useEffect, useCallback } from 'react'
import type { UseVoiceReturn } from '../hooks/useVoice'
import { writeTextToClipboard } from '../lib/clipboard'
import { useWorkspaceCommands, useWorkspaceSelection, useWorkspaceLayout, useWorkspaceDataContext, useWorkspaceEnv } from './context'

type KeyboardLockHandle = {
  lock?: (keyCodes?: string[]) => Promise<void>
  unlock?: () => void
}

interface UseWorkspaceKeyboardOpts {
  canTogglePreview: boolean
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
    canTogglePreview,
    editorVoiceEligible,
    terminalVoiceEligible,
    handleEditorVoiceStart,
    handleTerminalVoiceStart,
    voice,
    onToggleTextSearch,
    onToggleShortcutSheet,
  } = opts

  const commands = useWorkspaceCommands()
  const actions = commands.actions
  const setFocusTarget = commands.setFocusTarget
  const closeFocusedSurface = commands.closeFocusedSurface
  const toggleDock = commands.toggleDock
  const toggleActivity = commands.toggleActivity
  const setShowSearch = commands.actions.setShowSearch
  const { activeSession, openTabs, activeTab, focusTarget, explorerFocusedPath, showSearch } = useWorkspaceSelection()
  const { orderedSessions } = useWorkspaceDataContext().sessions
  const { layout } = useWorkspaceLayout()
  const { previewMode } = layout
  const { isMobile } = useWorkspaceEnv().viewport

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
        toggleActivity()
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
      // Ctrl+Shift+V or F5: toggle voice recording
      if ((key === 'v' && !e.metaKey && e.ctrlKey && !e.altKey && e.shiftKey) || e.key === 'F5') {
        e.preventDefault()
        if (voice.state === 'active') {
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
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [actions, activeSession, activeTab, canTogglePreview, closeFocusedSurface, editorVoiceEligible, explorerFocusedPath, focusTarget, handleEditorVoiceStart, handleTerminalVoiceStart, isMobile, openTabs, orderedSessions, previewMode, onToggleShortcutSheet, onToggleTextSearch, showSearch, terminalVoiceEligible, toggleActivity, toggleDock, voice, setFocusTarget, setShowSearch])

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
