import { useState, useCallback, useEffect } from 'react'
import type { UseVoiceReturn } from '../hooks/useVoice'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface UseWorkspaceVoiceOpts {
  voice: UseVoiceReturn
  activeFilePath: string | null
  attachedSession: string | null
  activeDiffTab: boolean
  isPreviewable: boolean
  previewMode: string
  setEditorInsert: (v: { text: string; key: number } | null) => void
  setTerminalSend: (v: { text: string; key: number } | null) => void
  setFocusTarget: (t: FocusTarget) => void
}

export function useWorkspaceVoice(opts: UseWorkspaceVoiceOpts) {
  const {
    voice, activeFilePath, attachedSession,
    activeDiffTab, isPreviewable, previewMode,
    setEditorInsert, setTerminalSend, setFocusTarget,
  } = opts

  const editorVoiceEligible = !!activeFilePath && !activeDiffTab && !(isPreviewable && previewMode === 'preview')
  const terminalVoiceEligible = !!attachedSession

  const [voiceSurface, setVoiceSurface] = useState<'editor' | 'terminal'>('terminal')

  // Mirror the run's frozen target surface for the tray header. Synced from
  // voice.target; never toggled mid-run.
  const [prevSurface, setPrevSurface] = useState(voice.target?.surface)
  if (voice.target?.surface && voice.target.surface !== prevSurface) {
    setPrevSurface(voice.target.surface)
    setVoiceSurface(voice.target.surface)
  }

  // Open the compose tray (idle: type / paste, with the in-tray Record button).
  const openEditorCompose = useCallback(() => {
    if (!activeFilePath) return
    voice.open({ surface: 'editor', filePath: activeFilePath })
  }, [voice, activeFilePath])

  const openTerminalCompose = useCallback(() => {
    if (!attachedSession) return
    voice.open({ surface: 'terminal', sessionName: attachedSession })
  }, [voice, attachedSession])

  // Start a take directly into a surface (opens the tray + records). Used by the
  // F5 / Ctrl+Shift+V quick-record path from idle.
  const recordEditor = useCallback(() => {
    if (!activeFilePath) return
    voice.record({ surface: 'editor', filePath: activeFilePath })
  }, [voice, activeFilePath])

  const recordTerminal = useCallback(() => {
    if (!attachedSession) return
    voice.record({ surface: 'terminal', sessionName: attachedSession })
  }, [voice, attachedSession])

  // Route Insert by the run's FROZEN target, not a mutable surface — text
  // captured for the editor can never land in the terminal.
  const handleVoiceConfirm = useCallback((text: string) => {
    const target = voice.target
    if (!target) return
    if (target.surface === 'editor') {
      if (!activeFilePath || activeFilePath !== target.filePath) return
      setEditorInsert({ text, key: Date.now() })
    } else {
      if (!attachedSession || attachedSession !== target.sessionName) return
      setTerminalSend({ text, key: Date.now() })
      setFocusTarget('terminal')
    }
    voice.confirm(text)
  }, [voice, activeFilePath, attachedSession, setEditorInsert, setTerminalSend, setFocusTarget])

  // Detect target loss while the tray is open with a target.
  useEffect(() => {
    if (!voice.target) return
    if (voice.state === 'idle') return
    const t = voice.target
    if (t.surface === 'editor' && (!activeFilePath || activeFilePath !== t.filePath)) {
      voice.markTargetLost()
    }
    if (t.surface === 'terminal' && (!attachedSession || attachedSession !== t.sessionName)) {
      voice.markTargetLost()
    }
  }, [voice, activeFilePath, attachedSession])

  return {
    voiceSurface,
    editorVoiceEligible,
    terminalVoiceEligible,
    openEditorCompose,
    openTerminalCompose,
    recordEditor,
    recordTerminal,
    handleVoiceConfirm,
  }
}
