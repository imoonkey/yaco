# Security

Cross-cutting security controls for the workflow system.

## Owns

- Input validation rules for session names and file paths
- Origin validation for HTTP and WebSocket requests
- File access boundaries and write safety

## Does Not Own

- Authentication (none — single-user local app)
- Per-route authorization logic (see [backend/routes.md](backend/routes.md))

## Related Code

`server/src/index.ts`, `server/src/routes/files.ts`, `server/src/lib/scanner.ts`, `server/src/lib/session-names.ts`, `server/src/routes/git.ts`

## Session Name Validation

Session names must match `[a-zA-Z0-9_.-]+`. The regex is enforced at both the HTTP route layer and the WebSocket upgrade handler.

**Code path**: `server/src/lib/session-names.ts`, `server/src/index.ts`

## Path Traversal Protection

All file operations validate that the requested path (before symlink resolution) stays inside the project root, blocking `../../` traversal in request parameters. Symlinked directories within the project tree are allowed to point outside the project — only the request path is validated, not the resolved symlink target. This enables projects with symlinked `doc/` subdirectories while still preventing path injection.

**Code path**: `server/src/routes/files.ts` (`resolveAndValidate`)

## File Write Safety

Task writes are serialized by the `yaco task` store lock (`saveTaskStore`). Runtime event writes use append-only NDJSON (`eventsLog.appendEvent`) with per-file in-process serialization; there is no read-modify-write cycle against repo-local progress files.

The file content endpoint (`PUT /api/files/:project/content`) validates the target path but does not restrict by file extension.

**Code path**: `server/src/lib/eventsLog.ts`, `server/src/routes/files.ts`

## CORS and Origin Validation

The server validates the `Origin` header on both HTTP requests (via Hono CORS middleware) and WebSocket upgrades.

When `WORKFLOW_CORS_ORIGINS` is set, only those explicit origins are allowed. When unset, the server allows:

- `localhost` and `127.*` loopback addresses
- `::1` (IPv6 loopback)
- `.local` mDNS hostnames
- Private LAN ranges: `10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`
- Anything listed in `YACO_ALLOWED_HOSTNAMES`

No deployment-specific hostname is compiled in. To reach the app under a LAN or tailnet name, set `YACO_ALLOWED_HOSTNAMES` to a comma-separated list of hostnames; an entry with a leading dot allows the subdomains of a domain (`.example.ts.net` allows `desktop.example.ts.net`). The same variable and syntax widen the Vite dev server's `allowedHosts`, so one value configures both processes.

Two deliberate narrowings guard that syntax:

- A leading-dot entry must name a domain. A bare `.` is dropped with a warning, since it would otherwise match any hostname a browser writes with the DNS root dot (`evil.example.`) and open the allowlist to the public internet.
- A leading-dot entry does **not** allow the bare domain, only names under it. Vite is wider here and admits the domain itself; this guard cannot be, because the shipped `.local` default would then trust a single-label `local` origin nobody configured. The practical difference is that a UI served by the dev server at a bare domain would still fail the API and WebSocket origin checks.

**Code path**: `server/src/lib/origin.ts` (`createOriginGuard`), wired in `server/src/index.ts`

## Git Command Safety

Git operations use `execFileSync` / `spawnSync` with argument arrays (no shell interpolation). Command injection via file paths or branch names is not possible.

**Code path**: `server/src/routes/git.ts`
