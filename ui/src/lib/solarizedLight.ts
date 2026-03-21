import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

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

export const solarizedHighlight = HighlightStyle.define([
  { tag: tags.comment, color: SOLARIZED_LIGHT.base1, fontStyle: 'italic' },
  { tag: [tags.string, tags.attributeValue, tags.monospace], color: SOLARIZED_LIGHT.cyan },
  { tag: tags.regexp, color: SOLARIZED_LIGHT.red },
  { tag: tags.number, color: SOLARIZED_LIGHT.magenta },
  { tag: [tags.bool, tags.null, tags.atom], color: SOLARIZED_LIGHT.yellow },
  {
    tag: [
      tags.keyword,
      tags.operator,
      tags.operatorKeyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
    ],
    color: SOLARIZED_LIGHT.green,
  },
  { tag: tags.modifier, color: SOLARIZED_LIGHT.base01, fontWeight: 'bold' },
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
    color: SOLARIZED_LIGHT.blue,
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: SOLARIZED_LIGHT.orange },
  { tag: tags.attributeName, color: SOLARIZED_LIGHT.base1 },
  { tag: tags.meta, color: SOLARIZED_LIGHT.orange },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: SOLARIZED_LIGHT.blue, fontWeight: 'bold' },
  { tag: tags.quote, color: SOLARIZED_LIGHT.green },
  { tag: tags.list, color: SOLARIZED_LIGHT.yellow },
  { tag: [tags.emphasis, tags.strong], color: SOLARIZED_LIGHT.magenta },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.contentSeparator, color: SOLARIZED_LIGHT.border },
  { tag: tags.invalid, color: SOLARIZED_LIGHT.red },
  { tag: tags.content, color: SOLARIZED_LIGHT.editorForeground },
])

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
})
