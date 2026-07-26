---
name: simplify-code-arch
description: Subtractive-KISS discipline — write code pre-collapsed so no cleanup pass is needed. Use when implementing or designing code, BEFORE adding any abstraction (class, registry, config knob, mode), when reviewing your own diff, or planning a subtraction pass.
---

# Simplify Code Architecture

Write the least code that satisfies the acceptance criteria. Fewer classes, layers, and
abstractions win. Design **deep modules**: a lot of behaviour behind a small interface,
placed at a clean seam.

Anchor on the dumbest baseline that works — a commit hash, a JSON file, a plain
function, a `raise`. Every addition over it must name what breaks without it.

## Glossary

Use these terms exactly — don't substitute "component," "service," "API," or "boundary."
Consistent language is the whole point.

**Module** — anything with an interface and an implementation. Deliberately
scale-agnostic: a function, class, package, or tier-spanning slice. *Avoid*: unit,
component, service.

**Interface** — everything a caller must know to use the module correctly: the type
signature, but also invariants, ordering constraints, error modes, required
configuration, and performance characteristics. *Avoid*: API, signature (too narrow —
they refer only to the type-level surface).

**Implementation** — what's inside a module, its body of code. Distinct from
**Adapter**: a thing can be a small adapter with a large implementation (a Postgres
repo) or a large adapter with a small implementation (an in-memory fake). Reach for
"adapter" when the seam is the topic; "implementation" otherwise.

**Depth** — leverage at the interface: the amount of behaviour a caller (or test) can
exercise per unit of interface they have to learn. A module is **deep** when a large
amount of behaviour sits behind a small interface, **shallow** when the interface is
nearly as complex as the implementation.

**Seam** *(Michael Feathers)* — a place where you can alter behaviour without editing in
that place; the *location* at which a module's interface lives. Where to put the seam is
its own design decision, distinct from what goes behind it. *Avoid*: boundary
(overloaded with DDD's bounded context).

**Adapter** — a concrete thing that satisfies an interface at a seam. Describes *role*
(what slot it fills), not substance (what's inside).

**Leverage** — what callers get from depth: more capability per unit of interface they
learn. One implementation pays back across N call sites and M tests.

**Locality** — what maintainers get from depth: change, bugs, knowledge, and
verification concentrate in one place rather than spreading across callers. Fix once,
fixed everywhere.

## Gates

Every new module, class, interface, registry, parameter, or recorded field passes all
four, or doesn't get written. Two standing checks apply to everything: you can state its
job for a present caller in one plain sentence, and the accepted design asked for it —
implementation must not grow surfaces the design didn't call for.

1. **Present caller.** Who calls this today, outside its own tests? Code consumed only
   by tests written for it exists to be tested, not to be used. A caller that is itself
   scaffolding doesn't count — trace the chain to a shipped surface. A future feature is
   born with its first real caller and grows its structure there — don't pre-build for it.
2. **Second adapter.** One adapter means a hypothetical seam. Two adapters means a real
   one. Don't introduce a seam unless something actually varies across it: no registry,
   dispatch, base class, or kind enum over a single implementation; reserved names for
   future implementations are the same smell. When the second arrives, extract a plain
   function, not a type.
3. **Derivability.** Keep a recorded/returned field iff its value can still change once
   the existing pins are fixed. Never hash what a version pin already determines, never
   re-record a transitively-pinned value, never self-hash, never echo inputs back.
   Record raw params, not their hash — the raw value is the information.
4. **Correctness is not scaffolding.** Invariants — no-look-ahead, determinism,
   fail-closed validation — are the product; keep them as plain functions or inline
   checks. The registry / state machine / artifact lifecycle around them is not.

## The deletion test

Imagine deleting the module. If complexity vanishes, it was a pass-through — delete it.
If complexity reappears across N callers, it was earning its keep.

## Smells

| Smell | Fix |
|---|---|
| Interface forces the caller to fabricate a value it doesn't use | Reshape around what callers actually have |
| Dataclass whose only job is carrying params between functions | Pass the params |
| Two modes in the same cell of the real decision grid, differing by one orthogonal knob | One name + a flag |
| Parameter that only ever takes one value | Weld it into the name (`min_history=20` → `realized_vol_20d`) |
| Metadata fields nothing traverses (`deps`, `kind`, ids) | Delete; keep genuinely-read data as a literal |
| State machine / trial identity / recovery for a manual flow | Failure raises, success appends |
| Aliases, duplicate formulas, re-export or back-compat shims | One identity, one implementation |
| File or type named by capability (`runtime.py`, `Manager`) | Name by what it owns (`alphas.py`) |
| Validation bypass flag (`allow_incomplete`) on a public surface | Delete |
| Re-validating what the layer below already fails on (column checks, existence guards) | Write assuming the input; let the substrate fail |
| Second vocabulary for an existing mechanism (a parallel hash, manifest, id format) | Reuse the repo's existing one |
| Static fact tracked as runtime state (an "approximate" registry, a reasons enum) | A comment or doc table |
| Object reifying a behaviour that exists without it (a summary of skips the code already makes) | Keep the behaviour, delete the object |
| Capability whose producer or consumer is retired (a registry guarding a door nobody walks through) | Delete or defer the whole chain |

## Interfaces

- One method, one honest signature; the body is free — no mandated internal pipeline.
- Every parameter, field, and function sits at the narrowest scope that reads it. A
  factor-internal window is not a panel-level knob — plumbing it through higher
  interfaces is a category error, however many callers the plumbing has.
- Before building a solution, look for the representation that makes the problem
  disappear (JSON params carry types → no coercer; welded window → no manifest entry).
- The constructor signature is the declaration. No parallel schema layer mirroring
  `__init__`; typed values in, and an unexpected-kwarg `TypeError` is the free
  fail-closed check. The invariant is the outcome (unknown params fail), not the
  mechanism.
- Abstract only on real duplication between two implementations — into a plain function.
- Borrow libraries (run on your data); don't adopt frameworks (own your flow and format).

## Fail closed

Unknown name, unknown param, duplicate registration, malformed row → error, never a
silent skip. An accepted flag is either fully wired or rejected. A gate earns its place
by naming the bug class it catches and failing closed on a live path — a check that
passes without proving its property, or fails without localizing the cause, is
decoration.

## Subtracting existing code

1. **Census first.** Table each component: live callers (grep-verified, non-test) →
   verdict. Cite the evidence.
2. **Pay the deletion bill.** Layers secretly hold things up — the one real table inside
   a dead registry, the writer half of a shared format, an inlined correctness check.
   Move these out explicitly; never bare-delete.
3. **Byte-equivalence.** A structural collapse changes zero numerics; golden tests pin
   values before/after. Never bundle a perf rewrite into it.
4. **Don't over-delete.** What the accepted design explicitly asked for stays, even if
   approximate. When replacing an implementation, dual-run old and new and eyeball the
   diff before retiring either.
5. **Grep gate.** Deleted symbols return zero hits in live code; lint + types + tests
   green; no deprecation shims.
6. **One pass, one blast radius.** Adjacent problems get their own brief; state explicit
   non-goals.

## Self-review before presenting a diff

- Any new symbol without a present, non-test caller? Anything the design didn't ask for?
- Can you state each new component's job in one plain sentence?
- Any new class expressible as a function? Any function as a call site?
- Any recorded field that fails derivability? Any knob with one value in use? Any
  param above the narrowest scope that reads it?
- Would the diff survive its own census table?
