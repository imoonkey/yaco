import { useRef, useEffect } from 'react'
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
  scrollProgress?: number
  onScrollProgress?: (progress: number) => void
  jumpToLine?: number | null
  jumpRequestKey?: number
  onFocus?: () => void
  onCloseRequest?: () => void
  readOnly?: boolean
}

function isCloseShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'w' && event.metaKey && !event.ctrlKey && !event.altKey
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.max(0, Math.min(1, progress))
}

function maxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function readScrollProgress(element: HTMLElement): number {
  const max = maxScrollTop(element)
  if (max === 0) return 0
  return clampProgress(element.scrollTop / max)
}

function applyScrollProgress(element: HTMLElement, progress: number): boolean {
  const max = maxScrollTop(element)
  const nextTop = max * clampProgress(progress)
  if (Math.abs(element.scrollTop - nextTop) < 1) return false
  element.scrollTop = nextTop
  return true
}

export function Editor({
  content,
  filePath,
  onSave,
  onChange,
  scrollProgress = 0,
  onScrollProgress,
  jumpToLine = null,
  jumpRequestKey,
  onFocus,
  onCloseRequest,
  readOnly = false,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  const onSaveRef = useRef(onSave)
  const onChangeRef = useRef(onChange)
  const onScrollProgressRef = useRef(onScrollProgress)
  const onFocusRef = useRef(onFocus)
  const onCloseRequestRef = useRef(onCloseRequest)
  const applyingScrollRef = useRef(false)
  const jumpRequestKeyRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onScrollProgressRef.current = onScrollProgress
  }, [onScrollProgress])

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
          if (update.docChanged) {
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
    applyScrollProgress(view.scrollDOM, scrollProgress)

    const handleScroll = () => {
      if (applyingScrollRef.current) {
        applyingScrollRef.current = false
        return
      }
      onScrollProgressRef.current?.(readScrollProgress(view.scrollDOM))
    }

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      view.destroy()
      viewRef.current = null
    }
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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    applyingScrollRef.current = applyScrollProgress(view.scrollDOM, scrollProgress)
  }, [scrollProgress])

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
    onScrollProgressRef.current?.(readScrollProgress(view.scrollDOM))
  }, [jumpRequestKey, jumpToLine])

  return <div ref={containerRef} className="h-full overflow-hidden" />
}
