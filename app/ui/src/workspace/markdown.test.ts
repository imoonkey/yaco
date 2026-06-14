import { describe, it, expect } from 'vitest'
import { extractFrontmatter, renderMarkdown } from './markdown'

describe('extractFrontmatter', () => {
  it('matches a leading --- fence and reports its line span', () => {
    const fm = extractFrontmatter('---\nname: align\n---\n\n# Body\n')
    expect(fm).not.toBeNull()
    expect(fm!.yaml).toBe('name: align')
    expect(fm!.endLine).toBe(3)
  })

  it('accepts a ... closing fence', () => {
    expect(extractFrontmatter('---\nname: x\n...\n')).not.toBeNull()
  })

  it('ignores fences that do not start at line 1', () => {
    expect(extractFrontmatter('# Title\n\n---\nname: x\n---\n')).toBeNull()
  })

  it('ignores a lone --- with no closing fence', () => {
    expect(extractFrontmatter('---\nnot frontmatter\n')).toBeNull()
  })
})

describe('renderMarkdown frontmatter', () => {
  const content = [
    '---',
    'name: align',
    'description: Align the design between Codex and Claude.',
    'metadata:',
    '  yaco-dependent: "true"',
    '---',
    '',
    '# Align',
    '',
    'Body text.',
    '',
  ].join('\n')

  it('renders frontmatter as a metadata table, not headings', () => {
    const html = renderMarkdown(content)
    expect(html).toContain('class="markdown-frontmatter"')
    // The closing --- must not become a setext heading over the YAML keys.
    expect(html).not.toContain('name: align</h')
    expect(html).not.toMatch(/<h[12][^>]*>name/)
  })

  it('nests mapped values as a sub-table', () => {
    const html = renderMarkdown(content)
    expect(html).toContain('<td>metadata</td>')
    expect(html).toContain('<td>yaco-dependent</td>')
    expect(html).toContain('<td>true</td>')
  })

  it('strips quotes from scalar values', () => {
    const html = renderMarkdown(content)
    expect(html).not.toContain('"true"')
  })

  it('preserves the real body heading after the frontmatter', () => {
    const html = renderMarkdown(content)
    expect(html).toContain('<h1 id="align">Align</h1>')
  })

  it('keeps body line numbers aligned past the frontmatter for scroll sync', () => {
    const html = renderMarkdown(content)
    // # Align sits on source line 8 (6 frontmatter lines + 1 blank).
    expect(html).toMatch(/data-source-line-start="8"[^>]*>\s*<h1/)
  })

  it('renders inline flow lists as comma-joined values', () => {
    const html = renderMarkdown('---\ntags: [a, b, c]\n---\n\nbody\n')
    expect(html).toContain('<td>tags</td><td>a, b, c</td>')
  })

  it('leaves documents without frontmatter untouched', () => {
    const html = renderMarkdown('# Hello\n\nWorld\n')
    expect(html).not.toContain('markdown-frontmatter')
    expect(html).toContain('<h1 id="hello">Hello</h1>')
  })
})
