---
name: self-improve
description: Scan recent agent sessions across all projects for repeated manual workflows worth packaging as skills, subagents, or automations. Use weekly, after an intense multi-project stretch, or whenever the user asks "what should I turn into a skill?", "what am I doing over and over?", "package my workflows", or wants to harvest their own history for reusable tooling. Produces a shortlist FIRST, then creates only the high-confidence missing items. Not the same as a retrospective — this is about tooling yourself, not reflecting on what you did.
metadata:
  yaco-dependent: "true"
---

# Self-Improve — harvest your history into reusable tooling

Find work you've done by hand more than once and turn it into tooling you never
hand-do again. The evidence is your own agent history; the discipline is
restraint — most candidates get *skipped*.

**The one rule: shortlist before you build.** Discovery is cheap and finds a
"skill" in every repeated phrase; a created asset clutters the namespace forever.
So the first pass delivers a compact shortlist the user signs off on — never a
freshly-minted skill. You create only after the user has seen the candidates and
the reasoning.

## Where the evidence comes from

Your history lives in yaco — `history` is a read-through over the providers' own
logs (Claude JSONL, Codex SQLite), so it covers **every** session, yaco-started
or not. One session = one row, and the row's **first user prompt** (`summary`) is
the cheapest stable signal of "what kind of task this was." You cluster those
openers to find repetition; you only open a session's full body when a cluster
looks promising. See `/yaco-agent` for the full surface — the shapes you need:

```bash
yaco project list --json
# Windowed, origin-tagged history. --since is ISO-8601 (compute the cutoff
# yourself — relative forms like "30d" are rejected); pass a high --limit so
# `truncated` never fires. With a window/limit, `data` is an OBJECT:
#   { rows: [{summary, updatedAt, provider, sessionId, spawnedBy, parentSession, ...}],
#     returned, truncated, oldestUpdatedAt }
yaco agent history --path <p> --since <iso-cutoff> --limit 100000 --json
yaco agent messages <handle> --summary --json     # what a candidate session DID: tool histogram + prompt landmarks
yaco agent messages <handle> --role user --json   # the full repeated procedure, not just the opener
```

Two row fields are load-bearing:

- **`truncated`** — if `true`, your `--limit` dropped in-window rows and the scan
  is incomplete for that project; raise `--limit`. With a high limit it never
  fires. (`oldestUpdatedAt` is the oldest row returned, for your coverage note.)
- **`spawnedBy`** — drop rows where `spawnedBy === "agent"`. A session started by
  *another agent* (a yaco sub-agent fan-out) is one task exploding into N
  children, not a user's manual workflow; counting it inflates a single task into
  false repetition. Keep `user:*` and `null`. **Caveat:** origin is durable only
  for sessions resolved after the origin index shipped; older GC'd sessions report
  `spawnedBy: null` (unknowable), so an orchestrator opener can still slip through
  — the cross-project signal (phase 2) is your backstop against fan-outs that
  predate the index (an orchestrator's `summary` often embeds file paths / brief
  text that pollutes clustering, which is exactly what dropping `"agent"` rows
  removes).

## Phases

### 1. Discover

Loop `project list` × `history --since <iso-cutoff> --limit <high>`, cutoff =
now − 30 days as an ISO-8601 timestamp. From each project's `rows`, drop
`spawnedBy === "agent"` and note any project still `truncated: true`. Collect
every `summary` with its project, date, and provider — your raw corpus, typically
a few hundred openers. Don't open any session yet.

### 2. Cluster

Group the openers by *intent*, not by wording. "make this a private repo, commit
docs", "init a github repo and push" → one cluster. Look across coding,
research, writing, planning, comms, ops, analysis, and personal admin — the
repetition that's worth tooling is often the boring connective work, not the
headline feature. For each cluster note: how many times, across how many
projects, over what span. A pattern that recurs across *different* projects is
stronger evidence than one that repeats inside a single project's sprint (the
latter is often just one task, restarted). Ten sessions all named "continue the
refactor" inside one project over two days is *one* task, not a recurring
workflow.

### 3. Cross-check what already exists

Before proposing anything, read what's installed: `~/.claude/skills/`, any
custom subagents, any scheduled automations. The fastest win is usually
*extending* an existing asset, not creating a sibling that overlaps it — two
assets covering one job leave neither canonical. If a cluster is already
adequately covered, it's a skip — say so explicitly so the user knows you
checked, not that you missed it.

### 4. Qualify

A cluster earns a place on the shortlist only if **all** hold:

- **Recurred ≥ 2 times**, or is clearly about to recur and is costly to repeat.
  Novelty is not frequency — a fascinating one-off is a skip.
- **Stable inputs, a repeatable procedure, and a clear output / stopping
  condition.** If every instance is shaped differently, there's no SOP to
  capture — skip it.
- **Packaging would materially improve speed, quality, consistency, or
  reliability.** "Could be a skill" isn't enough; it has to *earn* its slot.
- **Not already adequately covered** (from phase 3).

When a cluster looks borderline, open one or two of its sessions —
`messages --summary` to see what it actually did (the tool histogram is
revealing: "always Bash+Write, never Edit" is a generation task), and
`--role user` to see the real repeated procedure. Confidence comes from the
session body, not the opener alone.

### 5. Shortlist (STOP here and show the user)

Emit the compact table below and **stop**. Do not create anything yet.

### 6. Choose the smallest form, then create only the high-confidence items

For each shortlisted candidate the user greenlights, pick the *smallest* form
that fits — adding surface area is a cost, not a feature:

- **Skill** — a reusable workflow / playbook / SOP. The default when there's a
  repeatable procedure with judgment in it.
- **Subagent** — a bounded specialist role or investigation suitable for
  delegation. Use when the work is a self-contained task you'd hand off, not a
  process you'd follow.
- **Automation** — a scheduled/recurring check, report, reminder, or monitor.
  Use when the trigger is *time or an event*, not a user request.
- **Extend existing** — fold it into an asset that already almost covers it.
- **Skip** — too one-off, ambiguous, sensitive, or thinly evidenced.

Create them narrow and validatable. A new skill goes in
`agent-config/global/skills/<name>/SKILL.md` and follows `/write-skill`. Don't
create speculative, overlapping, or broad-by-default assets — when unsure between
two scopes, ship the narrower one.

## Output template

Phase 5 prints exactly this, then waits:

```
## Self-improve scan — <date range>, <N> sessions across <M> projects

### Shortlist
| Workflow | Evidence (counts + dates + projects) | Freq/confidence | Form | Worth it? |
|----------|--------------------------------------|-----------------|------|-----------|
| ...      | ...                                  | high            | skill | yes — ... |

### Deliberately skipped
- <pattern> — <why: one-off / already covered by X / inputs too varied / too sensitive>

### Needs more evidence before packaging
- <pattern> — <what additional signal would settle it>

### Scan coverage
- Projects that returned `truncated: true` even at the raised --limit (older sessions not seen): <list, or "none">
```

After the user picks, do phase 6 for the greenlit rows only.

## Done =

A signed-off shortlist, the greenlit assets created (narrow, validatable, in the
right form), and the skip + coverage notes from the template. "I made five
skills" is not success — "I found the two patterns worth tooling, built them, and
told you why the other six weren't" is.
