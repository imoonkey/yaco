// EditorActions — the editor body's view controls: the inline-suggestion sparkle
// (non-diff tabs) plus the md/html preview-mode segmented control and its
// split-direction toggle (previewable files only). Rendered RIGHT-ALIGNED in the
// group tab bar on desktop, and in the slim mobile editor action row (no tab bar
// there); both act on the active editor tab through `onSetEditorPrefs`. Behaviour
// is identical to the old inline editor-body row — only the location moved.
import { Sparkles, Columns2, Rows2 } from 'lucide-react'
import { isDiffTab, isFileTab, type PreviewMode, type SplitDirection } from '../hooks/workspaceTypes'
import { isBinaryPreviewFile, isPreviewableFile } from '../lib/binaryFiles'
import type { EditorPrefs } from './context'

const SUGGESTIONS_BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 22, padding: 0,
  fontSize: 'var(--text-ui-sm)', border: 'none', borderRadius: 3, cursor: 'pointer',
}

// The markdown/html preview-mode segmented control + its split-direction toggle.
function PreviewModeToggle({ mode, splitDirection, onChange, onDirectionChange, isTouch }: {
  mode: PreviewMode; splitDirection: SplitDirection
  onChange: (m: PreviewMode) => void; onDirectionChange: (d: SplitDirection) => void; isTouch: boolean
}) {
  const modes: { value: PreviewMode; label: string }[] = isTouch
    ? [{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]
    : [{ value: 'edit', label: 'Edit' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]

  return (
    <div className="flex items-center gap-1 shrink-0">
      <div className="flex rounded border overflow-hidden" style={{ borderColor: 'var(--sol-border)' }}>
        {modes.map(({ value, label }) => {
          const active = mode === value
          return (
            <button key={value} onClick={() => onChange(value)}
              className="text-ui-xs px-2 py-0.5 cursor-pointer"
              style={{
                backgroundColor: active ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'var(--sol-bg)',
                color: active ? 'var(--sol-accent)' : 'var(--sol-text)',
                borderRight: value !== modes[modes.length - 1].value ? '1px solid var(--sol-border)' : undefined,
              }}>
              {label}
            </button>
          )
        })}
      </div>
      {mode === 'split' && !isTouch && (
        <button
          onClick={() => onDirectionChange(splitDirection === 'horizontal' ? 'vertical' : 'horizontal')}
          className="flex items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg"
          style={{ width: 20, height: 20, color: 'var(--sol-text-dim)', transition: 'background-color 120ms' }}
          title={splitDirection === 'horizontal' ? 'Switch to vertical split' : 'Switch to horizontal split'}
        >
          {splitDirection === 'horizontal' ? <Rows2 size={12} /> : <Columns2 size={12} />}
        </button>
      )}
    </div>
  )
}

export interface EditorActionsProps {
  /** The active editor tab's `tabId` (a file path or `diff:` id). */
  tabId: string
  previewMode: PreviewMode
  splitDirection: SplitDirection
  autocompleteEnabled: boolean
  isTouch: boolean
  onSetEditorPrefs: (patch: Partial<EditorPrefs>) => void
}

export function EditorActions({ tabId, previewMode, splitDirection, autocompleteEnabled, isTouch, onSetEditorPrefs }: EditorActionsProps) {
  const filePath = isFileTab(tabId) ? tabId : null
  const canTogglePreview = !!filePath && isPreviewableFile(filePath) && !isBinaryPreviewFile(filePath)
  const showSuggestions = !isDiffTab(tabId)
  if (!canTogglePreview && !showSuggestions) return null

  const suggestionsLabel = autocompleteEnabled
    ? 'Suggestions: disable inline suggestions'
    : 'Suggestions: enable inline suggestions'
  const suggestionsTitle = autocompleteEnabled
    ? 'Disable inline suggestions'
    : 'Enable inline suggestions - sends nearby markdown text to the model provider'

  return (
    <div className="flex items-center gap-1 shrink-0">
      {showSuggestions && (
        <button
          onClick={() => onSetEditorPrefs({ autocompleteEnabled: !autocompleteEnabled })}
          title={suggestionsTitle}
          aria-label={suggestionsLabel}
          aria-pressed={autocompleteEnabled}
          style={{
            ...SUGGESTIONS_BTN,
            background: autocompleteEnabled ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'transparent',
            color: autocompleteEnabled ? 'var(--sol-text)' : 'var(--sol-text-dim)',
            opacity: autocompleteEnabled ? 1 : 0.6,
          }}
        >
          <Sparkles size={13} aria-hidden="true" />
        </button>
      )}
      {canTogglePreview && (
        <PreviewModeToggle
          mode={previewMode}
          splitDirection={splitDirection}
          onChange={(mode) => onSetEditorPrefs({ previewMode: mode })}
          onDirectionChange={(dir) => onSetEditorPrefs({ splitDirection: dir })}
          isTouch={isTouch}
        />
      )}
    </div>
  )
}
