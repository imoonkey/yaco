import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * Static CodeMirror editor theme using CSS custom properties.
 * CSS vars cascade from :root / [data-theme="dark"] in index.css,
 * so theme switches are automatic — no compartment or remount needed.
 */
export const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--sol-editor-bg)',
    color: 'var(--sol-editor-fg)',
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    fontSize: 'var(--text-ui-lg)',
    height: '100%',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    lineHeight: '1.6',
  },
  '.cm-content': {
    caretColor: 'var(--sol-editor-cursor)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--sol-editor-cursor)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sol-editor-selection-bg)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--sol-editor-line-highlight-bg)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--sol-editor-bg)',
    color: 'var(--sol-base1)',
    borderRight: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: 'var(--sol-base1)',
    padding: '0 8px 0 4px',
    minWidth: '3ch',
  },
  '.cm-foldGutter .cm-gutterElement': {
    color: 'var(--sol-base1)',
    padding: '0 2px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--sol-editor-bg)',
    color: 'var(--sol-editor-linenum-active)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--sol-editor-widget-bg)',
    border: '1px solid var(--sol-border)',
    color: 'var(--sol-base01)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--sol-editor-widget-bg)',
    border: '1px solid var(--sol-border)',
    color: 'var(--sol-base01)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--sol-editor-widget-bg)',
    color: 'var(--sol-base01)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--sol-search-match-bg)',
    outline: '1px solid var(--sol-focus-border)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--sol-list-active-bg)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--sol-editor-selection-bg)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--sol-editor-selection-bg)',
    outline: '1px solid var(--sol-border)',
  },
  '.cm-nonmatchingBracket': {
    color: 'var(--sol-red)',
  },
  // Diff gutter
  '.cm-diff-gutter': {
    width: '8px',
    minWidth: '8px',
    cursor: 'pointer',
  },
  '.cm-diff-gutter .cm-gutterElement': {
    padding: '0',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  '.cm-diff-added': {
    width: '3px',
    height: '100%',
    backgroundColor: 'var(--sol-green)',
  },
  '.cm-diff-modified': {
    width: '3px',
    height: '100%',
    backgroundColor: 'var(--sol-blue)',
  },
  '.cm-diff-deleted': {
    width: '0',
    height: '0',
    borderTop: '4px solid transparent',
    borderBottom: '4px solid transparent',
    borderRight: '6px solid var(--sol-red)',
    alignSelf: 'center',
  },
  // Line tints
  '.cm-diff-added-line': {
    backgroundColor: 'rgba(133, 153, 0, 0.06)',
  },
  '.cm-diff-modified-line': {
    backgroundColor: 'rgba(38, 139, 210, 0.06)',
  },
  // Diff popup
  '.cm-diff-popup': {
    backgroundColor: 'var(--sol-editor-widget-bg)',
    border: '1px solid var(--sol-border)',
    borderLeft: '3px solid',
    boxShadow: 'var(--elevation-1)',
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    fontSize: 'var(--text-ui-md)',
    lineHeight: '1.5',
    maxHeight: '300px',
    overflowY: 'auto',
    margin: '2px 0',
  },
  '.cm-diff-popup-header': {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '4px 8px',
    borderBottom: '1px solid var(--sol-border)',
    color: 'var(--sol-base1)',
    fontSize: 'var(--text-ui-sm)',
  },
  '.cm-diff-popup-close': {
    background: 'none',
    border: 'none',
    color: 'var(--sol-base1)',
    cursor: 'pointer',
    fontSize: 'var(--text-ui-xl)',
    lineHeight: '1',
    padding: '0 2px',
  },
  '.cm-diff-popup-close:hover': {
    color: 'var(--sol-base01)',
  },
  '.cm-diff-popup-body': {
    padding: '4px 0',
    overflowX: 'auto',
  },
  '.cm-diff-popup-line': {
    padding: '0 8px',
    whiteSpace: 'pre',
    minHeight: '18px',
  },
  '.cm-diff-popup-add': {
    backgroundColor: 'rgba(133, 153, 0, 0.1)',
    color: 'var(--sol-green)',
  },
  '.cm-diff-popup-del': {
    backgroundColor: 'rgba(220, 50, 47, 0.1)',
    color: 'var(--sol-red)',
  },
  '.cm-diff-popup-normal': {
    color: 'var(--sol-base00)',
  },
  '.cm-diff-popup-badge': {
    fontSize: 'var(--text-ui-sm)',
    fontWeight: '600',
  },
  '.cm-diff-popup-nav': {
    background: 'none',
    border: '1px solid var(--sol-border)',
    borderRadius: '3px',
    color: 'var(--sol-base01)',
    cursor: 'pointer',
    fontSize: 'var(--text-ui-sm)',
    padding: '0 4px',
    height: '18px',
    lineHeight: '16px',
  },
  '.cm-diff-popup-nav:hover': {
    backgroundColor: 'var(--sol-editor-widget-bg)',
  },
  '.cm-diff-popup-nav:disabled': {
    opacity: '0.3',
    cursor: 'default',
  },
  '.cm-diff-popup-linenum': {
    display: 'inline-block',
    width: '28px',
    textAlign: 'right',
    paddingRight: '6px',
    color: 'var(--sol-base1)',
    userSelect: 'none',
  },
  '.cm-diff-popup-showmore': {
    textAlign: 'center',
    color: 'var(--sol-blue)',
    fontSize: 'var(--text-ui-sm)',
    padding: '4px 0',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-diff-popup-showmore:hover': {
    backgroundColor: 'rgba(38, 139, 210, 0.08)',
  },
})

/**
 * Syntax highlighting using CSS custom properties.
 * HighlightStyle.define() generates CSS class rules (e.g. `.tok-keyword { color: ... }`),
 * so var() values cascade with data-theme — no compartment needed.
 *
 * Accent colors (green, cyan, blue, etc.) are identical across light/dark.
 * Gray-scale colors (comments, modifiers) use semantic vars that flip per theme.
 */
export const editorHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--sol-syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.string, tags.attributeValue, tags.monospace], color: 'var(--sol-cyan)' },
  { tag: tags.regexp, color: 'var(--sol-red)' },
  { tag: tags.number, color: 'var(--sol-magenta)' },
  { tag: [tags.bool, tags.null, tags.atom], color: 'var(--sol-yellow)' },
  {
    tag: [
      tags.keyword,
      tags.operator,
      tags.operatorKeyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
    ],
    color: 'var(--sol-green)',
  },
  { tag: tags.modifier, color: 'var(--sol-syntax-modifier)', fontWeight: 'bold' },
  {
    tag: [
      tags.variableName,
      tags.propertyName,
      tags.function(tags.variableName),
      tags.labelName,
      tags.link,
      tags.url,
      tags.tagName,
    ],
    color: 'var(--sol-blue)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--sol-orange)' },
  { tag: tags.attributeName, color: 'var(--sol-syntax-comment)' },
  { tag: tags.meta, color: 'var(--sol-orange)' },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: 'var(--sol-blue)', fontWeight: 'bold' },
  { tag: tags.quote, color: 'var(--sol-green)' },
  { tag: tags.list, color: 'var(--sol-yellow)' },
  { tag: [tags.emphasis, tags.strong], color: 'var(--sol-magenta)' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.contentSeparator, color: 'var(--sol-border)' },
  { tag: tags.invalid, color: 'var(--sol-red)' },
  { tag: tags.content, color: 'var(--sol-editor-fg)' },
])
