# YACO

YACO is a local-first workspace for running coding agents on your own machine: a
browser IDE for your repositories, and a `yaco` CLI that owns agent sessions,
per-project task graphs, and git worktrees.

It is an **orchestration layer, not an agent**. YACO never talks to a model. It
starts, tracks, and attaches to the agent CLI you already have installed —
[Claude Code](https://claude.com/claude-code) (`claude`) or
[Codex](https://developers.openai.com/codex/cli) (`codex`). **Install one of
them before you install YACO.** Without a provider on your `PATH` there is
nothing to orchestrate, and the installer will not report success: it ends by
running `yaco doctor`, whose `providers` check fails, which makes the whole
bootstrap exit non-zero — after it has already changed your machine.

## What you get

- **A browser workspace** on `http://localhost:3001` — file tree, editor,
  diffs, git views, cross-file search, and terminals, for every repository you
  register. Single user, file-based state, no database.
- **Agent sessions that outlive the browser.** Every session is a tmux session
  started through `yaco agent`, so you can close the tab, restart the server,
  and reattach later — from the app or from a plain terminal.
- **A task graph per repository.** `yaco task` maintains it under `plan/tasks/`,
  the app renders it, and agent workers can execute it.
- **Worktree isolation.** `yaco worktree` gives a task its own checkout at
  `.worktrees/<slug>` on branch `task/<slug>`, so parallel work never shares a
  working tree.
- **A skill library.** 30 workflow skills in `agent-config/global/skills/`
  (`/design`, `/implement`, `/code-review`, `/verify`, `/qa`, `/orchestrate`, …),
  linked into `~/.claude/skills` and `~/.agents/skills` at install time so both
  agents can use them.

## Requirements

Linux or macOS.

| Requirement | Why | Check |
|---|---|---|
| **Claude Code** (`claude`) or **Codex** (`codex`) | The agent YACO drives. Bring your own — YACO ships none, and installing without one fails the final doctor check. | `yaco doctor` → `providers` |
| **[Bun](https://bun.sh)** | `tools/install.sh` compiles the `yaco` binary with `bun build --compile`. Without it the installer exits 2. | `bun --version` |
| **Node.js ≥ 22.13 and npm** | The app server and UI. `yaco install` runs `npm install` in `app/server` and `app/ui`. | `node -v` |
| **make, python3, and a C/C++ compiler** | `node-pty`, which backs every terminal, is a native module, and it ships prebuilt binaries for macOS and Windows only — **on Linux it is always compiled from source** at install time. On Debian/Ubuntu: `sudo apt install make python3 build-essential`. On macOS the prebuild covers arm64 and x64; Xcode Command Line Tools are the fallback. | — |
| **tmux** | Agent and shell sessions are tmux sessions. | `tmux -V` |
| **git** | Worktrees and the app's git views. | `git --version` |

## Install

v0.1 installs from source. There is deliberately no npm package: the CLI's real
artifact is a Bun-compiled binary, and the package's `bin` points at a
TypeScript entry that would not run under plain Node.

```bash
git clone https://github.com/imoonkey/yaco.git
cd yaco
tools/install.sh
```

`tools/install.sh` is the only entry point for a first install, and for recovery
from a missing or broken `yaco` binary. It compiles `cli/src/main.ts` into
`${YACO_BIN_DIR:-~/.local/bin}/yaco`, then hands off to `yaco install`, which in
this order:

1. writes the agent wrapper into `${YACO_HOME:-~/.yaco}`,
2. merges YACO's hook entries into `~/.claude` and `~/.codex`,
3. links `agent-config/global/skills` into `~/.claude/skills`,
4. runs `npm install` in `app/server` and `app/ui`,
5. registers this repository in `${YACO_HOME:-~/.yaco}/projects.json`,
6. and finishes by running `yaco doctor`.

None of that is transactional. If a later step fails — an npm install, or the
closing doctor — the earlier steps have already changed your machine, so read
the error and re-run rather than assuming nothing happened.

Make sure `~/.local/bin` is on your `$PATH`. Re-run the same command after a
`git pull` to update; `tools/install.sh --cli-only` refreshes just the CLI and
config, skipping the app's npm installs.

## First run

**1. Validate the install.**

```bash
yaco doctor
```

The installer already ran this once; run it yourself whenever something looks
wrong. It checks the binary, `~/.yaco`, the project registry, the skill link,
the provider hooks and wrapper, tmux, git, the installed providers, and the
current repository's task graph. Two checks are worth knowing: `providers` fails
when neither `claude` nor `codex` is on your `PATH`, and `task-graph` only
passes in a repository that already has one under `plan/tasks/`, which `yaco
task set` creates — so it reports a failure in a repo you have not planned yet.

**2. Start the app**, from the repo root:

```bash
npm run start:app
```

This builds the UI and starts the server, which serves the app, the API, the
WebSocket terminals, and the SSE event streams from a single origin. It runs in
the foreground — leave it running and open <http://localhost:3001>.

**3. Add a repository of your own** (in another terminal). The YACO repo itself
was registered by the installer; anything else you want in the app's sidebar you
register yourself:

```bash
yaco project add myrepo /abs/path/to/myrepo
```

**4. Start an agent session** in that repository:

```bash
cd /abs/path/to/myrepo
yaco claude "give me a tour of this repo"
```

`yaco claude` (or `yaco codex`) starts a session and prints the handle it was
given. Add `--wait` to block until the agent finishes and print its reply
instead; anything after a bare `--` is forwarded verbatim to the provider CLI.

**5. Watch it, from either side.**

```bash
yaco agent list                  # every session and its status
yaco agent capture <handle>      # recent output
yaco agent send <handle> "…"     # reply to it
yaco agent kill <handle>         # end it
```

In the app, that same session is a terminal tab you can type into directly.

## Repository layout

| Path | Contents |
|---|---|
| `app/server/` | Hono backend: file/git/task APIs, WebSocket terminals, SSE watchers |
| `app/ui/` | React + Vite frontend |
| `cli/` | `@yaco/cli` — the `yaco` dispatcher: `agent`, `task`, `worktree`, `plan`, `project`, `install`, `doctor`, `paths`, `gate`, `align`, `init` |
| `agent-config/` | The workflow skills installed for Claude Code and Codex |
| `packages/` | Shared libraries used by the app |
| `tools/` | The bootstrap installer |
| `doc/` | Documentation (see below) |
| `plan/` | Task graph and design docs (see below) |

## `plan/` — your task graph and design docs

YACO keeps each project's task graph and design documents in `<repo>/plan/`,
next to the code. **It is your directory.** By default it is committed with the
rest of the repository, and for most projects that is the right answer: design
docs and a visible task history in a public repo are a feature, not a leak.

If yours contains something you would rather not publish, run:

```bash
yaco plan init          # optionally: --remote <url>
```

That promotes `plan/` into a **separate git repository colocated inside the
working tree**: `git init` in place, a default `plan/.gitignore`, and a `/plan/`
entry in the host repo's `.git/info/exclude`, so the host repo stops picking the
files up while your editor, `rg`, and YACO itself still see them exactly where
they were. It is idempotent and must be re-run on every fresh clone and every
machine, because `.git/info/exclude` is not version-controlled.

Two things it deliberately does **not** do:

- **It does not untrack what the host repo already committed.** A git exclude
  only affects untracked paths. If `plan/` is already in the host's index, run
  `git rm -r --cached plan && git commit` yourself afterwards — and note that
  even then the content stays in the host's *history* until you rewrite it.
- **It does not make anything private.** `--remote <url>` records an origin and
  never pushes; creating a private remote, and verifying it is private, is
  yours to do.

**YACO's own `plan/` is private, because it holds a personal corpus of agent
interactions. That is the exception, not the recommendation** — and it means
this repository does not ship YACO's live planning history.

Locations are configurable in `yaco.toml` under `[paths]` (`plan` and
`worktrees` are repo-relative; `tasks`, `active`, `archive`, and `backlog` are
resolved under the plan root). `yaco paths project --json` reports what is in
effect.

## Development

`scripts/verify.sh` is the standard verification entry — CLI unit tests, the
`@yaco/codex-transcribe` typecheck and tests, the server tests, the UI lint, and
the UI build, in a fixed order, stopping at the first failure:

```bash
bash scripts/verify.sh
```

It deliberately stops there: the UI component tests, the browser e2e suite, and
the CLI integration suite are **not** part of it and are run separately (each
from the repo root):

```bash
(cd cli        && bun run test)           # CLI unit tests
(cd app/server && npm test)               # server tests (vitest)
(cd app/ui     && npm run lint)           # eslint
(cd app/ui     && npm run build)          # tsc -b + vite build — this is the typecheck
(cd app/ui     && npm test)               # component tests (vitest)
(cd app/ui     && npx playwright test)    # browser e2e (boots its own isolated server)
(cd cli        && bun run test:integration)
```

Only one of these touches your installed YACO: `bun run test:integration`
reinstalls the CLI binary and its global config before it runs. The rest stay
inside the checkout, though several write local artifacts — `npm run build`
produces `app/ui/dist` (which `npm run start:app` then serves), and the e2e run
boots its own server and writes `dist-e2e/`, `test-results/`, and
`playwright-report/`.

For a development loop against the app, `npm run dev:local` runs the server on
`:3001` and Vite on `:5173` in the foreground. `npm run dev` instead installs
and restarts long-running systemd/launchd services — see
[doc/dev/app/workflow.md](doc/dev/app/workflow.md) before using it.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.

## Documentation

- [doc/main/README.md](doc/main/README.md) — architecture and subsystem docs.
- [doc/dev/README.md](doc/dev/README.md) — development workflows.
- [doc/PROGRESS.md](doc/PROGRESS.md) — change history.

## License

MIT — see [LICENSE](LICENSE).
