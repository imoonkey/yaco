import { useState, useCallback, useEffect } from 'react'
import type { UseVoiceReturn } from '../hooks/useVoice'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface UseWorkspaceVoiceOpts {
  voice: UseVoiceReturn
  activeFilePath: string | null
  attachedSession: string | null
  activeDiffTab: boolean
  isMd: boolean | undefined
  mdMode: string
  setEditorInsert: (v: { text: string; key: number } | null) => void
  setTerminalSend: (v: { text: string; key: number } | null) => void
  setFocusTarget: (t: FocusTarget) => void
}

export function useWorkspaceVoice(opts: UseWorkspaceVoiceOpts) {
  const {
    voice, activeFilePath, attachedSession,
    activeDiffTab, isMd, mdMode,
    setEditorInsert, setTerminalSend, setFocusTarget,
  } = opts

  const editorVoiceEligible = !!activeFilePath && !activeDiffTab && !(isMd && mdMode === 'preview')
  const terminalVoiceEligible = !!attachedSession

  const [voiceSurface, setVoiceSurface] = useState<'editor' | 'terminal'>('terminal')

  // Sync surface from voice target when it changes
  useEffect(() => {
    if (voice.target?.surface) setVoiceSurface(voice.target.surface)
  }, [voice.target?.surface])

  const handleSurfaceToggle = useCallback(() => {
    setVoiceSurface(s => s === 'editor' ? 'terminal' : 'editor')
  }, [])

  const handleEditorVoiceStart = useCallback(() => {
    if (!activeFilePath) return
    voice.start({ surface: 'editor', filePath: activeFilePath })
  }, [voice, activeFilePath])

  const handleTerminalVoiceStart = useCallback(() => {
    if (!attachedSession) return
    voice.start({ surface: 'terminal', sessionName: attachedSession })
  }, [voice, attachedSession])

  const handleVoiceConfirm = useCallback((text: string) => {
    if (voiceSurface === 'editor') {
      if (!activeFilePath) return
      setEditorInsert({ text, key: Date.now() })
    } else {
      if (!attachedSession) return
      setTerminalSend({ text, key: Date.now() })
      setFocusTarget('terminal')
    }
    voice.confirm(text)
  }, [voice, voiceSurface, activeFilePath, attachedSession, setEditorInsert, setTerminalSend, setFocusTarget])

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
    handleSurfaceToggle,
    handleEditorVoiceStart,
    handleTerminalVoiceStart,
    handleVoiceConfirm,
  }
}
