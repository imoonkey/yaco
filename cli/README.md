# yaco-cli

The `yaco` command — an orchestration layer for terminal coding agents.

YACO never talks to a model. It starts, tracks, and attaches to the agent CLIs
you already have — [Claude Code](https://claude.com/claude-code) (`claude`) and
[Codex](https://developers.openai.com/codex/cli) (`codex`) today — running each
one in its own tmux session so it outlives your terminal. Around that primitive
sits the rest of the working surface: a per-repo task graph, one git worktree
per task, plans, and an exit gate computed from your diff. The package also
ships the 22 workflow skills those commands exist to drive.

Part of [YACO](https://github.com/imoonkey/yaco). MIT licensed.

## Prerequisites

Linux or macOS, with:

- **`claude` or `codex` on your `PATH`** — one is enough. YACO ships no agent,
  and `yaco agent start` refuses a provider whose executable it cannot find.
- **Node.js ≥ 24.15**, npm, **tmux**, **git**.
- Linux only: `make`, `python3`, and a C/C++ compiler
  (`sudo apt install make python3 build-essential`) — `node-pty` compiles from
  source.

## Install

```bash
npm install -g yaco-cli
yaco install
```

`npm install -g` only lands the files. `yaco install` configures the machine,
out of the installed package — no checkout involved:

- symlinks each shipped skill into `~/.claude/skills/<name>`, and points
  `~/.agents/skills` at that directory;
- merges YACO's hook entries into `~/.claude/settings.json` and
  `~/.codex/hooks.json`, preserving every unrelated entry;
- writes the session wrapper at `~/.yaco/agent-wrapper.sh`;
- runs `yaco doctor` and fails the install if any check fails.

It is idempotent, and `--dry-run` prints the plan without touching anything.
**Re-run it after upgrading the package or editing a skill** — the links and
hooks are what a new version has to re-plant.

## First session

```bash
cd <any-repo>
yaco claude "give me a tour of this repo"
```

That is a tmux-backed session: close the terminal, come back later, reattach.

```bash
yaco agent list                       # sessions under this directory (--all for everywhere)
yaco agent capture <handle>           # recent output
yaco agent send <handle> "…" [--wait] # reply — --wait blocks for the response
yaco agent kill <handle>              # end it
```

Your agents run these same commands to spawn and coordinate sub-agents, so
every session an agent creates is one you can list, capture, and attach to.
No hidden recursion, no privileged internal API.

## Command surface

`yaco <area> <command>`. Every area takes `--help`; `--json` switches any
command to a single-line `{ok,data}` / `{ok,error}` envelope.

| Area | What it does |
|---|---|
| `agent` | Start, send to, capture, wait on, rename, and kill tmux-backed agent sessions; read history, messages, and usage. |
| `task` | Read and mutate the per-repo task graph: `set`, `get`, `list`, `rm`, `archive`, `validate`, `attach`/`detach` a session. |
| `worktree` | `create`, `merge`, and `cleanup` a `.worktrees/<slug>` checkout per task slug. |
| `plan` | `plan init` promotes the repo's plan directory into a private, colocated git repo the host repo ignores. |
| `project` | Register repos with YACO: `list`, `current`, `add`, `remove`, `move`. |
| `align` | `init` / `wait` / `handoff` / `status` — the turn-taking protocol behind the multi-agent design workflows. |
| `init` | `init links` creates the multi-tool compatibility symlinks (`.agents/`, `.codex/`, `AGENTS.md`, `GEMINI.md`) in a project root. |
| `install` | Install or refresh YACO on this machine (above). |
| `doctor` | Health checks over `~/.yaco` and the current repo — binary, hooks, wrapper, skills links, tmux, git, providers, task graph. |
| `gate` | Run the repo's exit gate against your diff: which of verify / doc / review / qa the change owes, and whether the tree is dirty. |
| `paths` | Resolve canonical paths — `paths runtime` for `~/.yaco`, `paths project` for a repo's `yaco.toml [paths]`. |

`yaco claude …` and `yaco codex …` are shortcuts for
`yaco agent start <provider> …`. `start` binds exactly four flags —
`-n`/`--name`, `--wait`, `--timeout-ms`, `--json` — and forwards every other
token verbatim to the provider CLI, so a mistyped yaco flag reaches the agent.

## The skills

The package carries 22 workflow skills — `/design`, `/implement`,
`/orchestrate`, `/code-review`, `/verify`, `/qa`, `/yaco-task`,
`/yaco-worktree`, and the rest — and `yaco install` links them one by one into
`~/.claude/skills`. The install is purely additive: a skill you already have
under the same name is kept and yaco's link is skipped, never clobbered, and
no global instruction file is ever claimed.

Full list:
[`agent-config/global/skills/`](https://github.com/imoonkey/yaco/tree/main/agent-config/global/skills).

## The app

The browser IDE — editor, file tree, diffs, terminals, the agent session tree,
notifications — is a separate package, `yaco-app`. Install it alongside
(`npm install -g yaco-app`), run `yaco-app`, and open <http://localhost:3001>.
It builds on this CLI; this CLI needs nothing from it.

## Documentation

- [Project README](https://github.com/imoonkey/yaco/blob/main/README.md)
- [CLI docs](https://github.com/imoonkey/yaco/blob/main/doc/main/cli/README.md)
  — command surface, session lifecycle, providers, install, paths.
- [Architecture](https://github.com/imoonkey/yaco/blob/main/doc/main/architecture.md)

## License

MIT — see
[LICENSE](https://github.com/imoonkey/yaco/blob/main/LICENSE).
