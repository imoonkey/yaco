import { EditorView } from '@codemirror/view'

export const SOLARIZED_LIGHT = {
  base03: '#002B36',
  base02: '#073642',
  base01: '#586E75',
  base00: '#657B83',
  base0: '#839496',
  base1: '#93A1A1',
  base2: '#EEE8D5',
  base3: '#FDF6E3',
  yellow: '#B58900',
  orange: '#CB4B16',
  red: '#DC322F',
  magenta: '#D33682',
  violet: '#6C71C4',
  blue: '#268BD2',
  cyan: '#2AA198',
  green: '#859900',
  focusBorder: '#B49471',
  inputBackground: '#DDD6C1',
  inputForeground: '#586E75',
  listActiveSelectionBackground: '#DFCA88',
  listActiveSelectionForeground: '#6C6C6C',
  listHoverBackground: '#DFCA8844',
  quickInputListFocusBackground: '#DFCA8866',
  editorBackground: '#FDF6E3',
  editorForeground: '#657B83',
  editorWidgetBackground: '#EEE8D5',
  editorCursorForeground: '#657B83',
  editorWhitespaceForeground: '#586E7580',
  editorLineHighlightBackground: '#EEE8D5',
  editorSelectionBackground: '#D5CCB5',
  editorIndentGuideBackground: '#586E7580',
  editorIndentGuideActiveBackground: '#081E2580',
  editorLineNumberActiveForeground: '#567983',
  tabsBackground: '#D9D2C2',
  tabInactiveBackground: '#D3CBB7',
  border: '#DDD6C1',
  activityBarForeground: '#584C27',
  buttonBackground: '#AC9D57',
} as const

type WorkspacePalette = {
  bg: string
  editorBg: string
  headerBg: string
  border: string
  text: string
  textDim: string
  textDark: string
  textBrown: string
  muted: string
  accent: string
  hover: string
  sash: string
}

export const SOLARIZED_LIGHT_UI: WorkspacePalette = {
  bg: SOLARIZED_LIGHT.base2,
  editorBg: SOLARIZED_LIGHT.editorBackground,
  headerBg: SOLARIZED_LIGHT.tabsBackground,
  border: SOLARIZED_LIGHT.border,
  text: SOLARIZED_LIGHT.base01,
  textDim: SOLARIZED_LIGHT.base00,
  textDark: SOLARIZED_LIGHT.base02,
  textBrown: SOLARIZED_LIGHT.activityBarForeground,
  muted: SOLARIZED_LIGHT.base1,
  accent: SOLARIZED_LIGHT.blue,
  hover: SOLARIZED_LIGHT.listHoverBackground,
  sash: SOLARIZED_LIGHT.activityBarForeground,
}

export const solarizedLight = EditorView.theme({
  '&': {
    backgroundColor: SOLARIZED_LIGHT.editorBackground,
    color: SOLARIZED_LIGHT.editorForeground,
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    fontSize: '13px',
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
    caretColor: SOLARIZED_LIGHT.editorCursorForeground,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: SOLARIZED_LIGHT.editorCursorForeground,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: SOLARIZED_LIGHT.editorSelectionBackground,
  },
  '.cm-activeLine': {
    backgroundColor: SOLARIZED_LIGHT.editorLineHighlightBackground,
  },
  '.cm-gutters': {
    backgroundColor: SOLARIZED_LIGHT.editorBackground,
    color: SOLARIZED_LIGHT.base1,
    borderRight: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement, .cm-foldGutter .cm-gutterElement': {
    color: SOLARIZED_LIGHT.base1,
  },
  '.cm-activeLineGutter': {
    backgroundColor: SOLARIZED_LIGHT.editorBackground,
    color: SOLARIZED_LIGHT.editorLineNumberActiveForeground,
  },
  '.cm-foldPlaceholder': {
    backgroundColor: SOLARIZED_LIGHT.base2,
    border: `1px solid ${SOLARIZED_LIGHT.border}`,
    color: SOLARIZED_LIGHT.base01,
  },
  '.cm-tooltip': {
    backgroundColor: SOLARIZED_LIGHT.editorWidgetBackground,
    border: `1px solid ${SOLARIZED_LIGHT.border}`,
    color: SOLARIZED_LIGHT.base01,
  },
  '.cm-panels': {
    backgroundColor: SOLARIZED_LIGHT.editorWidgetBackground,
    color: SOLARIZED_LIGHT.base01,
  },
  '.cm-searchMatch': {
    backgroundColor: SOLARIZED_LIGHT.quickInputListFocusBackground,
    outline: `1px solid ${SOLARIZED_LIGHT.focusBorder}`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: SOLARIZED_LIGHT.listActiveSelectionBackground,
  },
  '.cm-selectionMatch': {
    backgroundColor: SOLARIZED_LIGHT.editorSelectionBackground,
  },
  '.cm-matchingBracket': {
    backgroundColor: SOLARIZED_LIGHT.editorSelectionBackground,
    outline: `1px solid ${SOLARIZED_LIGHT.border}`,
  },
  '.cm-nonmatchingBracket': {
    color: SOLARIZED_LIGHT.red,
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
    backgroundColor: SOLARIZED_LIGHT.green,
  },
  '.cm-diff-modified': {
    width: '3px',
    height: '100%',
    backgroundColor: SOLARIZED_LIGHT.blue,
  },
  '.cm-diff-deleted': {
    width: '0',
    height: '0',
    borderTop: '4px solid transparent',
    borderBottom: '4px solid transparent',
    borderRight: `6px solid ${SOLARIZED_LIGHT.red}`,
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
    backgroundColor: SOLARIZED_LIGHT.editorWidgetBackground,
    border: `1px solid ${SOLARIZED_LIGHT.border}`,
    borderLeft: '3px solid',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    fontSize: '12px',
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
    borderBottom: `1px solid ${SOLARIZED_LIGHT.border}`,
    color: SOLARIZED_LIGHT.base1,
    fontSize: '11px',
  },
  '.cm-diff-popup-close': {
    background: 'none',
    border: 'none',
    color: SOLARIZED_LIGHT.base1,
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: '1',
    padding: '0 2px',
  },
  '.cm-diff-popup-close:hover': {
    color: SOLARIZED_LIGHT.base01,
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
    color: SOLARIZED_LIGHT.green,
  },
  '.cm-diff-popup-del': {
    backgroundColor: 'rgba(220, 50, 47, 0.1)',
    color: SOLARIZED_LIGHT.red,
  },
  '.cm-diff-popup-normal': {
    color: SOLARIZED_LIGHT.base00,
  },
  '.cm-diff-popup-badge': {
    fontSize: '11px',
    fontWeight: '600',
  },
  '.cm-diff-popup-nav': {
    background: 'none',
    border: `1px solid ${SOLARIZED_LIGHT.border}`,
    borderRadius: '3px',
    color: SOLARIZED_LIGHT.base01,
    cursor: 'pointer',
    fontSize: '11px',
    padding: '0 4px',
    height: '18px',
    lineHeight: '16px',
  },
  '.cm-diff-popup-nav:hover': {
    backgroundColor: SOLARIZED_LIGHT.base2,
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
    color: SOLARIZED_LIGHT.base1,
    userSelect: 'none',
  },
  '.cm-diff-popup-showmore': {
    textAlign: 'center',
    color: SOLARIZED_LIGHT.blue,
    fontSize: '11px',
    padding: '4px 0',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-diff-popup-showmore:hover': {
    backgroundColor: 'rgba(38, 139, 210, 0.08)',
  },
})
