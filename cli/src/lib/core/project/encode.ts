/** Path-key encoders for vendor session storage roots.
 *
 *  Claude Code stores per-cwd state under `~/.claude/projects/<encoded-cwd>/`.
 *  The encoding is lossy: each `/`, `.`, and other non-alphanumeric character
 *  in the cwd is collapsed to a single `-`. Existing hyphens are preserved.
 *  Example: `/home/user/ld-workspace/yaco/.worktrees/foo`
 *        -> `-home-user-ld-workspace-yaco--worktrees-foo`.
 *
 *  Codex (~/.codex/sessions/) is NOT cwd-keyed at the directory level — it
 *  shards by date — so no path encoder is exported for Codex. Codex per-cwd
 *  state lives inside session-meta JSON payloads and in `~/.codex/config.toml`
 *  `[projects."<path>"]` sections; both are rewritten by content-aware
 *  rekey paths rather than directory rename.
 */

/** Encode an absolute cwd into Claude's `~/.claude/projects/` subdirectory
 *  name. Mirrors the in-tree encoding used by Claude Code itself. */
export function encodeClaudeCwd(absPath: string): string {
  // Replace any character that is not a-zA-Z0-9 or `-` with `-`. Adjacent
  // replacements collapse naturally because `.replace` with a global regex
  // operates per-character (no merging needed — `/.` becomes `--`).
  return absPath.replace(/[^a-zA-Z0-9-]/g, "-");
}
