// @vitest-environment node
//
// Pure logic for the desktop global voice control (mi-voice-global, design §G):
//   - which editor/terminal instances are eligible voice targets,
//   - the default-from-focus target precedence (recentMultiKind → other → first),
//   - the chosen-instance → record/retarget context mapping, and
//   - the run-target → display instance mapping.
import { describe, it, expect } from 'vitest'
import {
  resolveVoiceTarget, instanceFromTarget, targetContextOf, isEditorVoiceEligible,
  type ResolveVoiceTargetArgs,
} from '../GlobalVoiceControl'
import {
  voiceReducer, INITIAL_STATE, selectTarget, selectInteractionState, type VoiceTargetContext,
} from '../../hooks/voiceStateMachine'
import { type LayoutNode, type GroupTab } from '../../hooks/workspaceTypes'

// An editor GroupTab (the eligible-target unit under FLAT).
const et = (tabId: string): GroupTab => ({ instanceId: 'editor', kind: 'editor', tabId })

// A tree of editor tabs keyed by instance id. An instance with no editor tab here
// is ineligible (editorVoiceTab → null), modelling the old `ev(null)` empty pane.
function mkTree(editors: Record<string, string>): LayoutNode {
  const tabs: GroupTab[] = Object.entries(editors).map(([instanceId, tabId]) => ({ instanceId, kind: 'editor', tabId }))
  return { kind: 'tabs', id: 'group:1', tabs, activeTab: tabs[0]?.instanceId ?? '' }
}

// A baseline: two editors on plain code files, one bound terminal.
function base(overrides: Partial<ResolveVoiceTargetArgs> = {}): ResolveVoiceTargetArgs {
  return {
    editorIds: ['editor', 'editor:2'],
    terminalIds: ['terminal'],
    tree: mkTree({ editor: 'a.ts', 'editor:2': 'b.ts' }),
    terminalBindings: { terminal: 's1' },
    previewMode: 'edit',
    showingTasks: false,
    activeEditorId: 'editor:2',
    activeTerminalId: 'terminal',
    recentMultiKind: 'editor',
    ...overrides,
  }
}

describe('resolveVoiceTarget — eligible instances', () => {
  it('lists every editor with an editable file plus every bound terminal, editors first', () => {
    const { instances } = resolveVoiceTarget(base())
    expect(instances).toEqual([
      { kind: 'editor', instanceId: 'editor', label: 'a.ts', filePath: 'a.ts' },
      { kind: 'editor', instanceId: 'editor:2', label: 'b.ts', filePath: 'b.ts' },
      { kind: 'terminal', instanceId: 'terminal', label: 's1', sessionName: 's1' },
    ])
  })

  it('labels an editor by its file basename, a terminal by its session name', () => {
    const { instances } = resolveVoiceTarget(base({
      tree: mkTree({ editor: 'src/deep/Thing.tsx' }),
    }))
    expect(instances[0]).toMatchObject({ instanceId: 'editor', label: 'Thing.tsx' })
  })

  it('excludes an editor whose active tab is empty or a diff tab', () => {
    const { instances } = resolveVoiceTarget(base({
      tree: mkTree({ 'editor:2': 'diff:b.ts' }),
    }))
    expect(instances.filter(i => i.kind === 'editor')).toEqual([])
  })

  it('excludes a previewable file shown in preview mode, keeps it in split mode', () => {
    const md = base({ editorIds: ['editor'], tree: mkTree({ editor: 'README.md' }), activeEditorId: 'editor' })
    expect(resolveVoiceTarget({ ...md, previewMode: 'preview' }).instances.some(i => i.kind === 'editor')).toBe(false)
    expect(resolveVoiceTarget({ ...md, previewMode: 'split' }).instances.some(i => i.kind === 'editor')).toBe(true)
  })

  it('keeps a non-previewable file editable even in preview mode', () => {
    const code = base({ editorIds: ['editor'], tree: mkTree({ editor: 'a.ts' }), activeEditorId: 'editor', previewMode: 'preview' })
    expect(resolveVoiceTarget(code).instances.some(i => i.kind === 'editor')).toBe(true)
  })

  it('excludes every editor while the active surface shows tasks (it is hidden)', () => {
    const { instances } = resolveVoiceTarget(base({ showingTasks: true }))
    expect(instances.map(i => i.instanceId)).toEqual(['terminal'])
  })

  it('excludes an unbound terminal', () => {
    const { instances } = resolveVoiceTarget(base({ terminalBindings: { terminal: '' } }))
    expect(instances.some(i => i.kind === 'terminal')).toBe(false)
  })
})

