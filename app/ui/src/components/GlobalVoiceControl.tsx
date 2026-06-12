/* eslint-disable react-refresh/only-export-components -- the pure target resolver
   ships in this file alongside its sole consumer so it can be unit-tested directly */
// GlobalVoiceControl — the desktop workspace's single voice control, portaled by
// WorkspaceScreen into an App-owned top-bar slot beside the notification bell
// (design: Multi-Instance Panels §G). It is a mic + a target indicator + a target
// dropdown. The screen owns the one `useVoice`; this component is presentational
// and drives it through the passed handlers.
//
// The target logic is pure (`resolveVoiceTarget`) so it is unit-tested without a
// DOM: a voice take always has an unambiguous instance, the default follows focus,
// and an explicit dropdown pick overrides it until focus moves again.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FileText, LoaderCircle, Mic, Square, SquareTerminal } from 'lucide-react'
import type { CapabilityState, InteractionState, VoiceTargetContext } from '../hooks/useVoice'
import { isFileTab, type EditorView, type PreviewMode } from '../hooks/workspaceTypes'
import { isPreviewableFile } from '../lib/binaryFiles'
import { HOME_EDITOR_ID } from '../workspace/panelLayoutModel'

export type VoiceInstanceKind = 'editor' | 'terminal'

/** One eligible voice target: an editor pane showing an editable file, or a bound
 *  terminal pane. `filePath`/`sessionName` are the record-context payload. */
export type VoiceInstance = {
  kind: VoiceInstanceKind
  instanceId: string
  label: string
  filePath?: string
  sessionName?: string
}

export type VoiceTargetOverride = { kind: VoiceInstanceKind; instanceId: string }

export type ResolveVoiceTargetArgs = {
  editorIds: string[]
  terminalIds: string[]
  editorViews: Record<string, EditorView>
  terminalBindings: Record<string, string>
  previewMode: PreviewMode
  /** The main region currently shows the tasks panel, hiding the home editor. */
  showingTasks: boolean
  activeEditorId: string
  activeTerminalId: string | null
  recentMultiKind: VoiceInstanceKind
  override: VoiceTargetOverride | null
}

const basename = (path: string): string => path.split('/').pop() || path

/** An editor pane is an eligible voice target iff it shows a plain editable file:
 *  a real file tab (not a diff), not a previewable file in preview mode (markdown/
 *  html/image/pdf render a preview, not an Editor), and — for the home editor —
 *  not hidden behind the tasks panel. The single source of truth the resolver,
 *  target-loss, and confirm paths all share, so a take can only land where an
 *  Editor is actually mounted on the target file (design: §G). */
export function isEditorVoiceEligible(
  view: EditorView | undefined, instanceId: string, previewMode: PreviewMode, showingTasks: boolean,
): boolean {
  if (showingTasks && instanceId === HOME_EDITOR_ID) return false
  const tab = view?.activeTab ?? null
  if (!isFileTab(tab)) return false
  if (isPreviewableFile(tab) && previewMode === 'preview') return false
  return true
}

/** Eligible instances (editors first, both in document order) + the resolved
 *  target: an explicit override if it still points at an eligible instance, else
 *  the default from focus — the recently-focused kind's active instance, else the
 *  other kind's, else the first eligible in order. */
export function resolveVoiceTarget(args: ResolveVoiceTargetArgs): {
  instances: VoiceInstance[]
  target: VoiceInstance | null
} {
  const { editorIds, terminalIds, editorViews, terminalBindings, previewMode, showingTasks } = args

  const instances: VoiceInstance[] = []
  for (const id of editorIds) {
    const view = editorViews[id]
    if (!isEditorVoiceEligible(view, id, previewMode, showingTasks)) continue
    const filePath = view!.activeTab as string
    instances.push({ kind: 'editor', instanceId: id, label: basename(filePath), filePath })
  }
  for (const id of terminalIds) {
    const sessionName = terminalBindings[id]
    if (!sessionName) continue
    instances.push({ kind: 'terminal', instanceId: id, label: sessionName, sessionName })
  }

  const find = (kind: VoiceInstanceKind, id: string | null): VoiceInstance | null =>
    (id && instances.find(i => i.kind === kind && i.instanceId === id)) || null

  const activeOf = (kind: VoiceInstanceKind) => kind === 'editor' ? args.activeEditorId : args.activeTerminalId
  const otherKind: VoiceInstanceKind = args.recentMultiKind === 'editor' ? 'terminal' : 'editor'

  const defaultTarget =
    find(args.recentMultiKind, activeOf(args.recentMultiKind))
    ?? find(otherKind, activeOf(otherKind))
    ?? instances[0]
    ?? null

  const override = args.override ? find(args.override.kind, args.override.instanceId) : null
  return { instances, target: override ?? defaultTarget }
}

/** The frozen run target → the instance the indicator shows while a take is in
 *  flight (the live default is irrelevant once a take is bound to a pane). */
export function instanceFromTarget(target: VoiceTargetContext | null): VoiceInstance | null {
  if (!target?.instanceId) return null
  if (target.surface === 'editor') {
    const filePath = target.filePath ?? ''
    return { kind: 'editor', instanceId: target.instanceId, label: basename(filePath), filePath }
  }
  const sessionName = target.sessionName ?? ''
  return { kind: 'terminal', instanceId: target.instanceId, label: sessionName, sessionName }
}

