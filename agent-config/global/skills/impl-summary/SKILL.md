---
name: impl-summary
description: Write an implementation summary for landed work — top-down outcome, before/after structure, major changes by module — never a chronological commit/task log. Use when a milestone or multi-phase implementation lands (tail of /implement or an orchestration session), or whenever asked to summarize implemented work.
---

# Implementation Summary

One handoff document, two readers at once:

- **manager/director** — plain-language what / why / outcome; can stop after the header and the top-down section and know what landed and whether to trust it.
- **onboarding engineer** — an architecture-level entry into the diff: before/after shape, module map with sizes, the load-bearing file paths to start reading from.

The failure mode this skill exists to kill: a chronological walk over commits/tasks (流水账). Time order serves neither reader. **Organize by structure and importance — modules, seams, invariants — never by sequence of events.** Commits appear only as evidence: the range in the header, a hash in a gate table.

## Where it goes

The plan bundle that owns the work (e.g. `plan/all/<bundle>/implementation-summary.md`; in a yaco project resolve the bundle home via `/yaco-paths`). Match the bundle's existing language convention (zh docs keep key terms in English); don't mix languages within the doc.

## Skeleton

Adapt, don't force — but keep the order: most compressed first.

```
# <milestone> — implementation summary
> status/date · commit range `A..B` · net diff (src+tests split out) · tasks landed
> links: design doc · plan · reviews/QA artifacts

## 1. What this was for      one short paragraph, plain language: the goal, what landed
## 2. Outcome, top-down      before→after tree diff or "X now owns Y" ownership list,
                             then a per-module table (diff size · files · nature), sorted by size
## 3. Major changes          one section per change worth telling; depth ∝ importance
## 4. Process & footnotes    how quality was enforced + what went wrong
## 5. Evidence               table: artifact → path
## 6. Open threads           deferred / deliberately-not-done, each with its reason
## Appendix (optional)       verbatim /discuss Q&A, when a discussion shaped the conclusions
```

## Section rules

- **§2 before→after is the engineer's anchor.** A two-column annotated directory-tree diff, or an ownership list ("`kernel/factor` now owns X; `research/factor` owns Y"). The module table that follows, sorted by diff size, tells the reader where to spend attention.
- **§3 each major-change section answers three things**: *what* changed in terms of responsibilities and invariants (not diff mechanics), *why* — the design logic (what was fork-prone, duplicated, or homeless before), and *how it was proven* — the specific mechanism ("golden byte-equivalence gate against frozen curves", not "tests pass").
- **Headline numbers carry their caveat inline** — "+45.7pp (screening only, one seed)". A number stated without its trust tier will be quoted without it.
- **Bold the load-bearing conclusions.** The manager's path through the doc is headers + bold; make that path complete on its own.
- **Honest footnotes are mandatory, not optional color**: failures that happened (even if recovered), flakes, scope adjusted mid-flight, known pre-existing issues left unfixed and why they're out of scope. A summary that reads all-green reads as unreviewed.
- **§6 states why each thread is open** — "deferred until first real caller" beats a bare TODO.
