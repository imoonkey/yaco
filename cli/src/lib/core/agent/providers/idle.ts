/** Provider-agnostic idle/busy detection over rendered tmux pane text.
 *
 *  Idle patterns are aggregated from every registered provider; busy patterns
 *  are structural (no verb lists, no spinner glyphs) and shared across
 *  providers. */

import { listProviders } from "./index.ts";

/** Every idle prompt pattern across all providers, deduped by source. */
export const ALL_IDLE_PATTERNS: readonly RegExp[] = (() => {
  const seen = new Set<string>();
  return listProviders()
    .flatMap((p) => p.detection.idlePatterns)
    .filter((pat) => {
      if (seen.has(pat.source)) return false;
      seen.add(pat.source);
      return true;
    });
})();

/** Patterns that indicate the agent is actively processing. Purely structural:
 *  no word lists (verbs rotate) and no specific spinner chars (they vary across
 *  versions/models). */
export const BUSY_PATTERNS: readonly RegExp[] = [
  /esc to interrupt/i,
  /\(\d+[smh][^)]*·/, // Timer with "·" separator: "(5s ·", "(57m 19s · ↓ ..."
];

function relevantOutputWindow(output: string, tail: number = 40): string {
  const lines = output.split("\n");
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) {
    lines.pop();
  }
  return lines.slice(-tail).join("\n");
}

/** True when the rendered pane shows an idle prompt and no live busy indicator. */
export function isIdle(output: string): boolean {
  const lastLines = relevantOutputWindow(output);
  if (!lastLines) return false;
  // Busy indicators only count if they appear in the live UI area (last ~12
  // lines). The MCP-boot "(0s · esc to interrupt)" line scrolls up into
  // history once the prompt comes back; it stays detectable in the broader
  // 40-line window for many seconds, which would otherwise mask idle.
  const liveTail = relevantOutputWindow(output, 12);
  if (BUSY_PATTERNS.some((pat) => pat.test(liveTail))) return false;
  return ALL_IDLE_PATTERNS.some((pat) => pat.test(lastLines));
}
