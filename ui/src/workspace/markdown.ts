import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { languages } from '@codemirror/language-data'
import { LanguageDescription } from '@codemirror/language'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { marked, type Tokens } from 'marked'
import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, theme: 'neutral' })

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parserForCodeFence(lang: string | undefined) {
  const normalized = (lang || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'ts' || normalized === 'typescript') return javascript({ typescript: true }).language.parser
  if (normalized === 'tsx') return javascript({ typescript: true, jsx: true }).language.parser
  if (normalized === 'js' || normalized === 'javascript') return javascript().language.parser
  if (normalized === 'jsx') return javascript({ jsx: true }).language.parser
  if (normalized === 'json' || normalized === 'jsonc') return json().language.parser
  if (normalized === 'py' || normalized === 'python') return python().language.parser
  if (normalized === 'md' || normalized === 'markdown') return markdown({ codeLanguages: languages }).language.parser

  const match = LanguageDescription.matchLanguageName(languages, normalized, true)
  return match?.support ? match.support.language.parser : null
}

function renderHighlightedCode(text: string, lang: string | undefined): string {
  const parser = parserForCodeFence(lang)
  if (!parser) return escapeHtml(text)

  const tree = parser.parse(text)
  let html = ''
  highlightCode(
    text,
    tree,
    classHighlighter,
    (code, classes) => {
      const escaped = escapeHtml(code)
      html += classes ? `<span class="${classes}">${escaped}</span>` : escaped
    },
    () => {
      html += '\n'
    },
  )
  return html
}

function createMarkdownRenderer() {
  const renderer = new marked.Renderer()

  renderer.code = ({ text, lang }: Tokens.Code) => {
    if (lang?.toLowerCase() === 'mermaid') {
      return `<div class="mermaid">${escapeHtml(text)}</div>`
    }
    const languageClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return `<pre><code${languageClass}>${renderHighlightedCode(text, lang)}</code></pre>`
  }

  return renderer
}

export function countNewlines(value: string): number {
  let count = 0
  for (const char of value) {
    if (char === '\n') count += 1
  }
  return count
}

export function clampLine(line: number): number {
  if (!Number.isFinite(line)) return 1
  return Math.max(1, Math.round(line))
}

export function renderMarkdown(content: string): string {
  const renderer = createMarkdownRenderer()
  const tokens = marked.lexer(content)
  let html = ''
  let cursor = 0
  let currentLine = 1

  for (const token of tokens) {
    const raw = token.raw ?? ''
    const start = raw ? content.indexOf(raw, cursor) : cursor
    const resolvedStart = start >= 0 ? start : cursor
    currentLine += countNewlines(content.slice(cursor, resolvedStart))

    if (token.type === 'space') {
      currentLine += countNewlines(raw)
      cursor = resolvedStart + raw.length
      continue
    }

    const lineStart = currentLine
    const trimmedRaw = raw.replace(/\n+$/, '')
    const lineEnd = trimmedRaw ? lineStart + countNewlines(trimmedRaw) : lineStart
    const blockHtml = marked.parse(raw, { async: false, renderer, breaks: true }) as string

    if (blockHtml.trim()) {
      html += `<div class="markdown-block" data-source-line-start="${lineStart}" data-source-line-end="${lineEnd}">${blockHtml}</div>`
    }

    currentLine += countNewlines(raw)
    cursor = resolvedStart + raw.length
  }

  return html
}
