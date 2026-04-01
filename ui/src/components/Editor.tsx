import { useRef, useEffect } from 'react'
import { isCloseShortcut } from '../lib/shortcuts'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, scrollPastEnd } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, bracketMatching } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { solarizedHighlight, solarizedLight } from '../lib/solarizedLight'
import { diffGutterExtension, setDiffData } from '../lib/diffGutter'
import type { DiffHunk } from '../lib/parseDiff'

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
  onChange?: (content: string) => void
  viewportLine?: number
  onViewportLine?: (line: number) => void
  jumpToLine?: number | null
  jumpRequestKey?: number
  onFocus?: () => void
  onCloseRequest?: () => void
  readOnly?: boolean
  diffHunks?: DiffHunk[]
  insertText?: string | null
  insertRequestKey?: number
}

function readViewportLine(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
  return view.state.doc.lineAt(block.from).number
}

function applyViewportLine(view: EditorView, lineNumber: number): boolean {
  const clampedLine = Math.max(1, Math.min(lineNumber, view.state.doc.lines))
  const line = view.state.doc.line(clampedLine)
  const block = view.lineBlockAt(line.from)
  if (Math.abs(view.scrollDOM.scrollTop - block.top) < 1) return false
  view.scrollDOM.scrollTop = block.top
  return true
}

export function Editor({
  content,
  filePath,
  onSave,
  onChange,
  viewportLine = 1,
  onViewportLine,
  jumpToLine = null,
  jumpRequestKey,
  onFocus,
  onCloseRequest,
  readOnly = false,
  diffHunks,
  insertText = null,
  insertRequestKey,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  const onSaveRef = useRef(onSave)
  const onChangeRef = useRef(onChange)
  const onViewportLineRef = useRef(onViewportLine)
  const onFocusRef = useRef(onFocus)
  const onCloseRequestRef = useRef(onCloseRequest)
  const applyingViewportRef = useRef(false)
  const jumpRequestKeyRef = useRef<number | undefined>(undefined)
  const insertRequestKeyRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onViewportLineRef.current = onViewportLine
  }, [onViewportLine])

  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])

  useEffect(() => {
    onCloseRequestRef.current = onCloseRequest
  }, [onCloseRequest])

  useEffect(() => {
    if (!containerRef.current) return

    const saveKeymap = onSaveRef.current ? [
      { key: 'Mod-s', run: (view: EditorView) => { onSaveRef.current?.(view.state.doc.toString()); return true } },
    ] : []

    const state = EditorState.create({
      doc: content,
      extensions: [
        ...diffGutterExtension(),
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
          if (update.docChanged && !suppressChangeRef.current) {
            const nextContent = update.state.doc.toString()
            contentRef.current = nextContent
            onChangeRef.current?.(nextContent)
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    contentRef.current = content
    applyViewportLine(view, viewportLine)

    const handleScroll = () => {
      if (applyingViewportRef.current) {
        applyingViewportRef.current = false
        return
      }
      onViewportLineRef.current?.(readViewportLine(view))
    }

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      view.destroy()
      viewRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly])

  // Suppress onChange during programmatic content updates (server-driven refreshes)
  const suppressChangeRef = useRef(false)

  useEffect(() => {
    const view = viewRef.current
    if (!view || content === contentRef.current) return
    contentRef.current = content
    suppressChangeRef.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    })
    suppressChangeRef.current = false
  }, [content])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    applyingViewportRef.current = applyViewportLine(view, viewportLine)
  }, [viewportLine])

  useEffect(() => {
    const view = viewRef.current
    if (!view || jumpToLine == null || jumpRequestKeyRef.current === jumpRequestKey) return
    jumpRequestKeyRef.current = jumpRequestKey
    const lineNumber = Math.max(1, Math.min(jumpToLine, view.state.doc.lines))
    const line = view.state.doc.line(lineNumber)
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
    view.focus()
    onViewportLineRef.current?.(readViewportLine(view))
  }, [jumpRequestKey, jumpToLine])

  // Insert text at cursor / replace selection as a single undoable edit
  useEffect(() => {
    const view = viewRef.current
    if (!view || insertText == null || insertRequestKeyRef.current === insertRequestKey) return
    insertRequestKeyRef.current = insertRequestKey
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: insertText },
      selection: EditorSelection.cursor(from + insertText.length),
    })
    view.focus()
    const nextContent = view.state.doc.toString()
    contentRef.current = nextContent
    onChangeRef.current?.(nextContent)
  }, [insertRequestKey, insertText])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setDiffData.of(diffHunks ?? []) })
  }, [diffHunks])

  return <div ref={containerRef} className="h-full overflow-hidden" />
}
