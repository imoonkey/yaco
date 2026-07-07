// EditorActions — editor view controls: the inline-suggestion sparkle (non-diff
// tabs) plus the md/html preview-mode segmented control and its split-direction
// toggle (previewable files only). Rendered right-aligned in the desktop group tab
// bar and in the mobile projection's editor tab row.
import { Sparkles, Columns2, Rows2, Pencil, Eye } from 'lucide-react'
import { isDiffTab, isFileTab, type PreviewMode, type SplitDirection, type EditorTabView } from '../hooks/workspaceTypes'
import { isBinaryPreviewFile, isPreviewableFile } from '../lib/binaryFiles'

const SUGGESTIONS_BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 22, padding: 0,
  fontSize: 'var(--text-ui-sm)', border: 'none', borderRadius: 3, cursor: 'pointer',
}

// The markdown/html preview-mode segmented control. The split button owns the
// direction toggle when split mode is already active.
function PreviewModeToggle({ mode, splitDirection, onChange, onDirectionChange, isTouch }: {
  mode: PreviewMode; splitDirection: SplitDirection
  onChange: (m: PreviewMode) => void; onDirectionChange: (d: SplitDirection) => void; isTouch: boolean
}) {
  const splitIcon = splitDirection === 'horizontal'
    ? <Columns2 size={13} aria-hidden="true" />
    : <Rows2 size={13} aria-hidden="true" />
  const modes: { value: PreviewMode; label: string; title: string; icon: React.ReactNode }[] = isTouch
    ? [
        { value: 'edit', label: 'Edit', title: 'Edit', icon: <Pencil size={13} aria-hidden="true" /> },
        { value: 'preview', label: 'Preview', title: 'Preview', icon: <Eye size={13} aria-hidden="true" /> },
      ]
    : [
        { value: 'edit', label: 'Edit', title: 'Edit', icon: <Pencil size={13} aria-hidden="true" /> },
        { value: 'split', label: splitDirection === 'horizontal' ? 'Split preview right' : 'Split preview down', title: splitDirection === 'horizontal' ? 'Split preview right' : 'Split preview down', icon: splitIcon },
        { value: 'preview', label: 'Preview', title: 'Preview', icon: <Eye size={13} aria-hidden="true" /> },
      ]
  const toggleSplitDirection = () => {
    onDirectionChange(splitDirection === 'horizontal' ? 'vertical' : 'horizontal')
  }

  return (
    <div className="flex items-center shrink-0">
      <div className="flex rounded border overflow-hidden" style={{ borderColor: 'var(--sol-border)' }}>
        {modes.map(({ value, label, title, icon }) => {
          const active = mode === value
          const click = () => {
            if (value === 'split' && active) {
              toggleSplitDirection()
              return
            }
            onChange(value)
          }
          return (
            <button key={value} onClick={click}
              aria-label={value === 'split' && active
                ? (splitDirection === 'horizontal' ? 'Switch split preview down' : 'Switch split preview right')
                : label}
              aria-pressed={active}
              title={value === 'split' && active
                ? (splitDirection === 'horizontal' ? 'Switch split preview down' : 'Switch split preview right')
                : title}
              className="flex items-center justify-center cursor-pointer"
              style={{
                width: 26,
                height: 22,
                backgroundColor: active ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'var(--sol-bg)',
                color: active ? 'var(--sol-accent)' : 'var(--sol-text)',
                borderRight: value !== modes[modes.length - 1].value ? '1px solid var(--sol-border)' : undefined,
              }}>
              {icon}
            </button>
          )
        })}
      </div>
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
  /** Patch the active tab's PER-TAB view (previewMode/splitDirection). */
  onSetView: (patch: Partial<EditorTabView>) => void
  /** Toggle the GLOBAL inline-suggestion preference. */
  onSetAutocomplete: (enabled: boolean) => void
}

export function EditorActions({ tabId, previewMode, splitDirection, autocompleteEnabled, isTouch, onSetView, onSetAutocomplete }: EditorActionsProps) {
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
    <div className="flex items-center gap-0.5 shrink-0">
      {showSuggestions && (
        <button
          onClick={() => onSetAutocomplete(!autocompleteEnabled)}
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
          onChange={(mode) => onSetView({ previewMode: mode })}
          onDirectionChange={(dir) => onSetView({ splitDirection: dir })}
          isTouch={isTouch}
        />
      )}
    </div>
  )
}
