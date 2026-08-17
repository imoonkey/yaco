/** Extract the reply from tmux's rendered screen. tmux has already applied the
 * TUI's cursor movement and erase commands, so callers never need to interpret
 * the raw PTY repaint stream. */
export function extractPaneReply(pane: string, prompt: string, provider: string): string {
  const rendered = pane.trim()
  if (provider !== 'codex') return rendered

  const firstPromptLine = prompt.split('\n', 1)[0].trim()
  if (!firstPromptLine) return rendered

  const lines = pane.replaceAll('\r', '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trimStart()
    if (!line.startsWith(`› ${firstPromptLine}`)) continue

    const nextPrompt = lines.findIndex((candidate, candidateIndex) =>
      candidateIndex > i && candidate.trimStart().startsWith('›'),
    )
    if (nextPrompt >= 0) {
      return lines.slice(i + 1, nextPrompt).join('\n').trim()
    }
  }
  return rendered
}
