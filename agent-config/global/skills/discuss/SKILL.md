---
name: discuss
description: Discuss with the user inside a markdown doc — reply in place to their `>`-marked comments, keeping multi-round Q&A navigable from the preview. Use when the user runs `/discuss`, or says they left notes / questions / comments in a doc to answer inline rather than in chat.
---

# Discuss

The user thinks by leaving comments in a doc — each marked with a `>` blockquote
so it stands out in the markdown preview — and wants you to answer them *in
place*, right under each comment. Two jobs: answer well, and keep the thread
navigable as it grows across rounds.

They invoke this with `/discuss` after writing a new comment, so you won't get a
restatement of the question — go find it. Lifecycle: each `/discuss` is one
round (find new comments → reply in place); when the discussion converges,
`/discuss wrap up` folds the decisions into the doc and archives the thread (see
**Wrap-up** below).

## Find what to answer

A comment awaiting reply is a `>` blockquote with **no `>>` reply nested under
it**. Answer every such comment — a single `/discuss` may have several. They're
usually at the bottom, but scan the whole doc: a follow-up often lands
mid-thread, right under an earlier exchange.

The doc is normally the file in context (open or just-edited). If it's unclear
which file or which comment, ask rather than guess.

## Format

Keep the user's question in `>`; nest your reply one level deeper in `>>`. The
nesting renders as an inset quote, so Q and A separate at a glance with no extra
labels. Number turns so the newest round and the thread structure are obvious:

```markdown
> **Q2** an earlier topic — next integer
>
>> **A2** reply keeps full markdown: `code`, lists, [links] all work

> **Q2.1** a follow-up to Q2 — decimal, stays attached to its thread
>
>> <mark>**A2.1**</mark> your reply — the A marker is highlighted

> **Q3** the comment you're answering now
>
>> <mark>**A3**</mark> your reply
```

Three rules, each minimal:

- **Number** — new topic → next integer (`Q3`); follow-up to the latest thread →
  decimal (`Q2.1`). Judge from content: does the comment continue the previous
  exchange or open a new subject? Placement is a hint too — a comment sitting
  right under the last reply is usually a follow-up.
- **Highlight what's new this pass** — one `/discuss` can answer several comments
  at once. Wrap the `**A{n}**` marker of *every* reply you write this pass in
  `<mark>…</mark>`, and first strip the `<mark>` off the previous pass's replies.
  The yellow marks then always point at exactly what you just added — one reply
  or several — and fade next time. Highlight only the **A** marker: not the
  question (that's the user's own text), and not the whole reply block (a wall of
  yellow is hard to scan).
- **You keep the books** — the user writes a bare `> their comment`. You add the
  `**Q{n}**` marker, the number, and the `<mark>` on your `**A{n}**`. They
  shouldn't have to.

Don't reformat earlier turns — leave the discussion's history as-is and apply
this format to the round you're adding. If the doc already uses its own marker
words (e.g. `Comment N` / `→ Reply`), continue those for consistency, but still
add the number and move the `<mark>` so navigation works.

## Reply well

The format just makes your answers findable — the answer is the point, and your
own judgment carries it. Two steers, because they counter failure modes specific
to "replying to comments," not general knowledge:

- **Don't rubber-stamp.** Being asked to "reply to a comment" pulls toward
  agreement. If you disagree, push back with evidence — these comments are left
  to be challenged.
- **Verify, don't guess.** When the question is about the system, read the code
  or run it before you answer. A doc answer carries `file:line` weight, not
  chat-quick-take weight.


## Wrap-up

When the discussion has run its course and the user says `/discuss wrap up …`,
fold the outcome into the deliverable and clear the scaffolding — the Q/A was a
means to decisions, not part of the product.

- **Land the decisions in the main body.** Update the design (or code / skill) to
  reflect what the discussion settled, and make it self-contained: someone who
  never read the thread should get the full picture, rationale included.
- **Archive the thread, don't strip it silently.** Move the `>` / `>>` blocks
  verbatim to a `## Discussion Archive` under a `# Appendix`, creating both if
  they don't exist. If the discussion lives in a skill, code, or other
  deliverable rather than a design doc — where an appendix doesn't belong — ask
  the user whether to delete the blocks or move them to a separate file.