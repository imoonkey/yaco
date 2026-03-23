# Workflow System

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state. No database.

## Owns

- Top-level system description and documentation map
- Navigation entrypoint for doc/main hierarchy

## Does Not Own

- Individual subsystem specs (see section pages)
- Implementation details (see source code)

## Related Code

`server/src/index.ts`, `ui/src/App.tsx`

## Architecture

```
Browser (React + Vite)
  Monitor  |  Workspace
     HTTP / WS / SSE
Hono Server (Node.js :3001)
  File System + tmux/multmux
```

The Hono backend can serve the built React app from `ui/dist`, so the app shell, API, WebSocket terminal, and SSE notifications share one origin on `:3001`.

## Documentation Map

| Section | Scope |
|---------|-------|
| [backend/](backend/) | Server setup, API routes, library modules |
| [data-model/](data-model/) | Entity shapes, API contracts, persistence boundaries |
| [frontend/](frontend/) | React components, hooks, state patterns |
| [ui/](ui/) | User-visible behavior specs and interaction contracts |
| [security.md](security.md) | Cross-cutting security controls |

## Related

- **Development guide**: [doc/dev/workflow.md](../dev/workflow.md)
