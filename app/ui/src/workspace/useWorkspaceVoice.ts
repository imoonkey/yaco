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

  // Mirror the run's frozen target surface for display. Synced from voice.target;
  // never toggled mid-run — the insertion target is frozen when the run starts.
  useEffect(() => {
    if (voice.target?.surface) setVoiceSurface(voice.target.surface)
  }, [voice.target?.surface])

  const handleEditorVoiceStart = useCallback(() => {
    if (!activeFilePath) return
    voice.start({ surface: 'editor', filePath: activeFilePath })
  }, [voice, activeFilePath])

  const handleTerminalVoiceStart = useCallback(() => {
    if (!attachedSession) return
    voice.start({ surface: 'terminal', sessionName: attachedSession })
  }, [voice, attachedSession])

  // Route confirm by the run's FROZEN target, not a mutable surface — audio
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

  // Detect target loss while composing
  useEffect(() => {
    if (voice.state !== 'composing' || !voice.target) return
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
    handleEditorVoiceStart,
    handleTerminalVoiceStart,
    handleVoiceConfirm,
  }
}
