---
name: impl-summary
description: Write an implementation summary for landed work — top-down outcome and structure, never a chronological commit log. Use when a milestone lands or when asked to summarize implemented work.
---

# Implementation Summary

One handoff document, two readers at once:

- **manager/director** — plain language, four questions: did we achieve the goal, what changed (at a level they can reason about), **can it be trusted**, what needs their decision. The header + §1 + §2 must stand alone as their complete read.
- **onboarding engineer** — an architecture-level entry into the change: the after-state map, where to start reading, which invariants the change enforces, what's deliberately absent (so they don't "fix" it).

The failure mode this skill exists to kill: a chronological walk over commits/tasks (流水账). Time order serves neither reader. **Organize by structure and importance — modules, seams, invariants — never by sequence of events.** Commits appear only as evidence: the range in the header, a hash in a gate table.

## Where it goes

The plan bundle that owns the work (e.g. `plan/all/<bundle>/implementation-summary.md`; in a yaco project resolve the bundle home via `/yaco-paths`). Match the bundle's existing language convention (zh docs keep key terms in English); don't mix languages within the doc.

## Skeleton

Adapt, don't force — but keep the order: most compressed first.

```
# <milestone> — implementation summary
> status/date · commit range `A..B` · net diff (src+tests split out) · tasks landed
> behavior-preserving or behavior-changing — and the mechanism that proves the boundary
> links: design doc · plan · reviews/QA artifacts

## 1. What this was for      one short paragraph, plain language: the goal, what landed
## 2. Outcome, top-down      before→after in the dimension that changed, then a per-module
                             table (diff size · files · nature) sorted by size,
                             ending with where the engineer should start reading
## 3. Major changes          one section per change worth telling; depth ∝ importance
## 4. Process & footnotes    how quality was enforced + what went wrong
## 5. Evidence               table: artifact → path
## 6. Open threads           deferred / deliberately-not-done, each with its reason;
                             flag anything awaiting the reader's decision
## Appendix (optional)       verbatim /discuss Q&A, when a discussion shaped the conclusions
```

## Section rules

- **The header's trust line is the single most load-bearing sentence.** Say whether observable behavior changed, and what proves the boundary ("golden byte-equivalence gate against frozen curves" for a pure refactor; "new path only, old paths untouched — grep + regression suite" for a feature). Risk assessment starts here.
- **§2's before→after lives in the dimension that changed.** Structural refactor → annotated two-column tree diff or ownership list ("`kernel/factor` now owns X"). New capability → what the system can do now vs before, plus the new path's shape (input → seams → output). Behavior change → old contract vs new contract. Don't force a tree diff onto a feature, or a feature narrative onto a refactor.
- **Diff size guides attention; it is not importance.** Sort the module table by size so the reader knows where the mass is, but call out small load-bearing changes (an invariant flipped, a gate added) explicitly in §3 — a 5-line change can outrank a 1000-line move.
- **§3 each major-change section answers three things**: *what* changed in terms of responsibilities and invariants (not diff mechanics), *why* — the design logic (what was fork-prone, duplicated, or homeless before), and *how it was proven* — the specific mechanism, not "tests pass".
- **No session-local shorthand.** The reader didn't watch the session: expand task ids, codenames, and internal abbreviations on first use, or drop them.
- **Headline numbers carry their baseline and caveat inline** — "+45.7pp vs random baseline (screening only, one seed)". A number stated without its comparison point and trust tier will be quoted without them.
- **Bold the load-bearing conclusions.** The manager's path through the doc is headers + bold; make that path complete on its own.
- **Honest footnotes are mandatory, not optional color**: failures that happened (even if recovered), flakes, scope adjusted mid-flight, known pre-existing issues left unfixed and why they're out of scope. A summary that reads all-green reads as unreviewed.
- **§6 states why each thread is open** — "deferred until first real caller" beats a bare TODO.
