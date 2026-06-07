const TAG_BLOCKS =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/gi
const STRAY_TAGS = /<\/?(?:system-reminder|command-(?:message|name|args))>/gi

/** Clean a session summary for inline display; returns '' when nothing should render. */
export function sanitizeSummary(summary: string | null | undefined, name: string): string {
  if (!summary) return ''
  const cleaned = summary.replace(TAG_BLOCKS, '').replace(STRAY_TAGS, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (name.startsWith(cleaned)) return ''
  return cleaned
}
