import { highlightTree } from '@lezer/highlight'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { editorHighlight } from './editorTheme'
import type { DiffSegment } from './parseDiff'

/**
 * Per-line syntax highlighting for the diff viewer.
 *
 * Reuses the editor's Lezer parsers and `editorHighlight` HighlightStyle so the
 * diff matches the editor's colors. A diff only carries hunk fragments (not the
 * whole file), so each line is tokenized on its own — the same tradeoff GitHub
 * makes. Multi-line constructs (block comments, multi-line strings) may be
 * mis-highlighted, but single-line tokens (keywords, strings, numbers) are correct.
 */

/** One syntax token: text plus the CSS class(es) `editorHighlight` assigns it. */
export type SyntaxSpan = { text: string; cls: string }

/** A render-ready span: syntax class plus whether it sits in a changed word. */
export type HlSpan = { text: string; cls: string; changed: boolean }

/** Tokenize a single line into syntax spans covering the whole text in order. */
export type LineTokenizer = (text: string) => SyntaxSpan[]

// `editorHighlight` generates obfuscated CSS classes (e.g. `.ͼ1`) and ships their
// rules in a StyleModule. Inside CodeMirror `syntaxHighlighting()` mounts it; the
// diff viewer can open without an editor, so mount the rules ourselves once.
let stylesInjected = false
function ensureStyles() {
  if (stylesInjected) return
  const rules = editorHighlight.module?.getRules()
  if (!rules) return // module not ready yet — retry on the next tokenizer load
  const el = document.createElement('style')
  el.dataset.diffHighlight = ''
  el.textContent = rules
  document.head.appendChild(el)
  stylesInjected = true
}

// One tokenizer per language, keyed by LanguageDescription name. Resolving and
// loading a parser is async and shared across every line of a file.
const tokenizerCache = new Map<string, Promise<LineTokenizer | null>>()

function buildTokenizer(filePath: string): Promise<LineTokenizer | null> {
  const desc = LanguageDescription.matchFilename(languages, filePath)
  if (!desc) return Promise.resolve(null)

  const cached = tokenizerCache.get(desc.name)
  if (cached) return cached

  const promise = desc.load().then(support => {
    ensureStyles()
    const parser = support.language.parser
    const tokenize: LineTokenizer = text => {
      const tree = parser.parse(text)
      const spans: SyntaxSpan[] = []
      let pos = 0
      highlightTree(tree, editorHighlight, (from, to, cls) => {
        if (from > pos) spans.push({ text: text.slice(pos, from), cls: '' })
        spans.push({ text: text.slice(from, to), cls })
        pos = to
      })
      if (pos < text.length) spans.push({ text: text.slice(pos), cls: '' })
      return spans
    }
    return tokenize
  }).catch(() => null)

  tokenizerCache.set(desc.name, promise)
  return promise
}

/**
 * Resolve a line tokenizer for `filePath`, or null when no language matches.
 * Safe to call on every diff render; loading is cached per language.
 */
export function loadDiffHighlighter(filePath: string): Promise<LineTokenizer | null> {
  return buildTokenizer(filePath)
}

/**
 * Merge syntax spans with word-diff segments over the same line text.
 *
 * Syntax controls foreground (`cls`); the word diff controls a changed-word
 * background (`changed`). Both segmentations cover the identical string, so we
 * walk them together and cut a new span at every boundary of either side.
 */
export function mergeSyntaxAndWord(syntax: SyntaxSpan[], segments: DiffSegment[]): HlSpan[] {
  const out: HlSpan[] = []
  let si = 0
  let gi = 0
  let sOff = 0
  let gOff = 0

  while (si < syntax.length && gi < segments.length) {
    const sText = syntax[si].text
    const gText = segments[gi].text
    const take = Math.min(sText.length - sOff, gText.length - gOff)

    if (take > 0) {
      out.push({
        text: sText.slice(sOff, sOff + take),
        cls: syntax[si].cls,
        changed: segments[gi].kind !== 'same',
      })
      sOff += take
      gOff += take
    }

    if (sOff >= sText.length) { si++; sOff = 0 }
    if (gOff >= gText.length) { gi++; gOff = 0 }
  }

  // Drain any remainder if the two segmentations disagree on total length (a
  // parser quirk could, in theory) so text degrades visibly rather than vanishing.
  for (; si < syntax.length; si++, sOff = 0) {
    const text = syntax[si].text.slice(sOff)
    if (text) out.push({ text, cls: syntax[si].cls, changed: false })
  }
  for (; gi < segments.length; gi++, gOff = 0) {
    const text = segments[gi].text.slice(gOff)
    if (text) out.push({ text, cls: '', changed: segments[gi].kind !== 'same' })
  }

  return out
}
