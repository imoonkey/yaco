---
name: align
description: Align the design of the system or anything else between Codex and Claude.
metadata:
  yaco-dependent: "true"
---

# Align

Align the design of the system or anything else between Codex and Claude.

Align uses the `yaco align` CLI for turn handoff (a `wait → work → handoff`
loop), numbered discussion turns (`NNNN_{CLAUDE,CODEX}.md`), and a
self-contained `final/*` output inside a YACO project bundle.

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
    status.txt                 # Coordination state — owned by `yaco align`, never hand-edit
    .align/                    # CLI-internal turn metadata
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

### SOP (both agents follow this)

The `yaco align` CLI owns all coordination state — `status.txt`, turn-file
numbering, and vote inference. You never read or write `status.txt` by hand:
you call four verbs and write content. Your whole loop is **wait → work →
handoff**.

#### Start (first mover only)

The prompt names the first mover. That agent initializes the bundle once, then
enters the loop:

```bash
yaco align init <bundle> --first <CODEX|CLAUDE> --json
```

If there is no initial draft, create one in `final/` from the available
references (individual designs, codebase) — capture consensus, flag conflicts
and open questions. The other agent skips `init` and goes straight to `wait`.

#### Each turn

1. **Wait for your turn** — blocks until it's you or the alignment is done
   (**never hand-write sleep loops; they pollute context**):

   ```bash
   yaco align wait <bundle> <CODEX|CLAUDE> --json
   ```

   - `{"status":"YOUR_TURN","seq":N,"turnFile":...,"finalDir":...}` → your turn;
     the CLI reserved `turnFile` for you. Go to step 2.
   - `{"status":"DONE"}` → both sides approved. Stop.

2. **Work.** Read the latest `discussion/*` (especially the other agent's last
   turn). Edit `final/*` as needed, holding it to the Final Doc Quality Bar and
   Open Questions schema. Write this round's notes to the reserved `turnFile`
   (conclusions, what changed, unresolved issues) — keep it short.

3. **Hand off:**

   ```bash
   yaco align handoff <bundle> <CODEX|CLAUDE> --json
   ```

   The CLI infers your vote from `final/`: any edit ⇒ `CHANGES` (the other side
   must re-review); no edit ⇒ `APPROVE`. When both sides approve, the next
   `wait` returns `DONE`.

Loop back to step 1.

### Hard Rules

* Edit `final/*` and write your turn file only between `wait` and `handoff` —
  that window is your turn (the CLI rejects out-of-turn handoffs).
* Discussion is append-only: write to the `turnFile` the CLI reserves for you,
  never edit an earlier `####_AGENT.md`.
* Let the CLI own `status.txt`, SEQ, and vote inference — don't hand-edit them.
