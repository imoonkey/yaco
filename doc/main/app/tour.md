# Visual Tour

What the app looks like in use. Every screenshot is this repo, driving its own
agents — nothing staged. Each one ships in both themes: your browser's
`prefers-color-scheme` picks which you see, so the shots below are light unless
your OS or browser is set to dark.

## Owns

- User-facing screenshots of the app and the captions that explain them

## Does Not Own

- Behavior specs (see [ui/](ui/)) and component/state detail (see [frontend/](frontend/))
- Capture tooling — the shots are taken by hand against a running instance

## The layout

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/hero-dark.png">
  <img src="../../assets/hero-light.png" alt="The workspace: repo on the left, working area in the middle, sessions on the right">
</picture>

Three regions, and the middle one is the whole app:

- **Left** — projects, the file tree (with the worktree picker in its header),
  and git changes.
- **Middle** — tab *groups*. Each group holds an ordered strip of editors,
  diffs, terminals, and the Tasks tab, and any group can split right or down.
  Editors and agent terminals sit side by side because they are the same kind
  of thing here.
- **Right** — live agent sessions, nested parent → child, with status dots and
  worktree badges. Clicking one attaches a terminal to it.

## Sessions are the point

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/agent-tree-dark.png">
  <img src="../../assets/agent-tree-light.png" alt="yaco agent list and status in a terminal beside the app's session tree">
</picture>

The CLI and the app read the same session state. `spawnedBy: agent` plus
`parentSession` is the entire lineage model — here an orchestrator started a
worker in its own worktree, and that worker can start its own reviewer in turn.
Every one of them is a session you can list, capture, attach to, or kill,
whoever created it.

Every terminal is a tmux session, so closing the tab, restarting the server, or
switching devices doesn't end anything.

## The plan, rendered

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/tasks-dark.png">
  <img src="../../assets/tasks-light.png" alt="The task graph, stacked view">
</picture>

`plan/tasks/` rendered live: milestones with their tasks, per-task state, and
the worktree slug each one runs in. Workset (active / backlog / archive) and
state are filters, not separate screens.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/gantt-dark.png">
  <img src="../../assets/gantt-light.png" alt="The same graph as a Gantt with dependency edges">
</picture>

The Gantt view draws the real `depends` edges. Hatched bars are estimates the
graph assumed rather than ones you wrote down.

## One task, one checkout

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/worktrees-dark.png">
  <img src="../../assets/worktrees-light.png" alt="The worktree picker listing main and two task branches">
</picture>

`yaco worktree` puts each task on `task/<slug>` under `.worktrees/`. The
explorer header switches the entire workspace — files, git, diffs, drafts —
between them, while your terminals keep running where they are.

## Docs are first-class

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/markdown-dark.png">
  <img src="../../assets/markdown-light.png" alt="A markdown file with its source and rendered preview side by side">
</picture>

Markdown opens with source and render side by side, scroll-synced, with mermaid
rendered inline — because the `/design` and `/discuss` loops mean reading and
editing the same doc an agent is writing into.

## Attention, not polling

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/notifications-dark.png">
  <img src="../../assets/notifications-light.png" alt="The notification panel with finished tasks and sessions waiting on a reply">
</picture>

Sessions and tasks raise their own notifications with the actual content, not a
template. The bell dismisses them; the history tab keeps the past ones in
muted past tense.

## Watch it work

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/walkthrough-dark.gif">
  <img src="../../assets/walkthrough-light.gif" alt="Opening the task graph, switching to the dependency view, splitting the working area, attaching to an agent session">
</picture>

Open the task graph, look at the dependencies, split the working area, and
attach to the agent executing the plan — its transcript lands in the pane next
to the task list it is working through.

## From your phone

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/mobile-dark.png">
  <img src="../../assets/mobile-light.png" alt="The same agent session on a phone">
</picture>

The same workspace, laid out for a small screen: Browse / Editor / Tasks /
Terminal instead of docks, a key bar for the terminal keys a phone keyboard
lacks, and voice input for writing prompts. Reach it over Tailscale or whatever
you already use.
