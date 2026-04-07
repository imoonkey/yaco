import { useRef, useEffect } from 'react'
import { isCloseShortcut } from '../lib/shortcuts'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, scrollPastEnd } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { syntaxHighlighting, bracketMatching, indentOnInput, foldGutter, foldKeymap, LanguageDescription } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { solarizedHighlight, solarizedLight } from '../lib/solarizedLight'
import { diffGutterExtension, setDiffData } from '../lib/diffGutter'
import type { DiffHunk } from '../lib/parseDiff'
import { inlineAutocomplete, autocompleteCompartment } from '../lib/editor/inlineAutocomplete.js'
import type { CompletionProvider } from '../lib/editor/inlineAutocomplete.js'

const autocompleteProvider: CompletionProvider = async (prefix, suffix, fp, signal) => {
  const res = await fetch('/api/autocomplete/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, suffix, filePath: fp }),
    signal,
  })
  if (!res.ok) return ''
  const { prediction } = await res.json()
  return prediction || ''
}

function langExtension(filePath: string) {
  if (filePath.endsWith('.md')) return markdown({ codeLanguages: languages })
  if (filePath.endsWith('.json')) return json()
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return javascript({ typescript: true, jsx: filePath.endsWith('.tsx') })
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return javascript({ jsx: filePath.endsWith('.jsx') })
  if (filePath.endsWith('.py')) return python()
  return null
}

function loadDynamicLang(filePath: string, compartment: Compartment, view: EditorView) {
  const desc = LanguageDescription.matchFilename(languages, filePath)
  if (desc) {
    desc.load().then(lang => {
      view.dispatch({ effects: compartment.reconfigure(lang) })
    })
  }
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
  jumpScroll?: boolean
  onFocus?: () => void
  onCloseRequest?: () => void
  readOnly?: boolean
  diffHunks?: DiffHunk[]
  insertText?: string | null
  insertRequestKey?: number
  autocompleteEnabled?: boolean
}

function readViewportLine(view: EditorView): number {
  const scrollTop = view.scrollDOM.scrollTop
  const block = view.lineBlockAtHeight(scrollTop)
  const lineNumber = view.state.doc.lineAt(block.from).number
  const blockHeight = block.bottom - block.top
  const fraction = blockHeight > 0 ? (scrollTop - block.top) / blockHeight : 0
  return lineNumber + fraction
}

function applyViewportLine(view: EditorView, target: number): boolean {
  const intLine = Math.max(1, Math.min(Math.floor(target), view.state.doc.lines))
  const fraction = target - Math.floor(target)
  const line = view.state.doc.line(intLine)
  const block = view.lineBlockAt(line.from)
  const targetTop = block.top + fraction * (block.bottom - block.top)
  if (Math.abs(view.scrollDOM.scrollTop - targetTop) < 1) return false
  view.scrollDOM.scrollTop = targetTop
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
  jumpScroll = true,
  onFocus,
  onCloseRequest,
  readOnly = false,
  diffHunks,
  insertText = null,
  insertRequestKey,
  autocompleteEnabled = true,
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
  const lastSelfReportedLineRef = useRef(viewportLine)
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

    const langCompartment = new Compartment()
    const staticLang = langExtension(filePath)

    const state = EditorState.create({
      doc: content,
      extensions: [
        ...diffGutterExtension(),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        foldGutter(),
        history(),
        scrollPastEnd(),
        syntaxHighlighting(solarizedHighlight),
        solarizedLight,
        keymap.of([
          ...saveKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...closeBracketsKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
        ]),
        langCompartment.of(staticLang ?? []),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        readOnly || !autocompleteEnabled ? [] : autocompleteCompartment.of(inlineAutocomplete(autocompleteProvider, filePath)),
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
    if (!staticLang) loadDynamicLang(filePath, langCompartment, view)
    applyViewportLine(view, viewportLine)

    const handleScroll = () => {
      if (applyingViewportRef.current) {
        applyingViewportRef.current = false
        return
      }
      const line = readViewportLine(view)
      lastSelfReportedLineRef.current = line
      onViewportLineRef.current?.(line)
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

    // Compute minimal change (common prefix/suffix) to preserve cursor position
    const oldText = view.state.doc.toString()
    let prefix = 0
    const minLen = Math.min(oldText.length, content.length)
    while (prefix < minLen && oldText[prefix] === content[prefix]) prefix++
    let oldSuffix = oldText.length
    let newSuffix = content.length
    while (oldSuffix > prefix && newSuffix > prefix && oldText[oldSuffix - 1] === content[newSuffix - 1]) {
      oldSuffix--
      newSuffix--
    }

    if (prefix === oldText.length && prefix === content.length) return // identical
    suppressChangeRef.current = true
    view.dispatch({
      changes: { from: prefix, to: oldSuffix, insert: content.slice(prefix, newSuffix) },
    })
    suppressChangeRef.current = false
  }, [content])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // Skip if this viewport line is just our own scroll report echoing back
    if (viewportLine === lastSelfReportedLineRef.current) return
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
      ...(jumpScroll !== false ? { effects: EditorView.scrollIntoView(line.from, { y: 'center' }) } : {}),
    })
    view.focus()
    onViewportLineRef.current?.(readViewportLine(view))
  }, [jumpRequestKey, jumpToLine, jumpScroll])

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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const ext = readOnly || !autocompleteEnabled ? [] : inlineAutocomplete(autocompleteProvider, filePath)
    view.dispatch({ effects: autocompleteCompartment.reconfigure(ext) })
  }, [autocompleteEnabled, readOnly, filePath])

  return <div ref={containerRef} className="h-full overflow-hidden" />
}
