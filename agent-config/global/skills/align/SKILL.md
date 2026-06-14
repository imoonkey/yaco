---
name: align
description: Align the design of the system or anything else between Codex and Claude.
metadata:
  yaco-dependent: "true"
---

# Align

Align the design of the system or anything else between Codex and Claude.

Align uses a `discussion/status.txt` handoff protocol, numbered discussion
turns (`NNNN_{CLAUDE,CODEX}.md`), and a self-contained `final/*` output
inside a YACO project bundle.

## Principles

### Alignment Principles

- Never assume — when the other agent disagrees or raises a point you didn't cover, investigate: read code, search the web, analyze data. Resolve disagreements with evidence.
- Stay open-minded but principled. Don't compromise easily. The goal is not fast consensus but high-quality consensus.
- For key disagreements unresolved after multiple rounds, summarize as open questions in the final doc and escalate to the master user.

### Design Principles

Write and discuss the design like Linus Torvalds would.

- **KISS** — keep it simple, stupid. Avoid over-design and over-engineering. Minimal nesting depth.
- **Minimal redundancy** — if simpler logic achieves the same result, use it. Turn edge cases into canonical cases through smart design rather than special-casing. Simplify state machines the same way, explicit or implict.
- **High readability** — code should be self-evident
- **No backward compatibility** — code reflects the latest, best implementation only. No legacy hacks, no deprecation shims. Product is pre-release.
- **Align with codebase** — read existing code first, make sure your design is aligned. DRY and don't reinvent wheels, but old codebase could have slops, don't refrain from enforcing better patterns.
- Question assumptions — why does it have to work that way?
- Prefer designs that turn edge cases into canonical cases
- Specify key interactions as state machines where applicable (states, transitions, guards, side effects)
- No broken windows: no dead ends, no ambiguous states, no undefined behavior
- Use `/ultra-think` for critical decisions

## Process

### Directory Convention

```
[project_folder]/
  discussion/
    status.txt                 # Single-line state file
    0001_CODEX.md              # One file per turn (append-only)
    0002_CLAUDE.md
    ...
  final/
    *.md                       # Aligned output (one or more files)
    ...
```

Files under `final/` must be self-contained, complete documents (designs, analyses, etc.) — readable without referring back to individual discussion files. They should not merely record conflict resolutions or key decisions while omitting consensus details.

### Final Doc Quality Bar

`final/*` reads as a single-author artifact, not a record of the debate — implementable by someone who never opened `discussion/`.

- One top-down narrative, single voice, one term per concept.
- No alignment seams: no "Aligned Decisions", "Codex/Claude said", "both reviewers split", "Resolved during alignment", or round references. Deliberation and resolved trails live in `discussion/`; only an unresolved Open Question packet names both sides (see Open Questions).
- Keep design rationale, cut process narration.
- Every consensus detail present; each open question's assumed default written into the body, so it stays buildable.

This is an approval gate: don't vote `APPROVE` while `final/*` violates it — return `CHANGES` like any other defect.

### Open Questions

Resolve disagreements with evidence first; escalate only what needs the user. Each open question is a decision packet, not a bare question:

- **Question / Impact / Options** — the decision, what it changes downstream, the real alternatives with trade-offs.
- **Recommendation** — the default `final/*` assumes (also written into the body).
- **Positions** — each side's lean and the crux, only when Codex and Claude actually diverge.

≤2 short packets inline; ≥3 or any large one → `final/open_questions.md` with one-line pointers in the body (when unsure, use the file). Resolved → fold into the body, delete the packet.

### status.txt (single-line format)

Single line, space-separated key=value pairs:

```
SEQ=0000 NEXT=CODEX CODEX=PENDING CLAUDE=PENDING
```

Fields:

* `SEQ`: incrementing integer (+1 per round)
* `NEXT`: `CODEX` / `CLAUDE` / `DONE`
* `CODEX`, `CLAUDE`: `PENDING` / `APPROVE` / `CHANGES`

### State Machine

* `NEXT=CODEX`: Codex's turn to write
* `NEXT=CLAUDE`: Claude's turn to write
* Termination: `CODEX=APPROVE` and `CLAUDE=APPROVE` → `NEXT=DONE`

### SOP (both agents follow this)

#### 0) Start

- The prompt specifies which agent goes first. That agent initializes the folders.
- If there is no initial draft, create one based on available references (individual designs, codebase, etc.) — document consensus, clarify conflicts, different opinions, and open questions.

#### A) If `NEXT` is not you

1. **Do not read, think, or write anything** — only poll and wait.
2. Block-wait using the poll command (**never hand-write sleep loops — they pollute context**):

   ```bash
   yaco align poll <path/to/discussion/status.txt> <CLAUDE|CODEX> --json
   ```

   With `--json` the command blocks and writes one envelope line to
   stdout when it's your turn or done:
   `{"ok":true,"data":{"status":"YOUR_TURN", ...}}` (or `"DONE"`).
   Exit code is 0 in both cases; on `TIMEOUT` / `ERROR` the envelope
   becomes `{"ok":false,"error":{"code":"align.timeout"|"align.error", ...}}`
   on stderr (exit 1 / 2). Best-effort poll details are appended to
   `poll.log` next to `status.txt`.
3. Parse `data.status` from the envelope. `YOUR_TURN` → go to B. `DONE` → go to C.

#### B) If `NEXT` is you

You are the **only one allowed to write** (both `discussion/` and `final/`).

1. Read all discussion files under `discussion/` (ascending by SEQ), especially the other agent's latest file.
2. If the aligned output needs updating: modify/add `final/*`. Edit incrementally; restructure locally when needed to keep it coherent against the Final Doc Quality Bar.
3. Create a new discussion file (**always create, never modify old files**):
   * Filename: `{newSEQ}_{YOU}.md` (e.g. `0003_CODEX.md`)
   * Keep it short: this round's conclusions, what changed, unresolved issues, your vote (APPROVE/CHANGES).
4. Update `discussion/status.txt` (still single line):
   * `newSEQ = SEQ + 1`
   * Set your vote: `YOU=APPROVE` (only if you made zero changes to `final/*` this round) or `YOU=CHANGES` (if you made any changes to `final/*`)
   * **If you made any substantive changes to `final/`** (approach/interfaces/constraints/assumptions), reset the other agent's vote to `PENDING`
   * If both are now `APPROVE`: set `NEXT=DONE`
   * Otherwise: set `NEXT=<other agent>`
5. Call the poll command again to wait for the other agent's response or DONE:

   ```bash
   yaco align poll <path/to/discussion/status.txt> <CLAUDE|CODEX> --json
   ```

#### C) If `NEXT=DONE`

Both agents have approved. End polling.

**Status update examples:**

* Codex makes changes, hands to Claude:
  ```
  SEQ=0001 NEXT=CLAUDE CODEX=CHANGES CLAUDE=PENDING
  ```
* Claude finishes and approves, resets Codex for review:
  ```
  SEQ=0002 NEXT=CODEX CODEX=PENDING CLAUDE=APPROVE
  ```
* Codex reviews and approves, done:
  ```
  SEQ=0003 NEXT=DONE CODEX=APPROVE CLAUDE=APPROVE
  ```

### Hard Rules

* **Only write files when `NEXT` is you** (including `final/*` and `discussion/*`).
* Discussion is append-only: always create new `####_AGENT.md` files, never edit old ones.
