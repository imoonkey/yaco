---
name: workstream
description: Manage workstream state in doc/todo/ folders. Use `/workstream setup` to bootstrap a new workstream from existing design docs, or `/workstream update` as a protocol reference during execution.
---

# Workstream

Manage workstream state (`workstream.json` + `progress.json`) in `doc/todo/<name>/` folders.

## Usage

```
/workstream setup       # Bootstrap workstream.json + progress.json from existing docs
/workstream update      # Protocol reference for runtime state updates
```

---

# /workstream setup

Generate `workstream.json` for a `doc/todo/<name>/` folder by reading the design docs inside it.

1. Scan the folder for design docs, notes, and any existing structure.
2. Infer a reasonable initial status (usually `active`).
3. Identify the primary doc (the most substantial .md file, or ask the human).
4. Extract checkpoints from the design — look for phase boundaries, review gates, milestones, or checklists.
5. Write `workstream.json`:

```json
{
  "status": "active",
  "doc": "design.md",
  "checkpoints": [
    { "label": "Design approved", "done": false, "need_human_review": true },
    { "label": "Core impl complete", "done": false, "need_human_review": false },
    { "label": "Cross review passed", "done": false, "need_human_review": true }
  ]
}
```

6. Create an empty `progress.json`: `[]`
7. Summarize what was generated and ask the human to confirm or adjust.

### workstream.json schema

| Field | Required | Description |
|-------|----------|-------------|
| `status` | Yes | One of: `active`, `human_review`, `blocked`, `parked`, `done` |
| `doc` | No | Primary doc filename. If omitted, system opens the folder |
| `checkpoints` | No | Array of `{label, done, need_human_review}` |

### Status values

| Status | Meaning | Who sets it |
|--------|---------|-------------|
| `active` | Work in progress | Human only |
| `human_review` | Agent finished a phase, ball is with the human | Agent |
| `blocked` | Cannot proceed, needs human decision | Agent |
| `parked` | Deliberately shelved | Human only |
| `done` | Complete | Human only |

---

# /workstream update

Runtime protocol. Follow this when working inside any `doc/todo/<name>/` folder that has a `workstream.json`.

## 1. Read workstream.json

At the start, read `workstream.json` to understand current status and checkpoints.

**Resume guard**: only proceed automatically when status is `active`. If status is `human_review`, `blocked`, `parked`, or `done`, stop and wait for the human to reactivate the workstream.

## 2. Update workstream.json status

Set status when appropriate:
- `human_review` — when you finish a phase that needs human review.
- `blocked` — when you cannot proceed without human input.

Do NOT set `active`, `parked`, or `done` — those are human-only.

Mark checkpoint `done: true` as you complete them. Check the `need_human_review` field:
- `need_human_review: false` → mark done, append an `info` notification to progress.json, and **continue working**.
- `need_human_review: true` → mark done, append a `human_review` notification, set workstream status to `human_review`, and **stop**.

## 3. Append to progress.json

When something noteworthy happens, append a JSON object to the progress.json array:

```json
{
  "id": "claude-1710787200000",
  "agent": "claude",
  "type": "info",
  "message": "One-line summary of what happened.",
  "timestamp": "2026-03-18T17:30:00Z",
  "status": "active"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique ID: `<agent>-<epoch-ms>` (e.g. `claude-1710787200000`) |
| `agent` | Yes | `claude` or `codex` |
| `type` | Yes | `info`, `human_review`, `blocked` |
| `message` | Yes | One-line summary |
| `timestamp` | Yes | RFC 3339 timestamp with offset (e.g. `2026-03-18T17:30:00Z`) |
| `status` | Yes | `active` (show in Monitor) or `dismissed` (hide) |

Types:
- `info` — FYI: phase completed, checkpoint reached, general update. Agent continues.
- `human_review` — work done, needs human review. Agent stops.
- `blocked` — cannot proceed, needs human decision. Agent stops.

Each new entry triggers a notification to the human (desktop or browser alert).

## 4. Orchestrating sub-agents

When you use multmux to start sub-agents (e.g., in `/double-design`), include in their prompt:

> "Do NOT change workstream.json. Do NOT append to progress.json directly. Report your status back to the orchestrating agent."

The orchestrating agent owns both `workstream.json` status changes and `progress.json` writes. This avoids concurrent write conflicts on the shared JSON array.
