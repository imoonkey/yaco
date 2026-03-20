# Security

Cross-cutting security controls for the workflow system.

## Owns

- Input validation rules for session names and file paths
- Origin validation for HTTP and WebSocket requests
- File access boundaries and write safety

## Does Not Own

- Authentication (none — single-user local app)
- Per-route authorization logic (see [backend/routes.md](backend/routes.md))

## Session Name Validation

Session names must match `[a-zA-Z0-9_.-]+`. The regex is enforced at both the HTTP route layer and the WebSocket upgrade handler.

**Code path**: `server/src/lib/session-names.ts`, `server/src/index.ts`

## Path Traversal Protection

All file operations resolve paths via `realpath()` and verify the result stays inside the selected project root. Symlink targets are resolved before the boundary check, preventing symlink-based traversal.

**Code path**: `server/src/routes/files.ts`

## File Write Safety

Write operations use in-process file locks (`withFileLock` in scanner.ts) to prevent race conditions on concurrent read-modify-write cycles against `progress.json` and `workstream.json`.

The file content endpoint (`PUT /api/files/:project/content`) validates the target path but does not restrict by file extension.

**Code path**: `server/src/lib/scanner.ts`, `server/src/routes/files.ts`

## CORS and Origin Validation

The server validates the `Origin` header on both HTTP requests (via Hono CORS middleware) and WebSocket upgrades.

When `WORKFLOW_CORS_ORIGINS` is set, only those explicit origins are allowed. When unset, the server allows:

- `localhost` and `127.*` loopback addresses
- `::1` (IPv6 loopback)
- `.local` mDNS hostnames
- Private LAN ranges: `10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`
- Configured hostnames: `laptop`, `laptop.tailnet-example.ts.net`

**Code path**: `server/src/index.ts` (`isAllowedOrigin`, `isPrivateHostname`)

## Git Command Safety

Git operations use `execFileSync` / `spawnSync` with argument arrays (no shell interpolation). Command injection via file paths or branch names is not possible.

**Code path**: `server/src/routes/git.ts`
