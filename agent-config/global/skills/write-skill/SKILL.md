---
name: write-skill
description: Quality bar for authoring skills — keep SKILL.md, references/, and scripts lean, current, and code-clean. Use when writing, editing, or reviewing a skill.
---

# Write Skill

> A skill is executable prose: loaded into context, it runs. Write it like code, compress it like a doc.

These rules govern a skill's executable surface — the body and any `references/` docs or `scripts/` it bundles. The frontmatter `description` obeys the same thrift, but its job is *selection*: cover every when-to-use context in the fewest words, never pad it.

## Axiom — a skill earns every token by changing execution

A skill is a lossy compressor of a task, and its ground truth is **the task plus what the model already does well by default**. It earns its tokens only by lowering the agent's *total* cost of doing the task right = reading the skill + re-deriving whatever it left out + undoing whatever it would otherwise get wrong. Carry exactly that residual — the procedure, ordering, judgment, and landmines that are expensive to re-derive and cheap to state — and nothing else.

The test is **surprisal**: keep a line only if a capable agent wouldn't already do it unprompted and know it's right. Restating a default ("write clean code", "think step by step") is *worse than silence* — it spends tokens and buries the lines that carry signal. Depth tracks information, not length: one landmine can deserve a paragraph; ten obvious steps deserve none.

## Corollaries

- **No document-archaeology.** A skill has no comment channel — every line is read as instruction. State only the current target behavior, as if it always was; cut "used to / now / previously / differs from the original / we removed". Keep the *why* that steers a choice — it changes what the agent does; drop the *why* behind the document's own edits — that belongs in commits and history, not in the skill.
  - Bad: `Previously this ran three phases; we merged phase 2 into 1, so now there are two. The old --legacy flag is gone.`
  - Good: `Run two phases: 1) … 2) …`

- **Lead with the shape, not prose.** A skill encodes a process, a set of gates, or a handful of principles — whichever it is, state it in its densest faithful form (a numbered list, a phase sequence, a table, a state machine) and reserve prose for the rationale that no structure can hold. The shape carries the *what*; words carry only the *why*.

- **Deep skill, progressive disclosure.** The SKILL.md body is the interface; `references/` and `scripts/` are the implementation behind it. Keep the always-loaded surface small and push depth down a layer, read on demand. Apply the **deletion test** to anything below the top: a `references/` file read on *every* trigger isn't a reference, it's the body — inline it; a three-line "script" the prose could just state is a shallow extraction — cut it. Bundle a script only for deterministic logic repeated across runs, so the behavior has one home instead of being re-derived each time.

- **One owner per fact.** State each rule once, at the highest layer that governs everything below it, and point to it from everywhere else — never restate it across the body, `references/`, and `scripts/`, or across sibling skills. Two copies are two things to keep true, and one will drift.
