import { useRef, useEffect } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'

// Solarized Light theme for CodeMirror
const solarizedLight = EditorView.theme({
  '&': {
    backgroundColor: '#fdf6e3',
    color: '#657b83',
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
    fontSize: '13px',
  },
  '.cm-content': { caretColor: '#586e75' },
  '.cm-cursor': { borderLeftColor: '#586e75' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#eee8d5' },
  '.cm-activeLine': { backgroundColor: '#eee8d5' + '40' },
  '.cm-gutters': { backgroundColor: '#eee8d5', color: '#93a1a1', borderRight: '1px solid #eee8d5' },
  '.cm-activeLineGutter': { backgroundColor: '#eee8d5' },
  '.cm-line': { lineHeight: '1.6' },
})

interface EditorProps {
  content: string
  filePath: string
  onSave?: (content: string) => void
  readOnly?: boolean
}

export function Editor({ content, filePath, onSave, readOnly = false }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return

    const saveKeymap = onSave ? [
      { key: 'Mod-s', run: (view: EditorView) => { onSave(view.state.doc.toString()); return true } },
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
        syntaxHighlighting(defaultHighlightStyle),
        solarizedLight,
        keymap.of([
          ...saveKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        markdown({ codeLanguages: languages }),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    contentRef.current = content

    return () => { view.destroy(); viewRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly])

  // Update content when it changes externally (different file selected)
  useEffect(() => {
    const view = viewRef.current
    if (!view || content === contentRef.current) return
    contentRef.current = content
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    })
  }, [content])

  return <div ref={containerRef} className="h-full overflow-auto" />
}