describe('resolveVoiceTarget — default from focus', () => {
  it('picks the active instance of the most-recently-focused kind when eligible', () => {
    expect(resolveVoiceTarget(base({ recentMultiKind: 'editor' })).target)
      .toMatchObject({ kind: 'editor', instanceId: 'editor:2' })
    expect(resolveVoiceTarget(base({ recentMultiKind: 'terminal' })).target)
      .toMatchObject({ kind: 'terminal', instanceId: 'terminal' })
  })

  it('falls back to the other type when the recent kind has no eligible active instance', () => {
    // recent kind = editor, but every editor shows a diff (ineligible) → terminal.
    const args = base({ recentMultiKind: 'editor', tree: mkTree({ editor: 'diff:a.ts', 'editor:2': 'diff:b.ts' }) })
    expect(resolveVoiceTarget(args).target).toMatchObject({ kind: 'terminal', instanceId: 'terminal' })
  })

  it('falls back to the first eligible instance in order when neither active instance is eligible', () => {
    // active editor + active terminal both ineligible; editor (first) is still eligible.
    const args = base({
      recentMultiKind: 'terminal',
      activeEditorId: 'editor:2',
      tree: mkTree({ editor: 'a.ts', 'editor:2': 'diff:b.ts' }),
      terminalBindings: { terminal: '' },
    })
    expect(resolveVoiceTarget(args).target).toMatchObject({ kind: 'editor', instanceId: 'editor' })
  })

  it('returns no target and no instances when nothing is eligible', () => {
    const args = base({
      tree: mkTree({}),
      terminalBindings: { terminal: '' },
    })
    const { instances, target } = resolveVoiceTarget(args)
    expect(instances).toEqual([])
    expect(target).toBeNull()
  })
})

describe('targetContextOf — chosen instance → record/retarget context', () => {
  it('maps an editor instance to an editor context', () => {
    expect(targetContextOf({ kind: 'editor', instanceId: 'editor:2', label: 'a.ts', filePath: 'src/a.ts' }))
      .toEqual({ surface: 'editor', filePath: 'src/a.ts', instanceId: 'editor:2' })
  })
  it('maps a terminal instance to a terminal context', () => {
    expect(targetContextOf({ kind: 'terminal', instanceId: 'terminal:2', label: 's1', sessionName: 's1' }))
      .toEqual({ surface: 'terminal', sessionName: 's1', instanceId: 'terminal:2' })
  })
})

describe('instanceFromTarget — frozen target → display instance', () => {
  it('maps an editor target to a file-labelled instance', () => {
    expect(instanceFromTarget({ surface: 'editor', filePath: 'src/a.ts', instanceId: 'editor:2' }))
      .toEqual({ kind: 'editor', instanceId: 'editor:2', label: 'a.ts', filePath: 'src/a.ts' })
  })

  it('maps a terminal target to a session-labelled instance', () => {
    expect(instanceFromTarget({ surface: 'terminal', sessionName: 's1', instanceId: 'terminal:2' }))
      .toEqual({ kind: 'terminal', instanceId: 'terminal:2', label: 's1', sessionName: 's1' })
  })

  it('returns null for no target or a target without an instance id', () => {
    expect(instanceFromTarget(null)).toBeNull()
    expect(instanceFromTarget({ surface: 'editor', filePath: 'a.ts' })).toBeNull()
  })
})

