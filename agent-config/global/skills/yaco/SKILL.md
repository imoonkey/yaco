---
name: yaco
description: Router for the YACO CLI surface. Points task-graph work to /yaco-task, agent lifecycle work to /yaco-agent, and project registry work to the CLI help topic. Use to pick the right detailed skill.
metadata:
  yaco-dependent: "true"
---

# yaco — CLI Surface Router

`yaco` is the dispatcher for the YACO stack. This skill is an index: it routes
you to the operation manual for what you need. Each target owns its own command
forms, contracts, and `--json` policy.

## Routing

- **Task graph** — reads and writes, worksets, dependencies, decomposition, and
  task-agent attach/detach. Use **`/yaco-task`**.

- **Agent lifecycle** — start, send, wait, list, status, whoami, session
  lineage, resume, and diagnostic capture. Use **`/yaco-agent`**.

- **Project registry** — list, add, remove, and move registered projects. No
  skill; run `yaco project --help`.
