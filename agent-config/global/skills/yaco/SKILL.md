---
name: yaco
description: Router for the YACO CLI surface. Points task-graph work to /yaco-task, agent lifecycle work to /yaco-agent, and project registry work to the CLI help topic. Use to pick the right detailed skill.
metadata:
  yaco-dependent: "true"
---

# yaco — CLI Surface Router

`yaco` is the dispatcher for the YACO stack. This skill is an index: it routes
you to the detailed operation manual for whatever you need to do. Reads and
inspection default to readable text on stdout; pass `--json` for mutations and
when you need to parse fields or branch on the `{ok,data}` / `{ok,error}`
discriminator — the detailed skills show the exact forms.

## Routing

- **Task graph** — reads and writes, worksets, dependencies, decomposition, and
  task-agent attach/detach. Use **`/yaco-task`**.

- **Agent lifecycle** — start, send, wait, list, status, whoami, session
  lineage, resume, and diagnostic capture. Use **`/yaco-agent`**.

- **Project registry** — list, add, remove, and move registered projects. There
  is no skill for this; run `yaco project --help` for the command surface.

## Notes

- Reads and inspection print text by default; `--json` is for mutations and
  parse/discriminator flows.
- This skill only routes. Task schema, agent command tables, verification
  policy, and project move details live in the skill or help topic each section
  points to.
