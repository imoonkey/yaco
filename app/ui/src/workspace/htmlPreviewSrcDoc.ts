const SRCDOC_BASE_TAG = '<base href="about:srcdoc">'
const BASE_TAG_RE = /<base\b/i
const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i
const HTML_OPEN_RE = /<html(\s[^>]*)?>/i
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i

export function prepareHtmlPreviewSrcDoc(content: string): string {
  if (BASE_TAG_RE.test(content)) return content

  if (HEAD_OPEN_RE.test(content)) {
    return content.replace(HEAD_OPEN_RE, (match) => `${match}\n${SRCDOC_BASE_TAG}`)
  }

  if (HTML_OPEN_RE.test(content)) {
    return content.replace(HTML_OPEN_RE, (match) => `${match}\n<head>${SRCDOC_BASE_TAG}</head>`)
  }

  const doctype = content.match(DOCTYPE_RE)
  if (doctype) {
    const at = doctype[0].length
    return `${content.slice(0, at)}\n<head>${SRCDOC_BASE_TAG}</head>${content.slice(at)}`
  }

  return `<head>${SRCDOC_BASE_TAG}</head>\n${content}`
}
