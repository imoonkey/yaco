# Init Subcommand

> Last updated: 2026-06-04 (yc-cleanup-legacy)

The `init` area initializes a YACO project. Today the only subcommand is
`links` — a pure-TypeScript port of the legacy `init-symlinks.sh` helper
(deleted in yc-cleanup-legacy) that creates four multi-tool compatibility
symlinks in the project root.

The pure helper lives in `cli/src/commands/init.ts#runInitLinks`; the
CLI handler (`handleInit`) wraps it with argv parsing and the standard
`Result` envelope.

## CLI surface

```
yaco init links [--cwd <path>] [--json]
```

- **`--cwd <path>`** — operate in `<path>` instead of the current
  directory. Default: `process.cwd()`.
- **`--json`** — switch to the `{ok,data}/{ok,error}` envelope.

## Symlink plan

| Path | Target | Why |
|------|--------|-----|
| `.agents/` | `.claude/` | Codex project-skills path |
| `.codex/` | `.claude/` | Codex alt path |
| `AGENTS.md` | `CLAUDE.md` | Codex |
| `GEMINI.md` | `CLAUDE.md` | Gemini |

The targets are recorded as repo-relative paths so the resulting
symlinks remain valid if the project root is renamed or moved.
`.claude/` is auto-created if missing so the `.agents` / `.codex`
symlinks always resolve immediately after `init links` returns.

## Preconditions & no-clobber rules

| Condition | Outcome |
|-----------|---------|
| `CLAUDE.md` is missing (no regular file and no symlink) | **ENV** (exit 3) — `no CLAUDE.md found in <root> — create it before running 'yaco init links'`. Hardens the shell baseline's silent warn-and-skip. |
| `CLAUDE.md` is a symlink (even broken) | OK — accepted as satisfying the precondition (same as shell). |
| Target path (`.agents`, `.codex`, `AGENTS.md`, `GEMINI.md`) is a regular file or directory | **IO** (exit 1) — `will not overwrite non-symlink at <path>`. Hardens the shell baseline's silent skip. |
| Target path is an existing symlink (broken or live) | Removed and re-created idempotently — re-running `init links` always converges to the four canonical targets. |

## Differences vs the shell baseline

| Behavior | Shell | TS port |
|----------|-------|---------|
| Missing `CLAUDE.md` | warn + skip the `AGENTS.md` / `GEMINI.md` half | **ENV exit 3** — hard precondition failure |
| Non-symlink at target path | skip + log "exists" | **IO exit 1** — refuse to clobber |
| Existing symlink at target path | skip + log "exists" | **replace** — idempotent across re-runs |
| Output | shell echos to stdout | `--json` envelope with `{cwd, links: [{path, target, action}]}` |

## Tests

- `cli/test/unit/commands/init.test.ts` — pure `runInitLinks` cases
  (creates all four, idempotent on re-run, ENV when CLAUDE.md missing,
  symlink CLAUDE.md satisfies precondition, IO on regular-file or
  directory clobber) plus subprocess coverage for the dispatcher
  (`--cwd`, `--json` success + failure shapes, USAGE on unknown
  subcommand/flag).
