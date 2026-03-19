import { useRef, useEffect } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, scrollPastEnd } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, bracketMatching } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { solarizedHighlight, solarizedLight } from '../lib/solarizedLight'

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
