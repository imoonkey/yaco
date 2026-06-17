# Command Surface Matrix

> Last updated: 2026-06-17 (`agent history` windowing: strict parser + `--since`/`--limit` + windowed `{rows,…}` object + origin/`tokens` enrichment)

The canonical map of the `yaco` command surface. The CLI is consumed by AI
agents as much as by humans, so the surface is organized into CRUD-shaped
archetypes that line up across areas: every per-item read lands in **get /
inspect one**, every collection read in **list**, every cwd/identity read in
**resolve current**.

Legend: ✅ existing · 🆕 added in the read-surface pass · ✏️ improved in the
read-surface pass (text/contract) · 📜 added in the agent-messages pass.

| area | get / inspect one | list | resolve current | create / start | update / send | delete / teardown |
|---|---|---|---|---|---|---|
| agent | `status` ✏️ · `wait` ✏️ · `capture` ✅ · `output-follow` ✅ · `messages` 📜 | `list` ✅ · `history` ✅ · `summaries` ✅ | `whoami` ✅ | `start` ✅ | `send` ✅ · `rename` ✅ | `kill` ✅ |
| task | `get` 🆕 | `list` ✅ (+`--state` 🆕) | — | `set` ✅ (upsert) | `set` ✅ · `attach` ✅ · `detach` ✅ | `rm` ✅ · `archive` ✅ |
| worktree | — (use `git`) | — (`git worktree list`) | — | `create` ✅ | `merge` ✅ | `cleanup` ✅ |
| project | — | `list` ✅ | `current` 🆕 | `add` ✅ | `move` ✅ | `remove` ✅ |

Outside the grid — the only agent command that isn't CRUD-shaped:

- **agent**: `providers` ✅ — the static provider catalog.
- **agent**: `mark-crashed` — internal, called by the wrapper EXIT trap (not a user command): generation/sentinel-guarded rewrite of a session state file to `crashed` + `exitCode`. See [state-contract.md](state-contract.md#crash-contract-fail-closed-crashed-tombstone).

A worktree is a git object, so YACO adds **no** worktree read command: `git
worktree list` and `git -C .worktrees/<slug> status` are its canonical readers.
The only YACO-specific bit (the slug↔path↔branch convention) is shared as a
core export instead — see [worktree.md](worktree.md#convention-export). There is
no `project get`: a project record is only `{name, path}`, so a keyed lookup
returns nothing `list` doesn't already show; `project current` (cwd→owner) is
the read with real value.

## Output convention — `{text}` is the default result envelope

Text mode (no `--json`) is the readable default for every ordinary
result-bearing command; `--json` is reserved for programmatic consumption and
the `{ok}` success/failure discriminator. Two text-mode envelopes exist, both
written verbatim by `render()` in `main.ts`:

- **`{help}`** — usage text only (`--help`).
- **`{text}`** — the single result-rendering envelope for ordinary commands.

A handler branches exactly once, through the `dual` helper
(`cli/src/lib/core/render.ts`):

```ts
export const dual = (json: boolean, data: unknown, render: () => string): Result<unknown> =>
  ok(json ? data : { text: render() });
```

`render()` is only invoked in text mode, so the JSON path pays no formatting
cost. `--json` returns the structured record; text returns the rendered block.

**Streaming / process-owning commands are explicit exceptions** and never go
through `dual` or the `{text}` rule — they own stdout directly and exit before
the dispatcher renders an envelope: `agent output-follow` (NDJSON stream),
`align wait` (status words + own exit codes), `doctor` (own `renderText` +
`process.exit`).

**Guarded fallback.** After the text sweep, `render()` treats any ordinary
ok-result that reaches text mode without a `{text}`/`{help}` envelope as an
`INTERNAL` error (`renderExitCode` sets the exit code). A result-bearing handler
that forgets to branch through `dual` fails loudly instead of silently dumping a
compact JSON blob — the old behavior the read-surface pass removed.

## Area inventory (today)

Ten top-level areas: `agent` · `task` · `worktree` · `project` · `align` ·
`init` · `install` · `doctor` · `paths` · `plan`. A follow-up `surface-hygiene` design
proposes consolidating these to six (folding `init links` + `agent hooks
install` into `install`, relocating `align` under `agent`, and merging
`doctor` + `paths` into a read-only `env` area) — **not shipped**; tracked
separately so it does not entangle install/init/doctor semantics with the read
surface.

-> See: [README.md](README.md) for the per-area doc map.
