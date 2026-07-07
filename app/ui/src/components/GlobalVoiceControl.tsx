/* eslint-disable react-refresh/only-export-components -- the pure target resolver
   ships in this file alongside its sole consumer so it can be unit-tested directly */
// GlobalVoiceControl — the desktop workspace's single voice mic, portaled by
// WorkspaceScreen into an App-owned top-bar slot beside the notification bell
// (design: Multi-Instance Panels §G). It is a mic that records into the live
// idle target; the target *indicator* and its selector live in the ComposeTray
// (see TargetSelector). The screen owns the one `useVoice`; this component is
// presentational and drives it through the passed handlers.
//
// The target logic is pure (`resolveVoiceTarget`) so it is unit-tested without a
// DOM: a voice take always has an unambiguous instance, and the default follows
// focus (recently-focused kind's active instance, else the other kind's, else
// the first eligible in order).
import { LoaderCircle, Mic, Square } from 'lucide-react'
import type { CapabilityState, InteractionState, VoiceTargetContext } from '../hooks/useVoice'
import { isFileTab, type GroupTab, type LayoutNode } from '../hooks/workspaceTypes'
import { isPreviewableFile } from '../lib/binaryFiles'
import { tabByInstance, editorTabView } from '../workspace/panelLayoutModel'

export type VoiceInstanceKind = 'editor' | 'terminal'

/** The editor tab an instance shows, or null (absent / a terminal tab). */
export function editorVoiceTab(tree: LayoutNode, instanceId: string): GroupTab | null {
  const t = tabByInstance(tree, instanceId)
  return t && t.kind === 'editor' ? t : null
}

/** One eligible voice target: an editor pane showing an editable file, or a bound
 *  terminal pane. `filePath`/`sessionName` are the record-context payload. */
export type VoiceInstance = {
  kind: VoiceInstanceKind
  instanceId: string
  label: string
  filePath?: string
  sessionName?: string
}

export type ResolveVoiceTargetArgs = {
  editorIds: string[]
  terminalIds: string[]
  tree: LayoutNode
  terminalBindings: Record<string, string>
  /** The active surface hides the editor (mobile tasks pane). */
  showingTasks: boolean
  activeEditorId: string
  activeTerminalId: string | null
  recentMultiKind: VoiceInstanceKind
}

const basename = (path: string): string => path.split('/').pop() || path

/** An editor tab is an eligible voice target iff it shows a plain editable file: a
 *  real file tab (not a diff), not a previewable file in preview mode (markdown/
 *  html/image/pdf render a preview, not an Editor), and not hidden behind the tasks
 *  pane. The preview mode is read from the tab's OWN per-tab view. The single source
 *  of truth the resolver, target-loss, and confirm paths all share, so a take can
 *  only land where an Editor is actually mounted (§G). */
export function isEditorVoiceEligible(
  tab: GroupTab | null, showingTasks: boolean,
): boolean {
  if (showingTasks) return false
  const tabId = tab && tab.kind === 'editor' ? tab.tabId : null
  if (!isFileTab(tabId)) return false
  if (isPreviewableFile(tabId) && editorTabView(tab).previewMode === 'preview') return false
  return true
}

/** Eligible instances (editors first, both in document order) + the resolved
 *  default target from focus: the recently-focused kind's active instance, else
 *  the other kind's, else the first eligible in order. */
export function resolveVoiceTarget(args: ResolveVoiceTargetArgs): {
  instances: VoiceInstance[]
  target: VoiceInstance | null
} {
  const { editorIds, terminalIds, tree, terminalBindings, showingTasks } = args

  const instances: VoiceInstance[] = []
  for (const id of editorIds) {
    const tab = editorVoiceTab(tree, id)
    if (!isEditorVoiceEligible(tab, showingTasks)) continue
    const filePath = tab!.kind === 'editor' ? tab!.tabId : ''
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

  const target =
    find(args.recentMultiKind, activeOf(args.recentMultiKind))
    ?? find(otherKind, activeOf(otherKind))
    ?? instances[0]
    ?? null

  return { instances, target }
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

/** A chosen instance → the record/retarget context that routes a take to it (the
 *  inverse of `instanceFromTarget`). */
export function targetContextOf(inst: VoiceInstance): VoiceTargetContext {
  return inst.kind === 'editor'
    ? { surface: 'editor', filePath: inst.filePath, instanceId: inst.instanceId }
    : { surface: 'terminal', sessionName: inst.sessionName, instanceId: inst.instanceId }
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

type GlobalVoiceControlProps = {
  capability: CapabilityState
  state: InteractionState
  /** The live idle target the mic records into; null disables the mic. The target
   *  indicator + its selector live in the ComposeTray (TargetSelector). */
  target: VoiceInstance | null
  onRecord: () => void
  onStop: () => void
}

export function GlobalVoiceControl({
  capability, state, target, onRecord, onStop,
}: GlobalVoiceControlProps) {
  const visual = resolveVisual(state)
  const ready = capability.status === 'ready'
  const unavailable = capability.status === 'unavailable' ? capability.message : undefined
  const hasTarget = !!target
  const micDisabled = !ready || (visual === 'ready' && !hasTarget)

  const handleMic = () => {
    if (visual === 'recording') onStop()
    else if (visual === 'ready' && hasTarget) onRecord()
    // 'processing' — a take is in flight; ignore.
  }

  return (
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
  )
}
