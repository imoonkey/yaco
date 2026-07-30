---
name: refer
description: Add a source to the shared reference library and — only if you have something to say — write about it. Use when archiving a paper/repo/article for later, or when the user says "存进 reference" / "refer this".
---

# Refer

The reference library lives at `~/ld-workspace/reference` (desktop) or
`~/workspace/reference` (laptop). Two layers, nothing else:

- `source/<id>/` — **only bytes**: `content.md`, `paper.pdf`, or a git checkout. Nobody edits these.
- `wiki/source/<id>.md` — **everything about those bytes**: all metadata, plus whatever we wrote.

## The three steps

1. **Grab the raw material.**

   ```bash
   uv run python -m ref.get <url>
   ```

   Bytes land in `source/<id>/`; the metadata page is created automatically at
   `wiki/source/<id>.md` with an **empty body**. That is the whole of step 1.

2. **Write only if you actually have something to say.** Then, and only then, open
   `wiki/source/<id>.md`, fill in `description` and `tags`, and write the body.

   **An empty body is a valid resting state, not a TODO.** Do not "complete" a page
   because it looks unfinished. There is no *general* body template — a template with
   slots invites filling the slots, and filled ≠ worth saying. When you ARE writing a
   deep review, a domain-specific checklist may exist under `references/` (currently
   only `references/quant-ml-paper-review.md`, for quant/trading-ML papers — do not
   apply it to papers outside that domain; sections you have nothing to say about are
   skipped with numbering kept; implicit assumptions count as content).

3. **If this changed a conclusion**, append a line to `wiki/domain/<name>/log.md`
   (create it if the domain has none) — what claim got overturned or merged, and why.
   Only for judgments; "added a URL" is already in the git log.

## The two fields you own

Everything else in the frontmatter is written by the fetcher and will be overwritten
on the next fetch. These two are yours and are preserved:

```yaml
description: one line — what this is and why it is worth keeping
tags: [<topical>, ...]
```

**`tags` rule**: a tag is a property of the *source* ("what is this about"), never a
property of a *relationship* ("who used it"). `factor`, `alpha-mining`, `benchmark`
are tags. You are encouraged to reuse tags, so relevant wikis can be connected through tags.

## Finding things

```bash
uv run python -m ref.index                 # everything
uv run python -m ref.index --unwritten     # archived but unwritten — the frontier
uv run python -m ref.index --tag finance
rg -l 'tags:.*finance' wiki/source/ | xargs rg -l 'tags:.*benchmark'   # intersect
```