describe('isEditorVoiceEligible — shared editable-target predicate', () => {
  it('accepts an editable file tab', () => {
    expect(isEditorVoiceEligible(et('a.ts'), 'edit', false)).toBe(true)
  })
  it('rejects an empty pane and a diff tab', () => {
    expect(isEditorVoiceEligible(null, 'edit', false)).toBe(false)
    expect(isEditorVoiceEligible(et('diff:a.ts'), 'edit', false)).toBe(false)
  })
  it('rejects a previewable file rendered in preview mode, accepts it in split/edit', () => {
    expect(isEditorVoiceEligible(et('README.md'), 'preview', false)).toBe(false)
    expect(isEditorVoiceEligible(et('README.md'), 'split', false)).toBe(true)
    expect(isEditorVoiceEligible(et('README.md'), 'edit', false)).toBe(true)
  })
  it('keeps a non-previewable file editable even in preview mode', () => {
    expect(isEditorVoiceEligible(et('a.ts'), 'preview', false)).toBe(true)
  })
  it('rejects any editor while tasks overlays the active surface', () => {
    expect(isEditorVoiceEligible(et('a.ts'), 'edit', true)).toBe(false)
  })
})

describe('voiceStateMachine — RETARGET re-points the open run', () => {
  const EDITOR: VoiceTargetContext = { surface: 'editor', filePath: 'a.ts', instanceId: 'editor:2' }
  const TERMINAL: VoiceTargetContext = { surface: 'terminal', sessionName: 's9', instanceId: 'terminal:3' }

  it('changes the run target while composing', () => {
    let state = voiceReducer(INITIAL_STATE, { type: 'OPEN', target: EDITOR })
    state = voiceReducer(state, { type: 'RETARGET', target: TERMINAL })
    expect(selectTarget(state.phase)?.instanceId).toBe('terminal:3')
    expect(selectTarget(state.phase)?.surface).toBe('terminal')
  })

  it('recovers a lost run: clears targetLost (recoverable → composing)', () => {
    let state = voiceReducer(INITIAL_STATE, { type: 'OPEN', target: EDITOR })
    state = voiceReducer(state, { type: 'TARGET_LOST' })
    expect(selectInteractionState(state.phase)).toBe('recoverable')
    state = voiceReducer(state, { type: 'RETARGET', target: TERMINAL })
    expect(selectInteractionState(state.phase)).toBe('composing')
  })

  it('is ignored while idle (no open run to re-point)', () => {
    const state = voiceReducer(INITIAL_STATE, { type: 'RETARGET', target: EDITOR })
    expect(state).toBe(INITIAL_STATE)
  })

  it('re-points a take that is still in flight (routing only binds at Insert)', () => {
    let state = voiceReducer(INITIAL_STATE, { type: 'START_RECORD', target: EDITOR, runId: 1 })
    state = voiceReducer(state, { type: 'PERMISSION_GRANTED', startedAt: 1, runId: 1 }) // recording
    state = voiceReducer(state, { type: 'RETARGET', target: TERMINAL })
    expect(selectInteractionState(state.phase)).toBe('recording')
    expect(selectTarget(state.phase)?.instanceId).toBe('terminal:3')
  })
})

describe('voiceStateMachine — instanceId frozen at record start', () => {
  const TARGET: VoiceTargetContext = { surface: 'editor', filePath: 'a.ts', instanceId: 'editor:2' }

  it('keeps the bound instanceId through a take and across a re-record from composing', () => {
    let state = voiceReducer(INITIAL_STATE, { type: 'START_RECORD', target: TARGET, runId: 1 })
    state = voiceReducer(state, { type: 'PERMISSION_GRANTED', startedAt: 1, runId: 1 })
    state = voiceReducer(state, { type: 'STOP', runId: 1 })
    state = voiceReducer(state, { type: 'TRANSCRIBED', runId: 1 })
    expect(selectTarget(state.phase)?.instanceId).toBe('editor:2')
    // A second take from composing reuses the run's target — instanceId stays put.
    const again = voiceReducer(state, {
      type: 'START_RECORD', target: { surface: 'terminal', sessionName: 's9', instanceId: 'terminal:3' }, runId: 2,
    })
    expect(selectTarget(again.phase)?.instanceId).toBe('editor:2')
  })
})

