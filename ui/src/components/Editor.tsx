import { useRef, useEffect } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, scrollPastEnd } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'

// Solarized Light syntax highlighting
const solarizedHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: '#cb4b16', fontWeight: 'bold', fontSize: '1.4em' },
  { tag: tags.heading2, color: '#cb4b16', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading3, color: '#cb4b16', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#cb4b16', fontWeight: 'bold' },
  { tag: tags.keyword, color: '#859900' },
  { tag: tags.comment, color: '#93a1a1', fontStyle: 'italic' },
  { tag: tags.string, color: '#2aa198' },
  { tag: tags.number, color: '#d33682' },
  { tag: tags.bool, color: '#d33682' },
  { tag: tags.null, color: '#d33682' },
  { tag: tags.operator, color: '#859900' },
  { tag: tags.variableName, color: '#268bd2' },
  { tag: tags.function(tags.variableName), color: '#268bd2' },
  { tag: tags.typeName, color: '#b58900' },
  { tag: tags.className, color: '#b58900' },
  { tag: tags.propertyName, color: '#268bd2' },
  { tag: tags.definition(tags.variableName), color: '#268bd2' },
  { tag: tags.meta, color: '#cb4b16' },
  { tag: tags.link, color: '#268bd2', textDecoration: 'underline' },
  { tag: tags.url, color: '#268bd2', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#586e75' },
  { tag: tags.strong, fontWeight: 'bold', color: '#586e75' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, color: '#2aa198', fontFamily: 'inherit' },
  { tag: tags.processingInstruction, color: '#93a1a1' },
  { tag: tags.labelName, color: '#d33682' },
  { tag: tags.quote, color: '#93a1a1', fontStyle: 'italic' },
  { tag: tags.atom, color: '#d33682' },
  { tag: tags.regexp, color: '#dc322f' },
  { tag: tags.tagName, color: '#268bd2' },
  { tag: tags.attributeName, color: '#b58900' },
  { tag: tags.attributeValue, color: '#2aa198' },
  { tag: tags.content, color: '#657b83' },
])

// Solarized Light editor theme
const solarizedLight = EditorView.theme({
  '&': {
    backgroundColor: '#fdf6e3',
    color: '#657b83',
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    fontSize: '13px',
    height: '100%',
  },
  '.cm-content': { caretColor: '#586e75' },
  '.cm-cursor': { borderLeftColor: '#586e75' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#eee8d5' },
  '.cm-activeLine': { backgroundColor: '#eee8d540' },
  '.cm-gutters': { backgroundColor: '#eee8d5', color: '#93a1a1', borderRight: '1px solid #eee8d5' },
  '.cm-activeLineGutter': { backgroundColor: '#eee8d5' },
  '.cm-line': { lineHeight: '1.6' },
  '.cm-foldGutter': { color: '#93a1a1' },
})

function langExtension(filePath: string) {
  if (filePath.endsWith('.md')) return markdown({ codeLanguages: languages })
  if (filePath.endsWith('.json')) return json()
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return javascript({ typescript: true, jsx: filePath.endsWith('.tsx') })
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return javascript({ jsx: filePath.endsWith('.jsx') })
  if (filePath.endsWith('.py')) return python()
  return markdown({ codeLanguages: languages })
}

interface EditorProps {
  content: string
  filePath: string
  onSave?: (content: string) => void
  onDirty?: (dirty: boolean) => void
  onFocus?: () => void
  onCloseRequest?: () => void
  readOnly?: boolean
}

function isCloseShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'w' && event.metaKey && !event.ctrlKey && !event.altKey
}

export function Editor({ content, filePath, onSave, onDirty, onFocus, onCloseRequest, readOnly = false }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  const initialRef = useRef(content)
  const onSaveRef = useRef(onSave)
  const onDirtyRef = useRef(onDirty)
  const onFocusRef = useRef(onFocus)
  const onCloseRequestRef = useRef(onCloseRequest)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onDirtyRef.current = onDirty
  }, [onDirty])

  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])

  useEffect(() => {
    onCloseRequestRef.current = onCloseRequest
  }, [onCloseRequest])

  useEffect(() => {
    if (!containerRef.current) return

    initialRef.current = content

    const saveKeymap = onSaveRef.current ? [
      { key: 'Mod-s', run: (view: EditorView) => { onSaveRef.current?.(view.state.doc.toString()); return true } },
    ] : []

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        bracketMatching(),
        history(),
        scrollPastEnd(),
        syntaxHighlighting(solarizedHighlight),
        solarizedLight,
        keymap.of([
          ...saveKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        langExtension(filePath),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.domEventHandlers({
          focus: () => {
            onFocusRef.current?.()
            return false
          },
          mousedown: () => {
            onFocusRef.current?.()
            return false
          },
          keydown: (event) => {
            if (!onCloseRequestRef.current || !isCloseShortcut(event)) return false
            event.preventDefault()
            onCloseRequestRef.current()
            return true
          },
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && onDirtyRef.current) {
            onDirtyRef.current(update.state.doc.toString() !== initialRef.current)
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    contentRef.current = content

    return () => { view.destroy(); viewRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view || content === contentRef.current) return
    contentRef.current = content
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    })
  }, [content])

  return <div ref={containerRef} className="h-full overflow-hidden" />
}