export type FocusEpochState = { epoch: number; lastFocusKey: string | null }

/** Advance the focus epoch: it ticks once on every *transition* of focus onto an
 *  eligible (editor/terminal) pane. Because the tick keys off the transition, not
 *  the pane identity, leaving a pane and returning to it advances the epoch too —
 *  so a dropdown override (which captures the epoch at pick time) clears when the
 *  epoch moves past it, even when focus returns to the same anchor pane. */
export function advanceFocusEpoch(
  prev: FocusEpochState, focusKey: string, focusedEligible: boolean,
): FocusEpochState {
  if (focusKey === prev.lastFocusKey) return prev.lastFocusKey === null ? { ...prev, lastFocusKey: focusKey } : prev
  return { epoch: focusedEligible ? prev.epoch + 1 : prev.epoch, lastFocusKey: focusKey }
}

// --- Component ------------------------------------------------------------

type Visual = 'ready' | 'recording' | 'processing'

function resolveVisual(state: InteractionState): Visual {
  switch (state) {
    case 'recording': return 'recording'
    case 'requesting_permission':
    case 'transcribing':
      return 'processing'
    default: return 'ready'
  }
}

const MIC_LABEL: Record<Visual, string> = {
  recording: 'Stop recording',
  processing: 'Voice processing',
  ready: 'Start voice recording',
}

function InstanceIcon({ kind }: { kind: VoiceInstanceKind }) {
  return kind === 'editor'
    ? <FileText size={13} aria-hidden="true" />
    : <SquareTerminal size={13} aria-hidden="true" />
}

type GlobalVoiceControlProps = {
  capability: CapabilityState
  state: InteractionState
  /** The instance the indicator names + the mic records into (the live default /
   *  override while idle, the frozen run target while a take is in flight). */
  target: VoiceInstance | null
  /** Eligible instances offered by the dropdown. */
  instances: VoiceInstance[]
  /** A take is in flight / composing — the target is frozen, so the dropdown locks. */
  locked: boolean
  onSelect: (inst: VoiceInstance) => void
  onRecord: () => void
  onStop: () => void
}

export function GlobalVoiceControl({
  capability, state, target, instances, locked, onSelect, onRecord, onStop,
}: GlobalVoiceControlProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)

  // Close the dropdown on an outside click (matches the bell/quick-open chrome).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  const visual = resolveVisual(state)
  const ready = capability.status === 'ready'
  const unavailable = capability.status === 'unavailable' ? capability.message : undefined
  const hasTarget = !!target
  const micDisabled = !ready || (visual === 'ready' && !hasTarget)
  const canChoose = !locked && instances.length > 0

  const handleMic = () => {
    if (visual === 'recording') onStop()
    else if (visual === 'ready' && hasTarget) onRecord()
    // 'processing' — a take is in flight; ignore.
  }

  const pick = (inst: VoiceInstance) => { onSelect(inst); setOpen(false) }

  return (
    <span ref={containerRef} className="relative inline-flex items-center gap-1">
      <button
        className="chrome-icon-btn flex items-center justify-center cursor-pointer w-7 h-7 rounded disabled:opacity-40 disabled:cursor-default"
        onClick={handleMic}
        disabled={micDisabled}
        aria-label={MIC_LABEL[visual]}
        aria-busy={visual === 'processing'}
        title={unavailable}
        style={visual === 'recording'
          ? { color: 'var(--sol-red)', animation: 'recording-scale 1.2s ease-in-out infinite' }
          : undefined}
      >
        {visual === 'processing'
          ? <LoaderCircle size={15} aria-hidden="true" style={{ animation: 'voice-spin 0.8s linear infinite' }} />
          : visual === 'recording'
            ? <Square size={12} aria-hidden="true" fill="currentColor" />
            : <Mic size={15} aria-hidden="true" />}
      </button>

      <button
        className="flex items-center gap-1 h-7 px-1.5 rounded cursor-pointer text-ui-sm border border-[var(--sol-border)] hover:bg-[var(--sol-subtle-bg)] disabled:opacity-40 disabled:cursor-default max-w-[160px]"
        onClick={() => canChoose && setOpen(v => !v)}
        disabled={!canChoose}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={target ? `Voice target: ${target.label}` : 'No voice target'}
        style={{ color: 'var(--sol-text-dim)' }}
      >
        {target
          ? <><InstanceIcon kind={target.kind} /><span className="truncate">{target.label}</span></>
          : <span className="truncate" style={{ color: 'var(--sol-muted)' }}>No target</span>}
        <ChevronDown size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-50 min-w-[180px] rounded-md border border-[var(--sol-border)] py-1 shadow-[var(--elevation-2)]"
          style={{ background: 'var(--sol-editor-bg)' }}
        >
          {instances.map(inst => {
            const selected = !!target && target.kind === inst.kind && target.instanceId === inst.instanceId
            return (
              <button
                key={`${inst.kind}:${inst.instanceId}`}
                role="menuitemradio"
                aria-checked={selected}
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-ui-sm cursor-pointer hover:bg-[var(--sol-subtle-bg)]"
                style={{ color: selected ? 'var(--sol-blue)' : 'var(--sol-text)' }}
                onClick={() => pick(inst)}
              >
                <InstanceIcon kind={inst.kind} />
                <span className="truncate">{inst.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </span>
  )
}
