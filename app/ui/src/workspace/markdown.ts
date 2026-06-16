import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { languages } from '@codemirror/language-data'
import { LanguageDescription } from '@codemirror/language'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { marked, type Tokens } from 'marked'

// Lazy-load mermaid: top-level import would pull ~500KB into the main bundle.
// First call dynamic-imports the module and runs initialize(); subsequent calls
// reuse the cached promise.
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
export function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(m => {
      m.default.initialize({ startOnLoad: false, theme: 'neutral' })
      return m.default
    })
  }
  return mermaidReady
}

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

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
}

type FrontmatterValue = string | FrontmatterValue[] | { [key: string]: FrontmatterValue }

interface YamlLine {
  indent: number
  text: string
}

// Leading YAML frontmatter, GitHub-style: a `---` fence on line 1, closed by a
// `---` or `...` line. Returns the matched block and how many source lines it
// spans (1-based, inclusive of both fences) so scroll-sync line numbers stay
// aligned with the body that follows.
export function extractFrontmatter(content: string): { raw: string; yaml: string; endLine: number } | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content)
  if (!match) return null
  const raw = match[0]
  const endLine = countNewlines(raw.replace(/\r?\n$/, '')) + 1
  return { raw, yaml: match[1], endLine }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseScalar(value: string): FrontmatterValue {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    return inner ? inner.split(',').map(stripQuotes) : []
  }
  return stripQuotes(trimmed)
}

function keyColonIndex(text: string): number {
  if (text.endsWith(':')) return text.length - 1
  return text.indexOf(': ')
}

function tokenizeYaml(yaml: string): YamlLine[] {
  const lines: YamlLine[] = []
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }
  return lines
}

// Minimal indentation-based YAML parser covering the shapes that appear in
// frontmatter: scalar maps, one-or-more levels of nested maps, block lists, and
// inline `[a, b]` flow lists. Anything it can't model degrades to a plain string.
function parseYaml(lines: YamlLine[], cursor: { i: number }, indent: number): FrontmatterValue {
  const map: Record<string, FrontmatterValue> = {}
  const list: FrontmatterValue[] = []
  let isList = false

  while (cursor.i < lines.length) {
    const line = lines[cursor.i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      cursor.i += 1
      continue
    }

    if (line.text.startsWith('- ')) {
      isList = true
      list.push(parseScalar(line.text.slice(2)))
      cursor.i += 1
      continue
    }

    const colon = keyColonIndex(line.text)
    if (colon === -1) {
      cursor.i += 1
      continue
    }
    const key = stripQuotes(line.text.slice(0, colon))
    const valueText = line.text.slice(colon + 1).trim()
    cursor.i += 1
    if (valueText !== '') {
      map[key] = parseScalar(valueText)
    } else if (cursor.i < lines.length && lines[cursor.i].indent > indent) {
      map[key] = parseYaml(lines, cursor, lines[cursor.i].indent)
    } else {
      map[key] = ''
    }
  }

  return isList ? list : map
}

function renderFrontmatterValue(value: FrontmatterValue): string {
  if (typeof value === 'string') return escapeHtml(value)
  if (Array.isArray(value)) {
    if (value.every(item => typeof item === 'string')) {
      return (value as string[]).map(escapeHtml).join(', ')
    }
    const rows = value.map(item => `<tr><td>${renderFrontmatterValue(item)}</td></tr>`).join('')
    return `<table><tbody>${rows}</tbody></table>`
  }
  return renderFrontmatterTable(value)
}

function renderFrontmatterTable(map: Record<string, FrontmatterValue>): string {
  const rows = Object.entries(map)
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${renderFrontmatterValue(value)}</td></tr>`)
    .join('')
  return `<table><tbody>${rows}</tbody></table>`
}

function renderFrontmatter(yaml: string): string {
  const lines = tokenizeYaml(yaml)
  if (lines.length === 0) return ''
  const parsed = parseYaml(lines, { i: 0 }, lines[0].indent)
  const table = Array.isArray(parsed)
    ? renderFrontmatterValue(parsed)
    : renderFrontmatterTable(parsed as Record<string, FrontmatterValue>)
  return `<div class="markdown-frontmatter">${table}</div>`
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

  renderer.table = (token: Tokens.Table) => {
    const original = marked.Renderer.prototype.table.call(renderer, token)
    return `<div class="table-scroll">${original}</div>`
  }

  // `/discuss` convention: a blockquote whose leading marker is **Q{n}** (the
  // user's question) or **A{n}** (a nested reply). A <mark> on that marker flags
  // the newest round — tag the whole box `discuss-new` so the preview can tint
  // the entire region, not just the marker. Plain quotes match nothing.
  renderer.blockquote = (token: Tokens.Blockquote) => {
    const html = marked.Renderer.prototype.blockquote.call(renderer, token)
    const marker = /^<blockquote>\s*<p>(<mark>)?<strong>(Q|A)\d/.exec(html)
    if (!marker) return html
    const base = marker[2] === 'Q' ? 'discuss-q' : 'discuss-a'
    const cls = marker[1] ? `${base} discuss-new` : base
    return html.replace('<blockquote>', `<blockquote class="${cls}">`)
  }

  renderer.heading = ({ text, depth }: Tokens.Heading) => {
    const id = slugify(text)
    return `<h${depth} id="${escapeHtml(id)}">${text}</h${depth}>\n`
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

export function resolveRelativePath(currentFile: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0]
  if (clean.startsWith('/')) return clean.slice(1)
  const dir = currentFile.includes('/') ? currentFile.replace(/\/[^/]*$/, '') : ''
  const segments = (dir ? dir + '/' + clean : clean).split('/')
  const resolved: string[] = []
  for (const s of segments) {
    if (s === '.' || s === '') continue
    if (s === '..') resolved.pop()
    else resolved.push(s)
  }
  return resolved.join('/')
}

export function renderMarkdown(content: string): string {
  const renderer = createMarkdownRenderer()
  let html = ''
  let body = content
  let currentLine = 1

  const frontmatter = extractFrontmatter(content)
  if (frontmatter) {
    const fmHtml = renderFrontmatter(frontmatter.yaml)
    if (fmHtml) {
      html += `<div class="markdown-block" data-source-line-start="1" data-source-line-end="${frontmatter.endLine}">${fmHtml}</div>`
    }
    body = content.slice(frontmatter.raw.length)
    currentLine = frontmatter.endLine + 1
  }

  const tokens = marked.lexer(body)
  let cursor = 0

  for (const token of tokens) {
    const raw = token.raw ?? ''
    const start = raw ? body.indexOf(raw, cursor) : cursor
    const resolvedStart = start >= 0 ? start : cursor
    currentLine += countNewlines(body.slice(cursor, resolvedStart))

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
