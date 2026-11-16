---
name: implement
description: Full implementation workflow — plan, phased build with review loops, verify. Use for any non-trivial feature or system design.
---

# Implement

`/implement [goal or task reference]` — drive a goal (system design, feature, refactor) from plan to done.

A **task reference** (task id or design-doc path) carries scope · acceptCriteria · depends — that is your contract. A freeform **goal** first opens a task into the **active** set to hold it; completing auto-archives it.

## Principles

Think like Linus Torvalds. Beyond the global rules (KISS, minimal redundancy, edge→canonical, readability, no backward compat, read existing code first): use `/ultra-think` for critical or complex design decisions.

**A step earns its cost.** The recipe's order is fixed; what each step spends is not. Code that ships gets every step in full; a demo, prototype, or spike gets the shortest pass that shows it correct and simple. Stated intent (user, task, CLAUDE.md) decides; unstated, assume it ships.

## The recipe

Each step invokes the skill it names, the boring tail included. How you run it — prompt, subagent, tools — is yours.

1. **Plan** — write it to a file: phases, affected files, key design decisions. Each phase is independently committable; a reasonable scope is one phase.
2. **Build, per phase** — implement → `/verify` → `/code-review` → fix, until both are green; then commit, leaving the branch buildable.
   - Implement in a fresh subagent where you can: `/simplify-code-arch` always, `/tdd` and `/coding-standards` when the logic warrants.
   - `/verify` goes first: cheap and deterministic, it fails before a reviewer is spent on code that doesn't build.
   - The reviewer did not write the code — a fresh subagent at least, the *other provider* when the stakes warrant (`yaco agent start <other-provider> "..." --wait`, then `yaco agent kill`; a worker may spawn its own).
   - A finding is settled by changing the code, or by persuading the reviewer next round.
3. **`/qa`** — once, after all phases land, over the user flows the change affects. `/verify` never substitutes for it.
4. **Completeness** — re-read the whole diff against the goal and hunt for what you never built. Every other step checks what is *present*; only this one catches what is *absent*. A gap sends you back to step 1.
5. **`/update-doc`** — `docs/` (`yaco paths project --json` → `docs`), project-local skills in `./.claude/skills/*`, and the PROGRESS trace (`docs/PROGRESS.md` if the project keeps one, else `<plan>/PROGRESS.md`). Milestone-scale work also gets its handoff narrative: `/impl-summary` into the bundle home.
6. **Finish** — `yaco gate` until all-green: it runs the whole suite and checks the evidence the diff owes (verify · doc · review · qa). A red check is work still owed, not a place to stop. In a repo without a gate (`scripts/gate.sh`), run `/verify` over everything instead.

**Evidence** is filed only for the gate to read. Where the repo has one, save each review and qa report in the `/yaco-paths` bundle home, named `*review*` / `*qa*` and headed `reviewed_sha: <commit checked>`; a review also names its reviewer, base and scope, verdict, and unresolved critical/high count.

Compact at phase boundaries (`/yaco-agent` → Context). Recording task-graph status is not `/implement`'s job.
