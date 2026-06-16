## 2026-06-15: Session-list starting-row alignment + placeholder/real dedup

**What changed:**
- "Starting" placeholder rows keep the pin button's layout box (rendered
  `invisible pointer-events-none`, click guarded) instead of omitting it, so the
  row no longer shifts left vs normal rows and a placeholder still can't be pinned.
- Killed the transient duplicate where a "Starting…" placeholder and the real
  session showed at once. The sessions-dir watcher surfaces the real session in
  the list the moment `yaco agent start` writes its state file — *before* the
  start POST resolves with the handle, so the placeholder can't be matched by
  name. A new `seenSessions`-diff effect retires a still-nameless placeholder when
  a session newly appears for the same provider.

**Why:**
- Follow-ups to the optimistic session-list work (friendly label + optimistic
  close, commit 183292a). The pin gate from that change caused the misalignment;
  the watcher-beats-POST race caused the double row.
- Codex review hardened the dedup: it now baselines only off a real (non-null)
  server snapshot and resets across project switches, so a first load / project
  change never reads existing sessions as "new" and wrongly consumes a
  placeholder. Correlation is provider-coarse by necessity (no shared id exists
  pre-POST) — worst case drops the optimistic row a beat early; the real start
  still lands correctly.

**Key files:** `app/ui/src/workspace/WorkspaceSessionList.tsx`, `app/ui/src/workspace/useWorkspaceSessions.ts`
**Verification:** `tsc -b` + `npm run lint` clean; full `vitest run src/` green (985/985, +2 dedup/baseline tests).
**Commit:** 3c09557
**Next:** Deferred — session row lingers ~3-4s after an in-terminal `/exit`. Measured: the yaco chain is *not* the bottleneck (state file removed + `GET /api/sessions` updated + `sessions` SSE pushed, all within ~1.2s of `/exit` for a light session). The delay is the agent process taking that long to fully exit (heavier real sessions). A real fix would have the `SessionEnd` hook (fires ~0.3s after `/exit`) *remove* the session instead of just flipping status to `idle` — but it needs reason-gating (Claude fires `SessionEnd` on `/clear` too, where the session continues), `reason` plumbed into the handler, codex parity, and a new "remove" outcome in the write-or-noop hook reducer (deletion is reserved for kill/reconcile today).
**Blockers:** None

## 2026-06-15: Session-list UX — friendly starting label + optimistic close

**What changed:**
- The optimistic placeholder row shown the instant you click "new session" no
  longer renders its synthetic `__starting__:<provider>:<n>` id as the name — it
  shows a friendly **"Starting…"** label and suppresses pin/kill/rename actions
  so the raw id can't leak (incl. through the rename input). Discriminated by the
  name prefix, not `status`, so a real server session reporting `starting` with a
  proper name still renders normally.
- Killing a session hides its row **immediately** instead of waiting out the
  ~1.4s cold `yaco agent kill` spawn that blocks `POST /:handle/close`. Hidden
  names live in a `closingNames` map filtered out of `orderedSessions`;
  visibility stays driven by the server list (the set only subtracts, so clearing
  is synchronized with the committed list — no reappear flash), a failed kill
  un-hides at once, and a TTL bounds any stuck/reused name.

**Why:**
- Investigation (two reported issues): the raw `__starting__:claude:0` text was
  internal coding, not user-friendly; and close felt laggy because the UI awaited
  the full blocking kill round-trip with no optimistic update.
- Codex review (two rounds) hardened the close path: reused-name-masked-forever
  (dropped name-absence inference), blind restore-on-failure, the
  superseded-refresh reappear flash (`usePolling` seq-guard drops our refresh when
  the kill's own SSE races it), and placeholder pin leakage.

**Key files:** `app/ui/src/workspace/WorkspaceSessionList.tsx`, `app/ui/src/workspace/useWorkspaceSessions.ts`
**Verification:** `tsc -b` + `npm run lint` clean; full `vitest run src/` green (978/978).
**Commit:** 183292a
**Next:** Server-side close is still a blocking ~1.4s CLI spawn — optional follow-up to make it non-blocking / bypass the cold `yaco` dispatch for faster real teardown.
**Blockers:** None

## 2026-06-14: Diff viewer syntax highlighting

Added per-line syntax highlighting to the diff viewer (`DiffTab`). New
`ui/src/lib/diffHighlight.ts` loads the editor's Lezer parsers by filename and
reuses the `editorHighlight` HighlightStyle, so diffs match editor colors;
`mergeSyntaxAndWord` layers the existing word-diff backgrounds under syntax
foreground (syntax = color, add/del = background tint). Per-line (GitHub-style)
because a diff only carries hunk fragments; plain-text fallback for unsupported
languages or before the async parser loads.

**Key files:** `ui/src/lib/diffHighlight.ts`, `ui/src/workspace/diff/DiffTab.tsx`
**Verification:** `tsc -b` + `npm run lint` clean; unit tests for `mergeSyntaxAndWord` + an integration test driving the real TS parser path; full `vitest run src/` green except a pre-existing tab-groups `PanelGroup.test.tsx` failure (unrelated, fails identically with this change reverted).
**Commit:** c0464d1

## 2026-06-11: Notification & attention redesign (v2)

Replaced the capped-50 notification inbox with a two-facet system: **Facet A**
live status dots (client-derived, now incl. a `crashed` dot/chip) and **Facet B**
attention — a server-side engine (`attention-engine.ts`) + pure projector
(`attention-projection.ts`) over `events.jsonl` + monotonic ack/clear watermarks,
pushed via an `attention` SSE event and consumed by a hidden-tab-safe
`useAttention` hook. Bell shows Needs-you/Ready/Recent; rollup badge is separate
from the self-only status dot. Deleted `notifications-store.ts`,
`useSessionUnreadState`, and the inbox role of `useNotifications`; kept
`/api/notifications/stream` as the SSE transport. Backed by a fail-closed CLI
crash contract (`crashed` runtime status + `yaco agent mark-crashed` + a
generation-scoped `.killing` sentinel) and durable `statusEnteredAt` /
`stateEnteredAt` edge generations. Full detail + verification in
`doc/PROGRESS.md` (2026-06-11).

## 2026-06-11: Voice single-take + unified compose tray

Reverted the bug-prone mid-recording VAD segmentation to a single-take flow
(native `MediaRecorder`, ended by Stop/F5; transcribe once → format → append),
dropped the ~13 MB neural VAD (`@ricky0123/vad-web` + `onnxruntime-web` + their
self-hosted assets), unified voice with the mobile paste bar into one
type/paste/record `ComposeTray`, switched send to ⌘/Ctrl+Enter (plain Enter =
newline; X/Esc-only close), and made Retry re-send cached audio. Full detail +
verification in `doc/PROGRESS.md` (2026-06-11).

## 2026-06-11: Hermetic, fast app/ui e2e — isolated static-build server

**What changed:**
- **Isolation by default (main checkout too).** `e2ePorts.ts` `resolveDevPorts({ e2e: true })` always returns hashed ports + an ephemeral `YACO_HOME` (`<tmpdir>/yaco-e2e-home/<slug>`, `slug=main` off a worktree). `playwright.config.ts` builds the UI (`vite build --outDir dist-e2e`) and boots ONE Hono server that serves the static build + `/api` + `/ws` on the API port — no vite-dev. `E2E_REUSE=1` opts back into the live dev server (5173/3001, real `~/.yaco`); `E2E_WORKERS`/`E2E_SKIP_BUILD` tune parallelism/build. `tests/e2e/preclean.mjs` wipes the home pre-boot (env-read path, prefix-validated); server reads `YACO_UI_DIST=dist-e2e` (new override) so it never clobbers `dist/`; channels forced off (`WHATSAPP/WECHAT_ENABLED=0`).
- **Every spec self-provisions.** Retired `openWorkspace`→`projects[0]`; migrated 12 specs to `provisionWorkspace`/`createFixtureProject` (+ `opts.files`/`opts.tasks`, new `createBrowseFixture`) selecting by name + `uniqueFileName`. `global-setup`/`global-teardown` + `helpers/cleanup.ts` sweep leftovers, gated on a `.yaco-e2e-fixture` marker so cleanup can never delete real data.
- **Server: watch runtime-registered projects.** `POST /api/projects` now calls `watchProject()` (and `DELETE` `unwatchProject()`), so a project added after boot gets live file-tree/git SSE — fixed a real gap (was only watching boot-time projects). `watchProject` installs the fs.watch synchronously (no add/remove race).

**Why:**
- The suite was slow (14–20 min), flaky under parallelism, and polluted the real `~/.yaco`/`yaco` repo (leaked `fixture-main-*` registry rows + orphan Chromes). Root causes fixed: shared real home → ephemeral home; vite-dev per-request compile contention under machine load → static build server; runtime projects unwatched → watch on register; channel Chromes orphaning → channels off in e2e.

**Key files:** `app/ui/{e2ePorts.ts,playwright.config.ts,vite.config.ts,.gitignore}`, `app/ui/tests/e2e/{helpers/workspace.ts,helpers/cleanup.ts,global-setup.ts,global-teardown.ts,preclean.mjs}` + 13 specs; `app/server/src/lib/project-watcher.ts`, `app/server/src/routes/projects.ts`, `app/server/src/index.ts`; docs `doc/dev/app/workflow.md`, `doc/main/app/backend/{server,routes}.md`.
**Verification:** full suite `npx playwright test` → exit 0, 138 passed / 0 failed / 3 skipped (~60s, under machine load); real `~/.yaco` byte-stable, zero `/tmp`/`~` leftovers. Server unit tests 129 pass; `npm run lint` clean. Reviewed by Codex twice (build-server pivot + fixes).
**Commit:** pending.
**Next:** voice specs are dev-only (fake MicVAD is `import.meta.env.DEV`-gated) — run via `E2E_REUSE=1`; consider a dedicated reuse-mode job to cover them.
**Blockers:** None.

## 2026-06-09: App server accepts `blocked` status, treats it as active (session-blocked-state 4/6)

**What changed:**
- `agent.ts`: `AgentSession.status` and `AgentSessionState.status` unions widened to include `blocked`; added optional `blockReason` (`permission | question | trust`, new exported `BlockReason` type) to both, and `blocked` added to `VALID_STATUSES`. `blockReason` threads through the shared `toSessionRow` projection, which only emits it when `status === 'blocked'` with a valid reason (a stray reason on a non-blocked status is dropped).
- `session-reconciler.ts`: `lastStatusBySession` retyped to `AgentSession['status']`. New `isActiveStatus()` (`processing || blocked`) gates idle detection — `blocked` now resets the idle streak exactly like `processing`, so `processing → blocked` never fires `session_idle`. Stale `MIN_PROCESSING_MS` comment corrected to say the timer covers active time (processing OR blocked).
- `session-summary.ts`: cached-label drop now fires on any active (`processing` or `blocked`) → `idle` transition, so `processing → blocked → idle` still refreshes the label instead of skipping it.

**Why:**
- The CLI now emits `blocked` (agent paused waiting on the user). For the app's "can I ignore this session?" question, `blocked` is the *opposite* of idle — without these changes a `processing → blocked` transition would start an idle streak and notify "session idle" for a session that actually needs the user, and a `blocked` interlude would swallow a stale-label refresh.

**Key files:** `app/server/src/lib/agent.ts`, `app/server/src/lib/session-reconciler.ts`, `app/server/src/lib/session-summary.ts`, plus tests in `app/server/src/lib/__tests__/{agent,session-reconciler,session-summary}.test.ts`; doc `doc/main/app/backend/libs.md`.
**Verification:** `cd app/server && npm test` passed (32 files, 439 tests; +12 new — blocked row read + stray-reason drop, reconciler `processing→blocked` emits no idle / blocked resets streak with a positive `processing→idle→idle` control, summary `processing→blocked→idle` refresh).
**Commit:** pending (central commit by orchestrator).
**Next:** UI `blocked` dot + reason badge + subtree-max bucketing (`ui-blocked-dot`, task 5/6).
**Blockers:** None.

## 2026-06-08: Terminal disables browser scrollback gutter for tmux sessions

**What changed:**
- `Terminal.tsx` now initializes xterm with `scrollback: 0` and skips internal scrollbar-width subtraction when scrollback is disabled.
- `fitTerminal()` now reserves one right-side cell as a DOM-renderer clip cushion and `index.css` sets xterm rows to `box-sizing: content-box` with matching right padding. This keeps xterm's inline row `overflow:hidden` while moving the horizontal clip edge one cell to the right.
- Codex prompt-frame overlays now use `.xterm-screen` width instead of `inset-x-0`, so the cyan rules stop at the terminal column area instead of extending across the right-side rounding remainder.
- Updated the terminal component test so an 800px / 10px-cell pane reports 79 columns: one cell is the explicit right clip cushion, and the hidden 14px xterm scrollbar is no longer counted.
- SOTA docs now state that embedded terminals attach to tmux and tmux owns scrollback/history.

**Why:**
- Workflow terminals are tmux attach clients, so xterm's browser-side scrollback gutter was permanently consuming ~14px, which is 1-2 columns at the current terminal font size. That made right-edge Codex/tmux content appear to drift into the blank gutter even though the visible scrollbar was not useful in normal use.
- The remaining right-edge clipping came from xterm v6's DOM renderer: each row has inline `overflow:hidden`, and the renderer's font/DPR rounding can clip the final glyph at the row edge. A one-cell cushion is the conservative trade-off: fewer right-edge columns, no final-glyph clipping.

**Key files:** `app/ui/src/components/Terminal.tsx`, `app/ui/src/index.css`, `app/ui/src/lib/codexInputPromptFrame.ts`, `app/ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`, `doc/main/app/ui/mobile.md`.
**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (29/29); `npx eslint src/components/Terminal.tsx src/lib/codexInputPromptFrame.ts src/components/__tests__/Terminal.focus.test.tsx` passed; `npx tsc --noEmit` passed; `npm run build` passed (existing Vite direct-eval / large-chunk warnings only); Playwright runtime probe against a temporary shell session measured parent width 1051px, screen width 1040px, row border-box width 1048px, row padding 8px, row `box-sizing: content-box`, and 3px right-side unused space after the expanded clip box.
**Commit:** pending.
**Next:** Manually check an attached Codex/tmux pane after reload to confirm the right edge uses the recovered columns without visible clipping.
**Blockers:** None.

## 2026-06-08: Self-host JetBrains Mono + line-height/weight tokens

**What changed:**
- **Mono delivered, not just named.** `--font-mono` was a wishlist stack (`'SF Mono','Fira Code','JetBrains Mono',…`) that hit nothing on most non-Mac machines → fell back to bare `monospace` (DejaVu). Self-hosted JetBrains Mono via `@fontsource/jetbrains-mono` (weights 400/500/600/700 imported in `main.tsx`, woff2 bundled by Vite — local-first, no CDN).
- **Mono is platform-split (follow-up fix).** Putting the now-loaded `'JetBrains Mono'` ahead of `ui-monospace` stole SF Mono from Mac (SF Mono only resolves via `ui-monospace` on the web — system-restricted, unmatchable by name, can't be self-hosted). Final: CSS default `'JetBrains Mono', ui-monospace, monospace` (non-Mac); an early `index.html` inline script overrides `--font-mono` to `ui-monospace, 'SF Mono', monospace` on Apple platforms. **All mono now flows through `var(--font-mono)`** — incl. the CodeMirror editor (`editorTheme.ts` had hardcoded its own stack, the biggest miss) and xterm (`Terminal.tsx` reads the resolved value at init). No hardcoded mono stack remains.
- **Line-height rhythm tokens.** Added `--lh-tight: 1.3` / `--lh-normal: 1.5`, applied only to the ~6 genuinely multi-line spots (compose transcript/textarea, diff content, graph tooltip). `lineHeight: 1` geometry, xterm, and CodeMirror editor metrics left alone (no blanket apply).
- **Weight vocabulary unified.** All inline `fontWeight: <number>` → Tailwind `font-*` classes (search highlights, diff toolbar, tooltip, compose tray). SVG `<text>` weight attrs left (presentation attribute).

**Why:**
- Holistic typography critique: the size scale was already coherent, but (a) mono wasn't actually being delivered off-Mac, and (b) line-height and weight were the remaining "dual-track / no-system" gaps. These were the highest-value polish after the token migration.
- Delivered via 3 parallel subagents on disjoint scopes (mono / components+hooks / workspace+tasks); the platform-split + editor-token issues were caught in follow-up review.

**Key files:** `app/ui/src/index.css`, `app/ui/index.html`, `app/ui/src/main.tsx`, `app/ui/package.json`, `app/ui/src/lib/editorTheme.ts`, `app/ui/src/components/{ComposeTray,Terminal}.tsx`, `app/ui/src/workspace/{diff/DiffTab,RefSearchDropdown,WorkspaceSearch,WorkspaceTextSearch}.tsx`, `app/ui/src/tasks/{TaskGraphTooltip,shared/InlineEdit}.tsx`, `app/ui/src/hooks/useNotifications.ts`.
**Verification:** vite build clean; lint 0 errors; token e2e + JetBrains-Mono-load + platform-split (Mac/non-Mac `--font-mono`) e2e probes all pass.
**Commit:** `9f73d92`, docs `e609948`, Mac platform-split `303e7ed`, editor-token `4d6e540` (+ this docs commit).
**Next:** Optional — collapse the size scale to a tighter 5–6 steps (now a one-line token edit); `tabular-nums` pass; optionally self-host Instrument Sans (still on Google Fonts CDN).
**Blockers:** None.

## 2026-06-08: Typography font-size token scale (`--text-ui-*`)

**What changed:**
- Added a single font-size token scale to `index.css` as `@theme static { --text-ui-2xs..2xl }` (9/10/11/12/13/14/16px). `static` forces all seven to emit to `:root` so the inline `var()` path works regardless of whether a matching utility class exists.
- Migrated every raw font size onto it: ~190 `text-[Npx]` Tailwind classes → `text-ui-*` (31 files); ~49 inline `fontSize` / CSS `font-size` / CodeMirror theme (`editorTheme.ts`) / DOM `.style.fontSize` (`diffGutter.ts`) / Mermaid-error HTML string → `var(--text-ui-*)`.
- Routed the task-graph SVG/canvas typography through a new `tasks/graphType.ts` constants module — a deliberate second source, because canvas `ctx.font` parses a string itself and can't read CSS `var()`. `RAIL_CHAR_W` is now derived from `RAIL_FONT_SIZE` so a font edit can't desync rail width math.
- Kept documented literals: xterm (canvas), the 24px empty-state emoji glyph, the 8px ASCII-QR `<pre>` (geometry), `fontSize:inherit`, and relative-`em` sizes (markdown, `useNotifications` `0.875em`).
- Added a Playwright runtime proof (`tests/e2e/typography-tokens.spec.ts`): all 7 tokens resolve to exact px in light **and** dark; body computes to 13px (not the 16px UA default → vars resolve). Added a `--text-ui-*` guardrail rule to `app/CLAUDE.md`.

**Why:**
- Typography was the one design dimension with no tokens (colors/elevation/transitions all had them): 9 ad-hoc sizes expressed two ways (`text-[Npx]` classes + inline `fontSize`), with no single lever. Exact-value tokenization first (zero-pixel) makes future *visual* consolidation (e.g. merging 11/12/13) a one-line token edit instead of a ~190-site hunt. Consolidation, `tabular-nums`, and line-height systematization are deferred follow-ups.
- Mechanism chosen (custom-namespaced `@theme static`, not arbitrary `text-(length:…)` and not default `text-sm`): default names inject a paired line-height that would shift dense fixed-height rows; a custom token compiles to font-size only while still giving short class names and inline `var()` from one declaration.

**Key files:** `app/ui/src/index.css`, `app/ui/src/tasks/graphType.ts`, `app/ui/src/lib/{editorTheme,diffGutter}.ts`, ~40 `.tsx` across `components/workspace/tasks/`, `app/ui/tests/e2e/typography-tokens.spec.ts`, `app/CLAUDE.md`.
**Verification:** `npm run lint` → 0 errors (pre-existing warnings only); `npx vite build` → success; Playwright token test → 2 passed (re-run independently). Final grep: no raw px `text-[Npx]` / inline `fontSize` / CSS `font-size` outside documented exclusions.
**Commit:** `a46e861..5b4c921` (+ `070486b` CLAUDE.md, + this docs commit). Design + 2 Codex review rounds: `1113012`; task graph: `def8a96`.
**Next:** Deferred — `tabular-nums` alignment pass; visual consolidation to a tighter 5–6 step scale; line-height tokens.
**Blockers:** None.

## 2026-06-07: Merge messaging-channel header buttons into one logo dropdown

**What changed:**
- Collapsed the separate `WeChatHeaderButton` + `WhatsAppHeaderButton` into a single `ChannelsHeaderButton` (in `WeChatLoginDialog.tsx`): a bare lucide `MessagesSquare` trigger (cloned from the `NotificationBell` styling) that opens a `DialogShell` panel-mode dropdown listing each `*_ENABLED=1` channel. Picking a row opens that channel's unchanged `ChannelLoginDialog`. Per-row + trigger green/dim dot preserves the at-a-glance login signal. Env-gate behavior unchanged (renders nothing until ≥1 channel enabled).
- Added `BrandIcons.tsx` — real WeChat/WhatsApp brand glyphs (inlined single-path Simple Icons, CC0, `fill="currentColor"`), replacing the generic lucide `MessageCircle`/`MessageSquare` bubbles in the channel rows. No new dependency.
- Unified idle header-icon color on `--sol-text-dim` (bell, channel trigger, date now match) and dropped the per-button border boxes; theme-toggle accent colors preserved.

**Why:**
- The two bordered chat buttons used `--sol-text` (a darker tier than the adjacent bell's `--sol-text-dim`) and the generic bubbles weren't the real brand marks, so the header row read as inconsistent. One dropdown + real logos + a single idle color tier fixes both.

**Key files:** `app/ui/src/components/{WeChatLoginDialog,BrandIcons}.tsx`, `app/ui/src/App.tsx`.
**Verification:** `cd app/ui && npx tsc --noEmit` → clean; `npm run lint` → 0 errors (pre-existing warnings only).
**Commit:** 3bb2689 (+ this docs commit)
**Blockers:** None.

## 2026-06-07: UI text-color scale collapse + contrast-audit AA pass

**What changed:**
- Reworked the Solarized semantic text scale into a **two-tier system** for non-primary text: `--sol-text` ("you read this") and `--sol-text-faint` ("ambient companion"). Removed `--sol-text-secondary` entirely — it resolved to the same `#586e75` as `--sol-text` in light, a redundant middle tier; all ~76 usages folded into `text` (must-read: empty states, dialog bodies/hints, status, section labels, inactive controls, control icons) or `text-faint` (paths, timestamps, counts, nav glyphs, tab suffixes, detail-panel meta, chart ticks, gitignored filenames, placeholders).
- Added tokens (theme-split, registered under `@theme`): `--sol-text-faint` (light `#889392` / dark `#6a8088`), `--sol-text-disabled` (light `#93a1a1` / dark `#506872`). Applied the disabled token to VoiceControl + ComposeTray's opacity-only disabled states and standardized `cursor: default`.
- Resolved the catalogued contrast-audit AA failures: empty-state lines, dialog bodies, section/uppercase labels, and other must-read text raised to `--sol-text` (AA in both themes).
- Sidebar primary/secondary hierarchy now driven by **font-weight** — session/history names get `font-medium` (matching Projects/file-tree) so Changes/Sessions no longer read heavier than Projects; companions recede via `text-faint`.
- `SectionHeader`: replaced the warm list-selection hover (`--sol-hover-bg`, a bright yellow band across the full bar — regressed in a764c91) with a neutral header-bg darken/lighten via a new `.section-header-bar` class.
- Spawn-action buttons (New Claude/Codex/Shell): dropped the `opacity-80` ghost look for neutral icons that lift to an accent tint on hover (`.spawn-btn`).
- gitignored filenames → `text-faint` (the de-emphasis token); breadcrumb leaf → `text-dark`, trail → `text`; tokenized duplicated git tints and `#fff` → `--sol-base3` in WorkspaceSearch.

**Why:**
- The machine-generated [contrast-audit](../../plan/all/frontend-improve/contrast-audit.md) flagged 41 AA failures (the `--sol-muted` body-text family). A prior pass added `--sol-text-secondary`, but in light it equals `--sol-text`, so it was an invisible middle tier that flattened hierarchy. Collapsing to a clean two-tier scale + weight-based hierarchy fixes both the AA floor and the visual consistency (Changes/Sessions vs Projects) without darkening primaries.

**Key files:** `app/ui/src/index.css` (tokens, `.spawn-btn`, `.section-header-bar`), `app/ui/src/{workspace,components,tasks}/**` (~30 files), `doc/main/app/ui/design-system.md`.
**Verification:** `cd app/ui && npx tsc -b` → clean; `npm run lint` → 0 errors (13 pre-existing warnings); `npx vitest run src/` → 209 pass; spot-measured representative fixes in both themes via Playwright against resolved backgrounds; visually reviewed sidebar/tasks/dialogs in light + dark.
**Commit:** fc0a436 (+ this docs commit)
**Blockers:** None.

## 2026-06-06: Pseudo-Gantt task workspace mode (replaces DAG)

**What changed:**
- Added a second task workspace layout mode, `gantt`, beside `stacked`. It renders the task graph as an optimistic execution schedule: x = synthetic units derived from `estimate`, bars positioned by `depends` (earliest start), finish-to-start links, critical-path highlight. DAG mode is dropped — the two shipped modes are now Stacked (daily scan) and Pseudo-Gantt (execution-flow / critical-path).
- `ganttSchedule.ts` (new, pure CPM, unit-tested) — duration map `xs/s/m/l/xl=1/2/3/5/8`, missing estimate → `m` (`assumed`); internal effective-predecessor graph `E` (ancestor-inherited, group-expanded, self-edges stripped, view-local to the filter-visible leaf set); Kahn topo on `E` flags effective cycles; forward/backward passes give integer-exact `slack`/`critical`; group rows get summary entries.
- `taskGraphModel.ts` — extracted shared `layoutRows()` used by both modes (no duplicated tree code); added `computeGanttLayout()` returning `GanttLayout extends GraphLayout` (carries nodes/groups/edges/visibleOrder so selection/keyboard/search/collapse work unchanged) with `bars`, `ruler`, depth-derived `leftWidth`, `timeWidth`. `GanttBar` carries `assumed`/`critical`/`cycle`/`isSummary`.
- `TaskGanttCanvas.tsx` / `TaskGanttRuler.tsx` / `TaskGanttBar.tsx` (new) — two-pane sticky spreadsheet: frozen left task column (reuses TaskGraphNode/Group) + horizontally-scrollable time pane (sticky ruler, FS edges, bars, gridlines), one `scale()` transform per pane. Bar visuals: state colors, shared-`<pattern>` assumed hatch, accent critical outline, thin end-capped summary spans, red cycle bars. Selection reuses `computeHighlight` + keeps the critical chain prominent; hover/click reuse the node tooltip/select handlers (tooltip offset by `leftWidth` + `RULER_HEIGHT`).
- `useTaskGraphInteraction.ts` (`'stacked' | 'gantt'`, stale → stacked), `TaskGraphToolbar.tsx` (enabled Gantt button, desktop-only), `TaskGraphScreen.tsx` (branches on `ix.layout`, forces stacked on mobile), `taskGraphConstants.ts` (`PX_PER_UNIT`, `LEFT_COL_PAD`, `MIN_BAR`, bar-visual constants).

**Key files:** `app/ui/src/tasks/{ganttSchedule,taskGraphModel,taskGraphConstants,TaskGanttCanvas,TaskGanttRuler,TaskGanttBar,TaskGraphScreen,TaskGraphToolbar,useTaskGraphInteraction}.{ts,tsx}`, `app/ui/tests/e2e/task-graph.spec.ts`, `doc/main/app/frontend/{components,hooks}.md`
**Verification:** `cd app/ui && npm run lint` → 0 errors (13 pre-existing warnings); `npm run build` (`tsc -b && vite build`) → clean; `npx vitest run` (ganttSchedule + taskGraphModel) pass, incl. a cycle-bar test asserting `cycle:true` / non-critical; Playwright `task-graph.spec.ts` covers mode switch + persist, frozen column/ruler, zoom no-drift, assumed hatch, only-real-`depends` edges, filter/collapse/select/search in Gantt.
**Commit:** d99887d..c9eb0aa (+ this docs commit)
**Blockers:** None.

## 2026-06-06: Task graph rows fill container width (ResizeObserver lifecycle fix)

**What changed:**
- `TaskGraphScreen.tsx` — the `ResizeObserver` measuring the scroll container's `clientWidth` (the `containerWidth` input to `computeDisplayLayout`) is now bound through a **callback ref** (`attachScrollRef`) instead of an empty-dep mount effect. The callback keeps `scrollRef.current` in sync, (re)binds the observer on every mount, and disconnects + nulls the stored observer on teardown.

**Why:**
- The old `useEffect(..., [])` ran once on first mount while `status === 'loading'`, when the scroll div isn't rendered (loading pane shown). It returned early on the null ref and never re-ran after the graph mounted, so `containerWidth` stayed 0 — collapsing every stacked row to the `NODE_WIDTH` (280px) floor regardless of available width, with no reflow on resize. The callback ref binds whenever the div actually mounts (incl. the loading→ready transition). Nulling the observer ref on the null/teardown path prevents a disconnected observer (closing over the old `el`/SVG subtree) being retained across ready→missing/error.

**Key files:** `app/ui/src/tasks/TaskGraphScreen.tsx`, `doc/main/app/frontend/components.md`
**Verification:** Reproduced in-browser via Playwright (yaco project, 28 tasks): before — roots 280px at 913px viewport; after — roots 821px / children 797px sharing the right edge at 957px container, reflowing to 414px / 390px at 550px container, svg width == container width (no horizontal overflow). `npx tsc --noEmit` exit 0; `cd app/ui && npm run lint` 0 errors (13 pre-existing warnings); `npm run build` ✓.
**Commit:** 466cdae (+ this docs commit)
**Blockers:** None.

## 2026-06-05: app/ui ESLint baseline cleanup (React Compiler hook rules)

**What changed:**
- Cleared all 82 package-wide ESLint errors in `app/ui` so `npm run lint` exits clean (13 pre-existing warnings unchanged). 68 came from the React Compiler ruleset that `eslint-plugin-react-hooks@7` `flat.recommended` enables.
- **`refs` (45):** "latest-ref" writes (`ref.current = x` during render) → `useEffect(() => { ref.current = x })`. `useFileState` dirty/conflict Sets now key on a sorted content signature instead of `prevDirtyRef`/`prevConflictRef` structural comparison (same stable-identity behavior, no render-phase ref reads). `usePanZoom` takes `{ graphBoundsRef }` and reads bounds lazily in `fitToView`. `useWorkspaceState` run-once `bindSnapshots` → mount effect (also fixed the lone `purity` error — the `Date.now()` closure is now built in an effect). `useTaskGraphInteraction` exposes `clearPendingPan()` (fixes the `immutability` error from mutating a frozen hook return).
- **`set-state-in-effect` (20):** reset/sync-on-prop-change effects → "adjust state during render" with a state prev-tracker (`InlineEdit`, `DiffTab`, `WorkspaceScreen`, `ComposeTray`, `useWorkspaceVoice`, `App` project order); `useVoice` capability check → lazy `useState` initializer. Remaining 12 are hand-rolled data-fetching / coupled-timing effects kept as effects behind narrow, commented `eslint-disable` (state set after `await`).
- **`immutability` (2):** `Editor.tsx` programmatic-update suppression flag replaced with a CodeMirror transaction `Annotation`.
- **`react-refresh` (4):** extracted `fileGitColors.ts`, `explorerContext.ts`, `useContextMenu.ts` from component files and rewired importers.
- **Config/misc:** added the standard `^_` ignore patterns to `no-unused-vars` (honors the existing `_`-prefix intentional-unused convention; rule still flags real unused vars). Typed two e2e `any` casts, removed dead test helpers.

**Why:**
- Critical unblocker: the provider UI config work (commit 38c8718) and downstream provider-adapter app review/QA tasks could not satisfy their literal `cd app/ui && npm run lint` acceptance gate because of this pre-existing debt. Fixes are behavioral/scoped — no broad rule disable, no package-level lint relaxation. The worktree state (`App` + `useProjectWorktrees`) was deliberately left on original effect timing (cross-hook-coupled with the async worktree list, untested) rather than risk a restore-on-switch regression.

**Key files:** `app/ui/eslint.config.js`, `app/ui/src/hooks/{useFileState,useWorkspaceState,usePanZoom,useVoice,useApi,...}.ts`, `app/ui/src/components/{Editor,Menu,fileExplorer*,fileGitColors,explorerContext,useContextMenu}.tsx?`, `app/ui/src/{App,workspace/*,tasks/*}.tsx`, `doc/main/app/frontend/hooks.md`
**Verification:** `cd app/ui && npm run lint` → 0 errors; `npm run build` → exit 0; `npx vitest run src/components/__tests__/Terminal.focus.test.tsx` → 8/8. Full unit suite: 121 pass, 2 fail (pre-existing `TerminalKeyBar.test.tsx`, confirmed failing on a clean tree — unrelated).
**Commit:** working tree — task `tui-ui-lint-baseline-cleanup`, not yet committed (parent task is no-commit).
**Next:** unblocks `tui-ui-provider-config` and downstream provider-adapter app review/QA tasks to satisfy their lint gate.
**Blockers:** None.

## 2026-06-05: Mobile keyboard gap, input-focus zoom, terminal key bar visibility

**What changed:**
- `useKeyboardViewport.ts` — scoped the iOS keyboard-height estimate to `.xterm` taps only. The editor's `contenteditable` previously matched the input check and triggered the terminal-oriented estimate, over-shrinking `#root` and leaving an editor-bg gap above the keyboard.
- `index.html` — added `maximum-scale=1.0` to the viewport meta, suppressing iOS auto-zoom on input focus across the whole page (incl. the 13px CodeMirror contenteditable that the form-input rule never covered). `index.css` — removed the now-redundant `input,textarea,select { font-size:16px }` hack, restoring dense form fonts.
- `TerminalKeyBar.tsx` — converted Tailwind v4 bracket-var classes (`bg-[--sol-x]`) to the paren shorthand (`bg-(--sol-x)`). In v4 the bracket form emits unwrapped, invalid CSS, so the copy/paste Send button had no background (white text invisible on the light bg) and the keys lost their subtle backgrounds.

**Why:**
- Three mobile regressions on the phone IDE: the editor keyboard left a colored gap, focusing inputs zoomed the dense layout, and the terminal Send button was invisible in light mode. The Tailwind issue was a silent v4 behavior change — brackets no longer auto-wrap CSS vars in `var()`; documented as a pitfall in `design-system.md`.

**Key files:** `app/ui/src/hooks/useKeyboardViewport.ts`, `app/ui/index.html`, `app/ui/src/index.css`, `app/ui/src/components/TerminalKeyBar.tsx`, `doc/main/app/ui/mobile.md`, `doc/main/app/ui/design-system.md`, `doc/main/app/frontend/hooks.md`
**Verification:** `cd app/ui && npx vite build` passes; compiled CSS confirmed `bg-(--sol-accent)` → `background-color:var(--sol-accent)` with no remaining invalid `:--sol-` rules; `eslint` clean on changed files. On-device visual confirmation pending.
**Commit:** 98d5ff8..4df16cb (+ this docs commit)
**Blockers:** None.

## 2026-06-05: Voice streaming e2e + manual VAD checklist (vs-tests)

**What changed:** `app/ui/tests/e2e/voice-compose-backup.spec.ts` now stubs
`/api/voice/transcribe` + `/api/voice/format` and drives the real
VoiceControl/ComposeTray path with a dev-only fake MicVAD seam. Insert and
Discard still verify the clipboard backup. Added
`plan/archive/20260605_voice-streaming/manual_vad_checklist.md` for Chrome desktop and
phone-over-Tailscale VAD checks.

**Verification:** `cd app/ui && npx playwright test voice` -> 2 passed.
**Next:** final orchestrator verification and task closure.
**Blockers:** None.

## 2026-06-04: Voice streaming hook orchestration (vs-hook)

**What changed:**
- `app/ui/src/hooks/useVoice.ts` — rewritten to orchestrate the streaming path end to end on top of `voiceVad.ts` (capture), `voiceStateMachine.ts` (reducer), and the split `/transcribe` + `/format` routes. Replaces the old MediaRecorder + single `/compose` flow; greens the staged red build that `vs-vad-module`/`vs-state-machine`/`vs-tray-live` left behind.
- **`start(ctx)`** computes `runId` up front (mirrors the reducer's `counter + 1`), dispatches `START`, opens `startVadSession(maxUploadBytes, { onElapsed, onChunk, onError })`, and resolves to `PERMISSION_GRANTED` only if the live phase is still `requesting_permission` with the same `runId` and the hook is mounted (else `release()`s the orphan). Rejection → `PERMISSION_DENIED`, same guard.
- **Per chunk:** `SEGMENT_PENDING` → `POST /transcribe` (`fetchWithTimeout`, 30 s abort) → `SEGMENT_RESOLVED` carrying `index` + `text` + `runId`; a timeout/failure resolves the segment to `''` (drops only that chunk).
- **Client rate control** (`waitForTranscribeSlot`): rolling 60 s window caps `/transcribe` at 20 req (belt-and-suspenders over the coalescer's ~6/min floor); a shared `retryAfterUntilRef` deadline holds all pending chunks back. On a 429, `postTranscribe` reads the forwarded `retry-after` header (`parseRetryAfterMs`, seconds or HTTP date), waits, and retries once.
- **Stop → finalize:** `stop()` dispatches `STOP`, `await session.stop()` (flushes tail), `VAD_STOPPED`, then `release()`s. A finalize effect reads `selectFinalization` off the live `active` phase and fires exactly one of `NO_SPEECH` / `FAIL` / (`START_FORMAT` + one `POST /format`) — the gate is an effect (not inline) because the last chunk can resolve after `VAD_STOPPED`; `formattingRunRef` guards `/format` to once per run. A second effect calls `stop()` at `MAX_RECORDING_SECONDS`. Unmount effect releases the live session.
- `app/server/src/routes/voice.ts` — `mapUpstreamError` + `/transcribe` now forward the upstream Groq `retry-after` header on a 429 so the hook's back-off is precise.
- `app/ui/src/hooks/__tests__/useVoice.test.tsx` (new) — drives the hook with a fake VAD session + mocked `fetch`: happy path, 429 + `retry-after` retry, all-chunks-dropped → `failed`, unmount cleanup.

**Why:**
- The integrating slice of `voice-streaming`. The four sibling tasks each left a deliberate red build against the old `useVoice.ts`; this rewrite adopts every consumer contract (VAD session, `runId`-tagged segment events, derived finalize gate, single `/format`) and turns the streaming pipeline on. Client-side throttle + server-forwarded `retry-after` make staying under Groq's free-tier RPM wall structural rather than best-effort.

**Key files:** `app/ui/src/hooks/useVoice.ts`, `app/ui/src/hooks/__tests__/useVoice.test.tsx`, `app/server/src/routes/voice.ts`, `plan/archive/20260605_voice-streaming/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run useVoice voiceStateMachine src/hooks/__tests__/voiceVad.test.ts` → 39 passed; `cd app/ui && npm run build` passes (staged red build now green); `cd app/server && npm test` passes.
**Commit:** docs only this pass; the hook + route changes are part of the in-flight `voice-streaming` bundle (uncommitted, pending orchestrator review).
**Next:** `vs-tests` — e2e + manual VAD checklist over the now-complete pipeline.
**Blockers:** None.

## 2026-06-04: VAD-driven voice capture with chunk coalescing (vs-vad-module)

**What changed:**
- `app/ui/src/hooks/voiceVad.ts` (new) — replaces the MediaRecorder module `voiceRecording.ts` (removed). `startVadSession(maxBytes, callbacks, load?)` wraps `@ricky0123/vad-web`'s `MicVAD.new({ model: 'v5', baseAssetPath/onnxWASMBasePath: __VAD_ASSET_BASE__, processorType: 'AudioWorklet', submitUserSpeechOnPause: true, redemptionMs: 1400, minSpeechMs: 400 })` behind a lazy `import('@ricky0123/vad-web')` (keeps vad-web + onnxruntime-web out of the main bundle; `startOnLoad` auto-starts).
- **`VadCoalescer` (pure, exported, no timers/MicVAD).** Buffers VAD utterances (`onSpeechEnd` Float32Array) and emits a coalesced PCM16-mono WAV via `onChunk(wav, index)` on three triggers: **size** (`CHUNK_TARGET_SECONDS = 10`, or the server byte cap `maxBytes`, whichever is smaller); **end-of-thought pause** (`PAUSE_FLUSH_MS = 1000` after an utterance, **rate-gated** until `MIN_FLUSH_INTERVAL_MS = 10_000` clears, then re-armed for exactly the remaining wait); **final** (`flushRemainder()` at Stop, ungated). The rate floor caps requests at ~6/min so transcription stays under Groq's ~20 RPM free tier.
- **Lifecycle guards.** Owns `getStream` so it can stop a mic stream `MicVAD.new()` leaks when it throws after acquiring the mic (vad-web returns no handle); on init failure stops the stream + closes the `AudioContext`, then rethrows. `stop()` is async — `vad.pause()` flushes the in-progress utterance (`submitUserSpeechOnPause`) then `flushRemainder()` emits the tail before resolving, so the caller's finalize gate sees every chunk. `release()` is idempotent and safe after a failed init. `stopping`/`released` flags drop late `onSpeechEnd` (destroy can fire one) and cancel the pause timer; `onSpeechStart` cancels a pending end-of-thought flush.
- `MAX_RECORDING_SECONDS = 300` is reported via `onElapsed(ms)` (1s tick); the cap is enforced by the consuming hook calling `stop()`. `checkBrowserCapability()` (secure context + `getUserMedia` + `AudioWorklet`) and `encodeWav()` (PCM16 mono @ 16 kHz) carried over from `voiceRecording.ts`.
- `app/ui/src/hooks/__tests__/voiceVad.test.ts` (new) — 12 tests: WAV encode, coalescer size/rate-gate/final/byte-cap flushes, and `startVadSession` lifecycle (pause-flush-before-stop, late-callback-after-release ignored, mic stopped when init fails) via an injected fake MicVAD module.

**Why:**
- One slice of the `voice-streaming` project. VAD replaces fixed-interval MediaRecorder chunking so silence costs nothing and the formatter runs once over a clean transcript. Coalescing utterances into ~10s WAVs (instead of one request per pause) is what keeps the streaming path under Groq's free-tier RPM wall — the rate floor makes that structural rather than best-effort. The coalescer is split out as a pure class so the flush logic is unit-tested without a real worklet/mic.

**Key files:** `app/ui/src/hooks/voiceVad.ts`, `app/ui/src/hooks/__tests__/voiceVad.test.ts` (removed: `app/ui/src/hooks/voiceRecording.ts`), `plan/archive/20260605_voice-streaming/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run src/hooks/__tests__/voiceVad.test.ts voiceStateMachine` → 34 passed (12 + 22). Full `cd app/ui && npm run build` still fails **only** in `useVoice.ts` (still imports the removed `voiceRecording.ts` and posts `/compose`) — owned by `vs-hook`.
**Commit:** docs only this pass; module is part of the in-flight `voice-streaming` working tree.
**Next:** `vs-hook` adopts the `startVadSession` contract in `useVoice.ts` (per-chunk `/transcribe`, `runId`-tagged segment events, cap via `onElapsed`); build greens once it lands.
**Blockers:** None (the red `useVoice.ts` build is the expected staged-migration state).

## 2026-06-04: Voice tray live transcript + frozen target (vs-tray-live)

**What changed:**
- `app/ui/src/components/ComposeTray.tsx` — replaced the bare timer / processing-spinner blocks with one **active panel**: a growing live-transcript area (auto-scrolled to the latest line; `Listening…` placeholder when empty) + `mm:ss` timer + a **pending indicator** (spinner + count when `pendingCount > 0`) + Stop. `isActive` now keys off `active | composing | recoverable | error`. The header surface toggle (button + `Tab` handler) is removed → a static `Voice → Terminal/Editor` label. Compose / error / recoverable bodies unchanged.
- `app/ui/src/workspace/useWorkspaceVoice.ts` — **froze the insertion target per run.** `handleVoiceConfirm` now routes by the run's `voice.target` (matching `filePath`/`sessionName`), not the mutable `voiceSurface`, so editor-captured audio can't land in the terminal. Dropped `handleSurfaceToggle`; `voiceSurface` is kept only as a display mirror of `voice.target.surface`.
- `app/ui/src/components/VoiceControl.tsx` — `resolveVisualState`: `active → recording`, `requesting_permission → processing`; dropped the dead `transcribing`/`formatting` cases.
- Wiring: `useVoice.ts` exposes `liveTranscript`/`pendingCount` (via the existing `selectLiveTranscript`/`selectPendingCount` selectors) as the tray's contract; `WorkspaceScreen.tsx` passes them and drops `onSurfaceToggle`; `useWorkspaceKeyboard.ts` toggles on `state === 'active'` (was `'recording'`).

**Why:**
- Adopts `vs-state-machine`'s single `active` phase so the tray shows a Typeless-style growing transcript instead of a stop-and-wait spinner. Freezing the target closes a real bug: the old tray let you re-target surface mid-capture, so audio captured for the editor could be inserted into the terminal.

**Key files:** `app/ui/src/components/ComposeTray.tsx`, `app/ui/src/components/VoiceControl.tsx`, `app/ui/src/workspace/useWorkspaceVoice.ts`, `app/ui/src/hooks/useVoice.ts`, `app/ui/src/workspace/{WorkspaceScreen,useWorkspaceKeyboard}.ts`
**Verification:** `cd app/ui && npm run build` — all in-scope + wired files type-check; the only remaining `tsc -b` errors are in `useVoice.ts` and are exclusively `vs-hook`'s (removed `./voiceRecording`, dropped `TOO_SHORT`, `runId`-less permission dispatches). `npx vitest run voiceStateMachine` → 22 pass; ESLint adds no new errors.
**Commit:** docs only this pass; UI changes are part of the in-flight `voice-streaming` bundle (uncommitted, pending orchestrator review).
**Next:** `vs-hook` migrates `useVoice.ts` (VAD orchestration, per-chunk `/transcribe`, single `/format` at Stop, drop `TOO_SHORT`, pass `runId`). Build greens once it lands.
**Blockers:** None for this task; the red `tsc -b` is owned by `vs-hook`.

## 2026-06-04: Split voice `/compose` → `/transcribe` + `/format` (vs-server-split)

**What changed:**
- `app/server/src/routes/voice.ts` — replaced `POST /api/voice/compose` with two single-responsibility endpoints:
  - `POST /transcribe` (multipart, Whisper only) → `{ text }`. Re-creates compose's guarantees: 503 (no key), 400 (bad form / non-File audio / non-string `language`\|`context`), 413 (>20 MB), Groq 429→429 / else→502. Adds a real **audio-format allowlist** (`isAllowedAudio`): MIME-whitelisted, falling back to file extension only when the part is typeless / `application/octet-stream`. New optional `context` field flows to `buildWhisperPrompt`.
  - `POST /format` (JSON `{ text, surface, filePath? }`, formatter only) → `{ displayText, formattingStatus, warning? }`. Caps `text` at `VOICE_MAX_TRANSCRIPT_CHARS` (413) and short-circuits blank text to `{ formattingStatus: 'empty' }` — both **before any model call**. `filePath` is hardened as opaque path data via `normalizeSafeFilePath` (rejects absolute, `..` traversal, URL/drive prefix, control chars, and any char outside `[A-Za-z0-9._@+/-]`; blank → dropped) so it cannot inject prompt text.
- `app/server/src/lib/voice-prompts.ts` — `buildWhisperPrompt(context?)` now accepts a tiny vocab-bias snippet, capped to a small tail (`WHISPER_CONTEXT_MAX_CHARS = 120`) to stay under Groq's 224-token `initial_prompt` limit; blank context ignored.
- `app/server/src/lib/constants.ts` — added `VOICE_MAX_TRANSCRIPT_CHARS = 8000` and `VOICE_MAX_FILEPATH_CHARS = 256`.
- Tests: `routes/__tests__/voice.test.ts` rewritten as split-route suites (format allowlist, field-type, transcript cap, filePath injection/normal-path, `/compose` → 404); `lib/__tests__/voice-prompts.test.ts` extended for the context cap.
- Docs: `doc/main/app/backend/routes.md` (Voice section), `doc/main/app/backend/libs.md` (voice-prompts entry), `doc/main/app/README.md` (data-flow #9).

**Why:**
- Splitting makes "formatter runs exactly once at the end" structural: the streaming client posts each captured chunk to `/transcribe` as it lands, then calls `/format` once over the joined transcript at Stop. The cost is re-creating `/compose`'s validation + error mapping in `/transcribe`, plus a new direct input bound on `/format` (the old route bounded formatter input indirectly via the audio upload size).

**Key files:** `app/server/src/routes/voice.ts`, `app/server/src/lib/voice-prompts.ts`, `app/server/src/lib/constants.ts`, `app/server/src/{routes,lib}/__tests__/voice*.test.ts`
**Verification:** targeted `vitest run voice.test.ts voice-prompts.test.ts` → 61 pass; full `cd app/server && npm test` → 420 pass (stable across 3/3 runs).
**Commit:** docs only this pass; route/lib changes are part of the in-flight `voice-streaming` bundle (uncommitted working tree).
**Next:** `vs-vad-module` + `vs-hook` wire the UI to the split endpoints — `app/ui/src/hooks/useVoice.ts` still calls the removed `/compose` until then (expected mid-feature).
**Blockers:** None.

## 2026-06-04: Voice reducer — single `active` phase with derived finalize gate (vs-state-machine)

**What changed:**
- `app/ui/src/hooks/voiceStateMachine.ts` — collapsed the `recording`/`transcribing`/`formatting` phase split into one `active` phase carrying `{ segments, nextIndex, closedForInput, vadStopped, pendingCount, formatting, targetLost }`. `Segment = { index, text: string | null }` (`null` = `/transcribe` in flight, `''` = dropped/failed).
- **Derived finalize gate.** New `selectFinalization(phase)` reads state instead of awaiting: `closedForInput && vadStopped && pendingCount === 0 && !formatting` opens the gate, then branches `no_speech` (zero chunks) / `failed` (≥1 chunk, all empty) / `format` (joined transcript). A chunk flushed after Stop bumps `pendingCount` before `VAD_STOPPED`, so it can't slip past the snapshot.
- **Run isolation tightened.** All async events carry `runId` and are dropped on mismatch — now including `PERMISSION_GRANTED`/`PERMISSION_DENIED` (closes a latent bug where a prior run's session promise resolving during a new run's `requesting_permission` would activate it with the stale session). `TARGET_LOST` deliberately has no `runId` — it is dispatched synchronously from a React effect on the live phase, so it has no async boundary.
- **Gate cannot be bypassed.** Reducer enforces `START_FORMAT` only when finalization derives `format`, `NO_SPEECH` only when `no_speech`, `COMPOSE_READY` only while `formatting` is in flight. `FAIL` stays ungated (multiple legitimate sources).
- Removed the old `InteractionState` members `recording`/`transcribing`/`formatting` and the MediaRecorder-era `TOO_SHORT` event. Added selectors `selectLiveTranscript`, `selectSegments`, `selectPendingCount`.
- `app/ui/src/hooks/__tests__/voiceStateMachine.test.ts` (new) — 22 unit tests: out-of-order resolve, stale-run drops, STOP + late flush, all-failed vs no-speech, target-lost-before-compose, and gate-bypass rejection.

**Why:**
- One slice of the `voice-streaming` project (VAD + coalesced Groq transcription). A single `active` phase makes the late-final-flush and in-flight-drain canonical instead of a race across a `recording`→`transcribing` boundary, and a *derived* gate means a chunk flushed after Stop is just another segment event, not a special case. `NO_SPEECH` vs `FAIL` are kept distinct (idle notice vs error) so a 429/drop never collapses into "no speech."

**Key files:** `app/ui/src/hooks/voiceStateMachine.ts`, `app/ui/src/hooks/__tests__/voiceStateMachine.test.ts`, `plan/archive/20260605_voice-streaming/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run voiceStateMachine` → 22 passed; `tsc --noEmit` + ESLint clean on both in-scope files. Full `tsc -b` is intentionally red — isolated to the four consumers that have not yet adopted the new contract (`useVoice.ts`, `ComposeTray.tsx`, `VoiceControl.tsx`, `useWorkspaceKeyboard.ts`).
**Commit:** working tree (vs-state-machine task; code pending orchestrator commit)
**Next:** `vs-hook` adopts the contract in `useVoice.ts` (VAD orchestration, drop `TOO_SHORT`, pass `runId`); `vs-tray-live` switches consumers to `active` + live transcript. Build greens once both land.
**Blockers:** None (red build is the expected staged-migration state, not a regression)

## 2026-06-04: Vite dev gzip + warmup for remote Tailscale access (rpc-dev-gzip)

**What changed:**
- `app/ui/vite.config.ts` — added a `devGzip` plugin (`apply: 'serve'` only) that registers `compression({ threshold: 512, filter })` on `server.middlewares`. The filter short-circuits `text/event-stream` (and falls back to `compression.filter` otherwise) so the proxied `/api/notifications/stream` SSE is never buffered.
- Same file — added `server.warmup.clientFiles` for `./src/main.tsx`, `./src/App.tsx`, `./src/workspace/WorkspaceScreen.tsx`, pre-transformed at dev-server start to eliminate first-hit transform latency.
- `app/ui/package.json` — added `compression@^1.8.1` (dep) and `@types/compression@^1.8.1` (devDep).
- Docs: `app/doc/dev/workflow.md` (Vite tailnet section now describes the dev gzip + warmup), `projects/active/remote-perf-compress/implementation_summary.md` (new "Dev-server companion" section + status entry).

**Why:**
- Phase 1 (br+gzip precompression) and Phase 2a (lazy splits) only speed up `npm run start:app` — the prod bundle served from `:3001`. But the user's actual remote-access URL `https://desktop.tailnet-example.ts.net/` is reverse-proxied to `127.0.0.1:5173` (Vite dev) because they want HMR while editing from laptop/phone. Without dev compression, every TS/TSX module is sent uncompressed over Tailscale, and cold-load transform latency stacks on top.
- SSE filter is the load-bearing detail: `compression@1.8.1`'s default filter delegates to the `compressible` module, which lists `text/event-stream` as compressible. Without an opt-out, gzip would buffer SSE frames and silently break the live UI refresh signals (filetree, sessions, tasks). The custom filter preserves those event-driven flows while still compressing all the bulk JS/CSS bytes.

**Key files:** `app/ui/vite.config.ts`, `app/ui/package.json`, `app/doc/dev/workflow.md`, `projects/active/remote-perf-compress/implementation_summary.md`
**Verification:**
- `curl -s -D-` GET on `/src/main.tsx` with `Accept-Encoding: gzip` → `Content-Encoding: gzip`, 1642 → 916 B (44%). Same on `/src/App.tsx`: 59002 → 18954 B (68%).
- `curl -s -D-` GET on `/src/main.tsx` without `Accept-Encoding` → no encoding (identity).
- `curl -sN -H 'Accept-Encoding: gzip'` on the proxied `/api/notifications/stream` → `content-type: text/event-stream` with **no `Content-Encoding`** header.
- HMR: `touch src/App.tsx` while dev server is running → `[vite] (client) hmr update /src/App.tsx, /src/index.css` logged within 2s (compression skips WebSocket).
- `cd app/ui && npm run build` succeeds (gzip plugin is gated by `apply: 'serve'`, never runs in build).
- `cd app/server && npm test` → 389/389 pass.
- Known quirk: `curl -sI` (HEAD) doesn't show `Content-Encoding` — expected because compression doesn't encode HEAD responses (no body to compress). `Vary: Accept-Encoding` is still set, and browser GETs compress correctly.

**Commit:** `93b4c63` (feat) + `0f6c269` (SSE filter fix) on `task/rpc-dev-gzip`.
**Next:** Merge to main; re-measure phone cold load to decide whether Phase 2b (`rpc-bootstrap-api`) is still warranted.
**Blockers:** None.

## 2026-06-04: Lazy-load mermaid, Terminal, TaskScreen, WorkspaceTextSearch (rpc-lazy-imports / Phase 2a)

**What changed:**
- `app/ui/src/workspace/markdown.ts` — dropped top-level `import mermaid` + side-effecting `mermaid.initialize(...)`. Added `loadMermaid()`: memoized dynamic `import('mermaid')` that initializes on first call and returns the default export. Removes ~500KB of mermaid core from the main bundle.
- `app/ui/src/workspace/WorkspaceEditorArea.tsx` — `MarkdownPreview` now `await loadMermaid()` inside the mermaid-render effect instead of using a static import.
- `app/ui/src/workspace/WorkspaceEditorColumn.tsx` — exports `LazyTaskScreen = lazy(() => import('../tasks/TaskScreen').then(...))`. Activates tasks-tab column with `<Suspense fallback={spinner}>`.
- `app/ui/src/workspace/WorkspaceScreen.tsx` — `Terminal` and `WorkspaceTextSearch` converted to `React.lazy`; `tasksPane` reuses `LazyTaskScreen` from `WorkspaceEditorColumn` so both render sites share one chunk + one Suspense identity. Each lazy usage wrapped in `<Suspense>` with a minimal fallback (terminal: "Connecting terminal…"; text search: spinner; tasks: spinner).
- `FileExplorer` remains a static import — it's first-paint sidebar UI, so lazying it would introduce a visible Suspense waterfall on cold load.
- Doc touches: `app/CLAUDE.md` (new Bundle-splits conventions bullet); `app/doc/main/ui/workspace/editor-and-preview.md` (mermaid line updated to describe lazy loader); `app/doc/main/frontend/components.md` (`markdown.ts` entry now describes `loadMermaid()`).

**Why:**
- Phase 2a of the remote-perf-compress project. Phase 1 (br+gz precompression) shipped 1.65MB raw → 414KB brotli on the wire, but parse/execute cost still gated cold load on phone over LTE. Cutting 30%+ of the main bundle's raw bytes brings down both transfer time and JS parse time, while the conditional-render lazy boundaries cost nothing on first paint (the fallbacks only render when the user opens those surfaces).
- Original Phase-2a design said "lazy everything heavy" but a codex pre-review caught that lazying `FileExplorer` would introduce a visible Suspense waterfall on every cold load — so the scope was narrowed to the four genuinely-gated surfaces. `FileSearch` (command palette overlay) and `FileExplorerHandle` stay static.
- `LazyTaskScreen` is exported from `WorkspaceEditorColumn.tsx` (not duplicated in two `lazy()` calls) so the two render sites resolve to the same chunk-load promise and the same React component identity, keeping Suspense coherent if both ever mount in the same lifecycle.

**Key files:** `app/ui/src/workspace/markdown.ts`, `app/ui/src/workspace/WorkspaceEditorArea.tsx`, `app/ui/src/workspace/WorkspaceEditorColumn.tsx`, `app/ui/src/workspace/WorkspaceScreen.tsx`, `app/CLAUDE.md`, `app/doc/main/ui/workspace/editor-and-preview.md`, `app/doc/main/frontend/components.md`
**Verification:**
- `cd app/ui && npm run build` → main `index-*.js` dropped from **1,700,415 B → 1,121,391 B** (-34.1%, -566 KB raw). New chunks emitted: `Terminal-*.js` (~361 KB), `TaskScreen-*.js` (~104 KB), `WorkspaceTextSearch-*.js`, `mermaid.core-*.js`, `mermaid-parser.core-*.js`. JS chunk count 187 → 196.
- `grep -rE '^import.*\b(mermaid|Terminal|TaskScreen|WorkspaceTextSearch)\b' app/ui/src/workspace` returns empty (no static imports remain in scope).
- `cd app/server && npm test` → 388/389 pass. The 1 failure is `wechat-pty-tap.test.ts` and is **pre-existing on baseline** (verified by stashing the UI changes and re-running the test — same single failure). Unrelated to this UI work.
- Static smoke via `python3 -m http.server` on `app/ui/dist/` + Playwright navigation: page rendered, no JS or chunk-load errors. The 9 console errors observed were all expected `/api/*` 404s (no backend behind the static server).
- `dist/index.html` has 2 `<link rel="modulepreload">` entries — well under the 10-entry threshold, so `vite.config.ts` was left untouched per design.
**Commit:** `623e1c4`
**Next:** Phase 2b (`rpc-bootstrap-api`) — collapse boot-time `/api/*` fan-out into a single `/api/bootstrap?project=<id>` endpoint. Gated on phone-over-LTE measurement to confirm Phase 2 is still warranted post-Phase-1+2a.
**Blockers:** None

---

## 2026-06-03: Wire br/gzip negotiation into serveUiFile (with ENOENT-fallback fix)

**What changed:**
- `app/server/src/index.ts` `serveUiFile` now reads `Accept-Encoding`, stats `<path>.br` and `<path>.gz`, delegates to `pickEncoding(...)`, and serves the chosen sibling with `Content-Encoding: br|gzip` (omitted on identity). `appendVary(headers, 'Accept-Encoding')` runs on every response. `acceptEncoding` is threaded through the `app.get('*')` route → `serveUiApp` → `serveUiFile` (and again into the SPA `serveUiFile('/')` fallback). Content-Type comes from the BASE filename — not `.br`/`.gz`.
- Suffix guard `filePath.endsWith('.br' | '.gz')` runs **after** `resolveUiPath`, so `decodeURIComponent` bypasses like `/assets/foo.js%2ebr` decode to `foo.js.br` and 404 correctly.
- Race fix: if the chosen compressed sibling vanishes between `stat` and `readFile` (e.g. a concurrent `npm run build` rewrote `dist/`), the catch falls back to reading the canonical base file and drops `Content-Encoding`. ENOENT on the base file is still treated as a genuine miss so the SPA fallback runs.
- `/api/*` (including SSE) is untouched — negotiation only applies to `/`, `/assets/*`, and the index fallback.
- Doc touches: `app/doc/main/backend/server.md` § UI Serving (now documents the active negotiation, the resolved-path suffix invariant, and the compressed-sibling fallback); `app/doc/main/backend/libs.md` (removed the stale "no callers yet" note from the `static-encoding.ts` entry).

**Why:**
- Last piece of the build-time-precompression project: the `.br`/`.gz` siblings that `compress-dist.mjs` writes are now actually delivered. Main `index-*.js` drops from 1.6MB raw → ~414KB brotli, which is the whole point over Tailscale.
- The two non-obvious invariants (resolved-path suffix check; identity fallback on mid-read removal) are the kind of thing a "simplifying" refactor would quietly delete. Documenting them in `server.md` puts them somewhere a future maintainer will look before touching this code.

**Key files:** `app/server/src/index.ts`, `app/doc/main/backend/server.md`, `app/doc/main/backend/libs.md`
**Verification:** `cd app/server && npm test` → 392/392 pass. Curl smoke at `WORKFLOW_PORT=3097`: identity 3001B, gzip 973B (`content-encoding: gzip`), br 770B (`content-encoding: br`); direct `/index.html.br` and `%2e`-encoded variant both 404; `/api/health` unchanged. Race fix verified by renaming `index.html.br` away mid-flight and re-requesting with `Accept-Encoding: br` — server returns 200 + identity bytes (no `content-encoding`), not 404.
**Commit:** `ed7866e..fb60e6e`
**Next:** Project phase 2 — boot-time API waterfall reduction (see project bundle).
**Blockers:** None

---

## 2026-06-03: static-encoding — unlisted identity defaults to q=0 + vitest suite

**What changed:**
- `app/server/src/lib/static-encoding.ts` — one-line semantic fix: `effectiveQ('identity', entries)` now returns **0** (not 1) when identity is unlisted and no `*` covers it. The lenient fallback in `pickEncoding` continues to ship `identity` whenever no candidate has q>0, so the "client truly accepts nothing" path still works.
- File header JSDoc rewritten to enumerate three deliberate divergences from strict RFC §12.4.2: (1) unlisted identity = 0, not 1, (2) identity-forbidden mantle gives unlisted br/gzip q=1.0, (3) lenient identity fallback instead of 406.
- New vitest suite `app/server/src/lib/__tests__/static-encoding.test.ts` — 47 tests across four `describe` blocks: design.md §3 case matrix (21), case+whitespace tolerance (3), q-value handling incl. clamp/drop (7), sibling-on-disk gating (5), and `appendVary` (10).
- Doc touch: `app/doc/main/backend/libs.md` — corrected the `static-encoding.ts` entry (divergences are now 1/2/3, implicit default is 0 for everything including identity).
- One externally-visible behavior change: `Accept-Encoding: gzip;q=0.5` (alone, with sibling on disk) now ships `gzip` instead of `identity`. Matches design intent and real-world server behavior — if the client advertises a compressed coding, send compressed.

**Why:**
- design.md §3 has an internal inconsistency: the prose rule says "identity gets implicit q=1.0" (strict RFC) but the explicit case matrix in the same section requires identity to be effectively q=0 when unlisted (e.g. `br;q=0.4, gzip;q=0.8 → gzip`; `br;q=0.5, gzip;q=0.5 → br`; `br;q=1, gzip;q=0.5` with gz-only on disk → `gzip`). The case matrix is the contract — concrete cases trump prose rules — and matches what nginx/Apache actually do. The earlier implementation followed the prose, so 3 of the new tests failed and revealed the bug. Fixed the code rather than weakening the tests.

**Key files:** `app/server/src/lib/static-encoding.ts`, `app/server/src/lib/__tests__/static-encoding.test.ts`, `app/doc/main/backend/libs.md`
**Verification:** `cd app/server && npm test` → 32 test files / 392 tests passing (all 47 static-encoding tests included).
**Commit:** `bfa277e`
**Next:** Serve-layer wiring — call `pickEncoding`+`appendVary` from the static handler in `app/server/src/index.ts` (separate task).
**Blockers:** None

---

## 2026-06-03: Static-asset encoding negotiation helpers

**What changed:**
- Added `app/server/src/lib/static-encoding.ts`: two pure helpers, no callers yet.
  - `pickEncoding(acceptEncoding, {br, gz}) -> 'br' | 'gzip' | 'identity'` — RFC 9110 §12.4.2-aware Accept-Encoding selector. Case-insensitive token parsing with whitespace tolerance, q-value parsing (missing q = 1.0; numeric out of [0, 1] clamped; truly unparseable dropped), `*` fallback, implicit identity = 1.0, highest-non-zero-q-wins with br > gzip > identity tie-break. Skips codings whose sibling isn't on disk.
  - `appendVary(headers, field)` — case-insensitive dedupe + append; collapses to `*` if either side is `*`.
- Two deliberate divergences from strict RFC compliance, both documented in JSDoc:
  1. `identity;q=0` with a compressed sibling on disk → ship the compressed sibling (unlisted br/gzip inherit identity's q=1.0 implicit-acceptable mantle) rather than 406. The client clearly wants compression.
  2. All candidates at q=0 → lenient `identity` fallback (matches nginx `gzip_static`) rather than 406. Safer for a single-user local app.
- Doc touches: `doc/main/backend/libs.md` (new module entry between `response.ts` and `middleware/project.ts`).

**Why:**
- Companion to the build-time precompression landed in the previous entry. The serve layer still needs a tested, pure selector before it can pick between `.br`, `.gz`, and raw bytes — extracting it as a standalone, dependency-free module lets the eventual serve-layer wiring (separate task) be a thin glue change and keeps the negotiation logic unit-testable in isolation.

**Key files:** `app/server/src/lib/static-encoding.ts`, `app/doc/main/backend/libs.md`
**Verification:** Standalone typecheck with `tsc --noEmit --strict`. 39-case behavioral spot-check via transpile-and-node covering: the classic gzip;q=1, br;q=0.2 ordering trap; tie-break br > gzip > identity at implicit q=1.0; `*` fallback; `*;q=0` lenient-identity collapse; `identity;q=0` ships br/gzip when sibling exists; out-of-range q clamping (`q=2 → 1`, `q=-0.2 → 0`); truly unparseable q dropped (`q=abc`, `q=`); case + whitespace tolerance; missing-sibling exclusion. `appendVary` cases cover unset, case-insensitive dedupe, `*` preservation (alone or in list), and `*` field collapsing. All 39 pass.
**Commit:** `d3976d1` (feat) + `27a0aa1` (fix: two q-value bugs found in code review — identity-forbidden mantle + out-of-range clamp)
**Next:** Wire `pickEncoding` + `appendVary` into the static-serve handler in `app/server/src/index.ts` (separate task `rpc-static-encoding-tests` adds vitest coverage; serve-layer integration is its own task).
**Blockers:** None

---

## 2026-06-03: Precompress UI dist with brotli + gzip at build time

**What changed:**
- Added `app/ui/scripts/compress-dist.mjs`: walks `app/ui/dist/`, writes `<file>.br` (brotli q11, text mode) and `<file>.gz` (gzip level 9) siblings for compressible extensions (`.js .mjs .css .html .svg .json .webmanifest .txt .map`) ≥1KB. Atomic temp+rename per output, always overwrites stale siblings so rebuilds stay consistent, skips inputs already ending in `.br`/`.gz`.
- Chained the script into `app/ui/package.json`'s build (`tsc -b && vite build && node scripts/compress-dist.mjs`).
- Per-file failures log a warning, sweep any `.<base>.<PID>.*.tmp` orphans in the source's directory, and continue; summary line is `[compress-dist] N files: raw … → brotli … / gzip … (failed: N)`.
- Doc touches: `doc/dev/workflow.md` build section; `doc/main/backend/server.md` UI Serving section (notes the precompressed siblings exist for the server-side encoding negotiation to consume).

**Why:**
- The UI bundle is large (main chunk ~1.6MB raw, ~404KB brotli). Doing brotli q11 once at build time — instead of recompressing on every request — keeps the serve hot path cheap while still shipping the smallest payload. Node built-in `zlib` only, no new npm deps.

**Key files:** `app/ui/scripts/compress-dist.mjs`, `app/ui/package.json`, `app/doc/dev/workflow.md`, `app/doc/main/backend/server.md`
**Verification:** Ran `npm run build` twice (idempotent). 164 files compressed: raw 5528.1KB → brotli 1459.5KB / gzip 1717.8KB. Main bundle `index-*.js.br` = 413,974 B. `find app/ui/dist -size -1k -name '*.br' | wc -l` → 0 (no sub-1KB siblings).
**Commit:** `3199755` (feat) + `9510cda` (fix: tolerate per-file errors)
**Next:** Server-side `Accept-Encoding` negotiation (parallel task `rpc-static-encoding`) wires `static-encoding.ts` into the UI serve layer to actually deliver the siblings.
**Blockers:** None
## 2026-06-03: app/server consumes `@yaco/cli/core/paths` workspace package (yc-core-paths)
## 2026-06-04: app/server cuts over from multmux + update-tasks.py to the yaco CLI (yc-app-yaco-agent)

**What changed:**
- **Agent surface.** `app/server/src/lib/multmux.ts` → `agent.ts` via `git mv` (blame preserved). All seven session-management functions now spawn the canonical `yaco agent <sub>` form (`start`, `send`, `capture`, `kill`, `rename`, `status --all`, `status --path`). The provider shortcut `yaco <provider>` is reserved for humans — server code uses `yaco agent start <provider>`. Every spawn passes `--json` and is funneled through a single `runYacoAgentJson(args, timeout, what)` helper that unwraps `{ok,data}/{ok,error}` envelopes; capture pulls its text from `data.text` (in `--json` mode the CLI wraps the pane buffer instead of writing it bytes-faithfully). Failures parse the stderr envelope and rethrow as `yaco <X> failed [CODE]: message`. Type names (`MultmuxSession`, `MultmuxStateFile`, `startMultmuxSession`, etc.) are intentionally retained — the on-the-wire schema is unchanged.
- **Constants.** `MULTMUX_PATH` → `YACO_PATH` (resolves `$YACO_PATH` → `which yaco` → bare `yaco` so PATH wins by default). `MULTMUX_{COMMAND,START,STATUS}_TIMEOUT_MS` → `YACO_AGENT_{COMMAND,START,STATUS}_TIMEOUT_MS`. Added `YACO_TASK_COMMAND_TIMEOUT_MS = DEFAULT_TASK_LOCK_TIMEOUT_MS + 5_000` (imported from `@yaco/cli/core/task`) so lock contention always surfaces as a structured 409 envelope before the server's execFile kills the child. `MULTMUX_SESSIONS_DIR` kept verbatim — it names the shared state directory written by the agent runtime and watched by workflow, and the name is referenced widely.
- **Task surface.** `app/server/src/routes/tasks.ts` no longer shells out to `python3 update-tasks.py`. Mutations call `yaco task set|rm|archive --data <json> --json` via `execFile` (no shell, argv-safe) and parse the envelope; CliError codes map to HTTP status (USAGE/INVALID→400 with `details` preserved, NOT_FOUND→404, CONFLICT/LOCK→409, others→500). GET paths (tasks read + archive list) resolve through `readYacoProjectPaths(repoRoot)` from `@yaco/cli/core/paths` so `yaco.toml [paths].tasks` / `[paths].archive` overrides are honored — reads and writes target the same file by construction.
- **CLI export.** `cli/src/lib/core/task/lock.ts` exports `DEFAULT_TASK_LOCK_TIMEOUT_MS = 10_000` (re-exported from `cli/src/lib/core/task/index.ts`). The acquireLock default now references the named constant; out-of-process callers (currently just `app/server/src/lib/constants.ts`) import it instead of duplicating the magic number, so the spawn-timeout headroom stays in sync if the lock timeout ever moves.
- **Tests.** `app/server/src/lib/__tests__/multmux.test.ts` → `agent.test.ts` (mock constants renamed, import path repointed). New `app/server/src/routes/__tests__/tasks-cli.test.ts` (12 cases) drives every task route through a per-test bash stub at `YACO_PATH` that emits scripted envelopes + exit codes, locking down envelope parsing and the full code-to-status table (including the LOCK→409 contract). `tasks-worktree.test.ts` gains two cases that prove the `[paths]` override resolver is consulted (decoy file at the default path, real file at the override path).
- **Doc cleanup.** `app/CLAUDE.md`, `app/doc/main/backend/{libs,routes}.md`, `app/doc/main/README.md`, `app/doc/main/data-model/{persistence,overview,types}.md`, `app/doc/main/frontend/state.md`, `app/doc/main/ui/{notifications,workspace/sessions-and-terminal}.md`, and `app/doc/dev/workflow.md` updated for the multmux→yaco vocabulary and the new spawn / envelope contract.

**Why:**
- Three separate CLI surfaces (multmux binary, update-tasks.py, scattered envelope conventions) made the app→CLI integration brittle. Routing every spawn through one helper (`runYacoAgentJson` / `runYacoTask`) with one envelope contract means new error codes propagate as HTTP statuses automatically, and the lock/timeout invariant is enforced by an imported constant rather than a documented intent.
- The `[paths].tasks` divergence bug was load-bearing: a user with an override would silently see one tasks file in the UI while the CLI wrote to another — the same `readYacoProjectPaths` resolver now anchors both sides.

**Key files:** `app/server/src/lib/{agent.ts,constants.ts}`, `app/server/src/routes/tasks.ts`, `app/server/src/routes/__tests__/{tasks-worktree,tasks-cli}.test.ts`, `app/server/src/lib/__tests__/agent.test.ts`, `cli/src/lib/core/task/{lock,index}.ts`, plus the doc updates above.
**Verification:** `npm --prefix app/server test` → 342/342 pass (12 new tests). `cd cli && bun run test` → 368/368 pass. Manual gates passed: `yaco.toml [paths].tasks = "custom/tasks.json"` end-to-end (CLI writes + server GET both read the override file, decoy at default path untouched); foreign cross-host lock at `<tasks>.lock.d/owner.json` with `YACO_TASK_LOCK_TIMEOUT_MS=500` → CLI emits `{ok:false,error:{code:LOCK,...}}` on stderr at exit 4 (server maps to 409); `yaco agent status --all --json` envelope round-trips through `runYacoAgentJson`. End-to-end smoke: dev server booted with `YACO_PATH=$PWD/cli/src/main.ts`, ran PUT/PATCH/DELETE on `/api/tasks/<proj>/SMOKE-1` (round-tripped through `yaco task set/rm`) and POST `/api/sessions/start` (`yaco agent start codex` spawned, state file + tmux session created).
**Commit:** `bb523b4` (cutover) + `93d03e5` (codex pass-1 fixes: yaco.toml path resolver, lock-timeout headroom, --json on all agent spawns, envelope tests).
**Next:** None for this scope. Follow-ups owned by other tasks: `tools/install.sh` flip to call `yaco agent hooks install` (yc-install-doctor), migration of `agent-config/global/skills/multmux/SKILL.md` to the `yaco agent` vocabulary, eventual rename of `MULTMUX_SESSIONS_DIR` (cosmetic — current name still works).
**Blockers:** None.

---



**What changed:**
- Deleted `app/server/src/lib/{yacoHome,yacoPaths}.ts` and their unit tests. All 11 callsites in `app/server/src/lib/**` were rewritten to import from `@yaco/cli/core/paths` (workspace package): `projects.ts`, `constants.ts`, `terminal.ts`, `eventsLog.ts`, `notifications-store.ts`, `project-watcher.ts`, `ui-state.ts`, `channels/{auth,state}.ts`, `wechat/login-flow.ts`, `whatsapp/index.ts`.
- `app/server/package.json`: added `@yaco/cli: *` workspace dep; dropped `smol-toml` (only used by the deleted yacoPaths.ts — the workspace module ships its own minimal scoped TOML reader). `app/server/test/eventsLog.test.ts` re-pointed its `projectEventsFile` import at `@yaco/cli/core/paths`.
- Root `package-lock.json` regenerated to include the workspace link (`node_modules/@yaco/cli` → `cli/`). `tsx` (dev/start) and `vitest` (test) resolve the `.ts` source directly through the exports map; no build step needed.
- Doc: `app/doc/main/backend/libs.md` reorganized — the `yacoHome.ts` and `yacoPaths.ts` per-file sections collapse into one `Path resolvers (@yaco/cli/core/paths)` section that documents the full workspace surface. `app/CLAUDE.md` updated to point persistence/dependency notes at the workspace package.

**Why:**
- Three parallel resolver implementations (app/server TS, cli TS, agent-config Python) created drift risk for one path layout. Consolidating onto the workspace package means one resolver, one set of tests, one place to fix when the layout changes.

**Key files:** `app/server/package.json`, `app/server/src/lib/{projects,constants,terminal,eventsLog,notifications-store,project-watcher,ui-state}.ts`, `app/server/src/lib/channels/{auth,state}.ts`, `app/server/src/lib/{whatsapp/index,wechat/login-flow}.ts`, `app/server/test/eventsLog.test.ts`, `app/doc/main/backend/libs.md`, `app/CLAUDE.md`, root `package-lock.json`.
**Verification:** `npm --prefix app/server test` → 330 pass / 0 fail. Acceptance gates from the task: `rg "from .*yacoHome|from .*yacoPaths" app/server/src` → empty; `rg "from '@yaco/cli/core/paths'" app/server/src` → 11 hits; `jq -r '.dependencies["@yaco/cli"]' app/server/package.json` → `*`; both deleted TS files confirmed absent.
**Commit:** `a7a7517` (server rewrite), depends on `7ddee00` (cli core/paths port) and `40549e3` (Python deletions).
**Next:** None for the app/server boundary — consumers should always import from `@yaco/cli/core/paths`, never re-add a local resolver.
**Blockers:** None.

---

## 2026-06-03: Markdown preview line sync moves to double-click

**What changed:**
- Split the `MarkdownPreview` container handler in `WorkspaceEditorArea.tsx`: `onClick` now only handles link navigation (hash anchors, external URLs, relative file/dir links). The "jump to source line" handoff moved to `onDoubleClick` (block-relative-Y interpolation still computes the precise line).
- Double-click handler short-circuits when the target is inside an `<a>`, so a double-click on a link still navigates rather than jumping into edit mode.
- Doc update: `doc/main/ui/workspace/editor-and-preview.md` renames "Preview Click-to-Edit" → "Preview Double-Click-to-Edit" and clarifies the sync-architecture table.

**Why:**
- Single-click was too easy to trigger accidentally while reading. Users would brush the preview and get yanked into edit mode (or have the editor scroll jump in split mode). Double-click matches the convention already used for "open file in pinned tab" / "edit task title".

**Key files:** `app/ui/src/workspace/WorkspaceEditorArea.tsx`, `app/doc/main/ui/workspace/editor-and-preview.md`

**Verification:** Live browser check via Playwright MCP against the running dev server. Opened `README.md` in split mode (13 source-mapped blocks). Single-click on the block at source line 15 → editor cursor stayed at line 1 (PASS). Double-click on the same block → cursor jumped to line 15, line text confirmed (PASS). Injected anchor with external `href` → single-click triggered `window.open` (link nav preserved). Lint on the changed file: no new errors (existing errors at lines 110/124/453 predate this change).

**Commit:** (pending)
**Next:** None
**Blockers:** None

---

## 2026-06-03: Fix hook upgrade to YACO runtime path

**What changed:**
- Fixed `multmux install-hooks` so existing managed `hook-v2.sh` entries are upgraded to the current `${YACO_HOME:-~/.yaco}/hook-v2.sh` path, not only older `hook.sh` entries.
- Added hook coverage for upgrading legacy `~/.multmux/hook-v2.sh` commands.
- Re-ran the root installer so `~/.codex/hooks.json` and `~/.claude/settings.json` now point at `~/.yaco/hook-v2.sh`.
- Removed stale old-repo trust entries from `~/.codex/config.toml` and added `/home/qiguo/ld-workspace/yaco`.

**Why:**
- After removing old repo paths, a live Codex session can still report a stop-hook `ENOENT` if it was started from a deleted cwd or if managed hook config still points at pre-YACO runtime paths. New sessions should start from `/home/qiguo/ld-workspace/yaco` and use the YACO hook path.

**Key files:** `multmux/src/hooks.ts`, `multmux/test/hooks.test.ts`, runtime config under `~/.codex` and `~/.claude`.
**Verification:** `cd multmux && bun test test/hooks.test.ts` passed (42/42); `tools/install.sh --cli-only` passed and `tools/doctor.sh` passed; `~/.codex/hooks.json` and `~/.claude/settings.json` contain only `~/.yaco/hook-v2.sh` hook commands.
**Commit:** this commit.
**Next:** None.
**Blockers:** Existing live sessions launched through `~/.multmux/wrapper-v2.sh` still exist; keep the old runtime scripts until those sessions are closed.

---

## 2026-06-03: Finalize yaco-only service identity

**What changed:**
- Renamed root/server/UI npm package names from `workflow`/`workflow-server`/`ui` to `yaco`/`yaco-server`/`yaco-ui`.
- Renamed app service generation from `workflow-server`/`workflow-ui` to `yaco-server`/`yaco-ui` for Linux systemd and `com.yaco.*` for macOS launchd.
- Renamed production browser persistence keys and tmux paste-buffer names from `workflow-*` to `yaco-*`.
- Simplified component install entry points so they delegate to the root installer without old positional compatibility behavior.
- Simplified registry install logic to only upsert the `yaco` project id; doctor remains responsible for failing if legacy project ids reappear.

**Why:**
- The local path, project id, agent history, and session metadata have already moved to `yaco`; leaving old service/package names would keep surfacing the retired identity in tooling and process lists.

**Key files:** `package.json`, `app/server/package.json`, `app/ui/package.json`, `app/scripts/services.sh`, `tools/install.sh`, `multmux/install.sh`, `agent-config/setup.sh`, `README.md`, `app/ui/src/App.tsx`, `app/server/src/lib/terminal.ts`.
**Verification:** `tools/install.sh --cli-only --dry-run && tools/doctor.sh` passed; `cd app/server && npm test` passed (31 files, 345 tests); `cd app/ui && npm run build` passed; `git diff --check` and shell syntax checks passed; `/api/projects` returns `yaco /home/qiguo/ld-workspace/yaco`; `yaco-server.service`/`yaco-ui.service` are active and old `workflow-*` units are absent; active multmux sessions have 0 old `/workflow` `sessionPath` values; changed-file secret scan found no new secrets; `cd app/ui && npm run lint` still fails on the existing React-hooks/fast-refresh baseline.
**Commit:** this commit.
**Next:** None.
**Blockers:** UI lint baseline remains outside this rename cleanup.

---

## 2026-06-03: Remove transitional compatibility paths

**What changed:**
- Removed the transitional filesystem symlinks for `/home/qiguo/ld-workspace/workflow`, `/home/qiguo/ld-workspace/multmux`, and `/home/qiguo/ld-workspace/agent-config`.
- Removed transitional runtime symlinks for `~/.yaco/projects/workflow` and Claude Code's old path-encoded project history names.
- Updated `tools/install.sh` so the current project id is only `yaco`; legacy `workflow`, `multmux`, and `agent-config` registry ids are cleaned out if seen.
- Updated README wording to make the old split roots archival only, not symlinked active roots.

**Why:**
- After the path, project-id, session, and history migrations completed, the transitional aliases were no longer needed and could hide stale old-path use.

**Key files:** `tools/install.sh`, `README.md`, runtime symlinks under `/home/qiguo/ld-workspace`, `~/.yaco/projects`, and `~/.claude/projects`.
**Verification:** `tools/doctor.sh` passed from the canonical `yaco` checkout; `/api/projects` returns `{"name":"yaco","path":"/home/qiguo/ld-workspace/yaco"}`; no active YACO session has old `/workflow` `sessionPath`.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-06-03: Rename project identity to yaco

**What changed:**
- Renamed the GitHub repository from `imoonkey/workflow` to `imoonkey/yaco` and pushed the monorepo commits.
- Renamed the local checkout from `/home/qiguo/ld-workspace/workflow` to `/home/qiguo/ld-workspace/yaco`, leaving a compatibility symlink at the old path.
- Migrated the YACO project registry id from `workflow` to `yaco`, moved project events to `~/.yaco/projects/yaco`, and migrated UI state keys/notification metadata.
- Updated Claude/Codex session and history path metadata from the old checkout path to `/home/qiguo/ld-workspace/yaco`; Claude project-history directories were moved to the `...-yaco` encoded name with old-name symlinks left for compatibility.
- Updated install/doctor/service scripts to resolve physical paths with `pwd -P` so invocation through old symlinks still points at the canonical checkout.

**Why:**
- The app display name comes from the YACO project id, not the GitHub repository or directory name. Renaming the runtime project id makes the UI show `yaco` while preserving historical session lookup.

**Key files:** `tools/install.sh`, `tools/doctor.sh`, `app/scripts/services.sh`, `app/scripts/yaco-doctor.sh`, `multmux/install.sh`, `agent-config/setup.sh`, runtime files under `${YACO_HOME:-~/.yaco}`.
**Verification:** `tools/doctor.sh` passed from both `/home/qiguo/ld-workspace/yaco` and old symlink `/home/qiguo/ld-workspace/workflow`; Workflow services restarted from `app/server` and `app/ui` under the new path; `/api/health` returned `{"ok":true}`; Codex SQLite `threads.cwd` old-path count is 0 and new-path count is 167; YACO active session state has no old `sessionPath`.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-06-03: Final monorepo review cleanup

**What changed:**
- Added the full final Claude review artifact for `8bd1b81..HEAD` under `projects/active/yaco-monorepo/reviews/`.
- Removed residual tracked `multmux/projects/progress.json` and `.lock` runtime files.
- Removed duplicate `multmux/skill/SKILL.md`; the multmux skill source of truth is now `agent-config/global/skills/multmux/SKILL.md`.
- Updated imported `multmux/` and `agent-config/` CLAUDE/dev docs to describe the monorepo layout and root installer.
- Updated `init-all` global-link warning to point at the monorepo installer.
- Hardened `tools/install.sh` and `tools/doctor.sh` for `mt` symlink safety, corrupt registry JSON, registry error capture, and residual component runtime file checks.

**Why:**
- A full final Claude review approved the migration but found remaining non-blocking cleanup issues that would otherwise preserve stale split-repo instructions or duplicate source-of-truth files.

**Key files:** `projects/active/yaco-monorepo/reviews/claude-review-final-head.md`, `multmux/CLAUDE.md`, `agent-config/CLAUDE.md`, `multmux/doc/dev/workflow.md`, `agent-config/global/skills/init-all/SKILL.md`, `tools/install.sh`, `tools/doctor.sh`, `multmux/projects/`, `multmux/skill/`.
**Verification:** `tools/doctor.sh` passed; `tools/install.sh --cli-only --dry-run` passed; shell scripts passed `bash -n`; `cd app/server && npm test -- tasks autocomplete` passed (24/24); `cd app/ui && npm run build` passed.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-06-03: Post-cutover Claude review cleanup

**What changed:**
- Added Claude's post-commit review artifact for `3433f7a` under `projects/active/yaco-monorepo/reviews/`.
- Fixed app-scoped `CLAUDE.md` drift: monorepo paths, app doc links, documentation tree, ecosystem table, and worktree helper wording now match the cutover.
- Removed duplicate component `projects/active` and `projects/archive` trees from `agent-config/` and `multmux/`; the historical copies remain under `projects/archive/20260603_imported-*`.
- Updated `tools/doctor.sh` to check those duplicate component project trees are absent and to report missing monorepo multmux build artifacts clearly.
- Updated `app/scripts/yaco-doctor.sh` and archived migration tooling to derive paths from the monorepo root instead of old desktop-specific split-repo paths.
- Removed imported Python bytecode from `agent-config/global/skills/update-tasks/scripts/__pycache__/`.

**Why:**
- Claude's review approved the migration overall but found documentation drift and cleanup risks that could confuse future agents or allow duplicate historical task bundles to diverge.

**Key files:** `projects/active/yaco-monorepo/reviews/claude-review-3433f7a.md`, `app/CLAUDE.md`, `app/scripts/yaco-doctor.sh`, `tools/doctor.sh`, `tools/install.sh`, `multmux/install.sh`, `agent-config/setup.sh`, `agent-config/projects/`, `multmux/projects/`.
**Verification:** `tools/doctor.sh` passed; `cd app/server && npm test -- tasks autocomplete` passed (24/24); `cd app/ui && npm run build` passed; shell scripts passed `bash -n`; archived `migrate-tasks.py` passed `py_compile`.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-06-03: YACO monorepo v1 cutover

**What changed:**
- Consolidated the YACO stack into this repository: Workflow moved under `app/`, `multmux/` and `agent-config/` were imported, and root `projects/tasks.json` is now the live task graph for stack work.
- Added root `tools/install.sh` and `tools/doctor.sh`; component installers now delegate to the root installer.
- Workflow task mutation now resolves `agent-config/global/skills/update-tasks/scripts/update-tasks.py` from the monorepo root, with `YACO_UPDATE_TASKS_SCRIPT` as an explicit override, and no longer falls back to `~/.claude/skills`.
- Retired split `multmux` and `agent-config` roots by moving originals into `/home/qiguo/ld-workspace/split-repo-archive/20260603_*` and replacing old paths with symlinks into this monorepo.
- Archived one-time migration scripts under `app/doc/dev/monorepo-migration/2026-monorepo-tools/`.

**Why:**
- A single source checkout removes split-repo drift while keeping v1 runtime boundaries intact: Workflow remains the web app, multmux remains Bun-based, and agent-config remains the global skills/config source.

**Key files:** `README.md`, `CLAUDE.md`, `app/`, `multmux/`, `agent-config/`, `tools/install.sh`, `tools/doctor.sh`, `projects/tasks.json`, `projects/active/yaco-monorepo/*`.
**Verification:** `cd app/server && npm test` passed (31 files, 345 tests); `cd app/ui && npm run build` passed; `cd multmux && bun run test` passed (224 tests); `tools/install.sh --cli-only` passed; `tools/doctor.sh` passed; `app/scripts/services.sh install` started systemd units from `app/server` and `app/ui`; a `yaco-green-smoke` Codex session started through `~/.local/bin/multmux` and was cleaned up.
**Commit:** this commit.
**Next:** Commit and push the monorepo cutover; use `tools/install.sh` on laptop after pulling.
**Blockers:** None.

---

## 2026-06-02: Voice formatter prioritizes GPT-OSS and delayed list markers

**What changed:**
- Moved `openai/gpt-oss-120b` to the front of the built-in voice formatter model chain, ahead of `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, and `llama-3.1-8b-instant`.
- Synced the local ignored `server/.env` `VOICE_FORMATTER_MODELS` override to the same GPT-OSS-first order.
- Extended the formatter prompt so delayed list markers count: if the user says there are multiple points, or starts with unmarked content and only later says `第二`/`第三`, the model should infer the earlier distinct content as item 1.
- Added a prompt example and unit tests for the implicit-first-item list case, and updated backend docs/status examples for the new model order.

**Why:**
- Formatting quality is more important than picking the fastest first model for this workflow, so the strongest formatter should get the first attempt. Real dictation also often starts with an unmarked first point and only becomes explicitly numbered on the second or third point; the formatter should recover that structure instead of preserving the raw ASR order.

**Key files:** `server/src/lib/voice-formatter.ts`, `server/src/lib/voice-prompts.ts`, `server/src/lib/__tests__/voice-formatter.test.ts`, `server/src/lib/__tests__/voice-prompts.test.ts`, `doc/main/backend/{libs,routes,server}.md`, local ignored `server/.env`.
**Verification:** `cd server && npm test -- voice-prompts voice-formatter voice.test` passed (56/56).
**Commit:** this commit.
**Next:** Try a real voice sample with "我分三点 ... 第二 ... 第三 ..." and tune examples if GPT-OSS still under-structures it.
**Blockers:** None.

---

## 2026-06-02: Voice formatter Groq model chain refresh

**What changed:**
- Updated the default voice formatter model chain from `qwen/qwen3-32b` → `moonshotai/kimi-k2-instruct-0905` → `openai/gpt-oss-120b` to `llama-3.3-70b-versatile` → `qwen/qwen3-32b` → `openai/gpt-oss-120b` → `llama-3.1-8b-instant`.
- Removed Kimi from the default formatter chain because the current Groq `/models` response for this account does not list it and direct completions return 404.
- Replaced the stale Qwen `reasoning_format: "none"` request parameter with current Groq reasoning params: Qwen uses `reasoning_effort: "none"` + hidden reasoning; GPT-OSS uses low-effort hidden reasoning.
- Updated backend docs and formatter unit tests for the new defaults and reasoning params.

**Why:**
- The old Kimi fallback wasted a model attempt before reaching GPT-OSS, and Groq now rejects `reasoning_format: "none"` for Qwen. Formatter defaults should prefer currently available, stable models and avoid API-level request errors before fallback.

**Key files:** `server/src/lib/voice-formatter.ts`, `server/src/lib/__tests__/voice-formatter.test.ts`, `doc/main/backend/libs.md`, `doc/main/backend/routes.md`, `doc/main/backend/server.md`.
**Verification:** `cd server && npm test -- voice-formatter voice.test` passed (40/40) with normal `.env` present. Full `cd server && npm test` is still not a reliable verification target in this shell because existing env-sensitive tests assume selected variables are absent and the real-tmux `wechat-pty-tap` test can miss later pane lines when run inside the full parallel suite; those are unrelated to the voice formatter change.
**Commit:** this commit.
**Next:** Watch real formatting quality; if `llama-3.3-70b-versatile` is slower than desired, move Qwen first via `VOICE_FORMATTER_MODELS` or a follow-up default tweak.
**Blockers:** None.

---

## 2026-06-02: Voice formatter prompt rebuilt around OpenLess-style cleanup

**What changed:**
- Replaced the conservative shared voice formatter prompt with an OpenLess-style general formatter: ASR transcript is treated as messy source text, not a request to answer; final self-corrections win; 2+ distinct items become numbered lists; messy 3+ item dictation may be regrouped by meaning.
- Added `buildFormatterUserMessage()` so raw ASR text is sent inside a `<raw_transcript>` envelope instead of as bare user text.
- Added conservative formatter output cleanup for common model wrappers (`Here is the cleaned text:`, `整理如下：`, outer code fences, whole-output quotes).
- Updated prompt/formatter unit tests to pin no-answer framing, final-correction rules, list/regrouping rules, transcript envelope escaping, and wrapper cleanup.

**Why:**
- Real usage showed the previous formatter often returned "raw transcript plus punctuation": spoken 1/2/3 lists did not reliably become lists, mid-sentence corrections were retained, and messy ordering was preserved. OpenLess's structured prompt has been iterated through Pro/community prompt migrations and later fixes such as "2 items must be numbered", so its core rules are a better baseline than adding new command-specific modes.

**Key files:** `server/src/lib/voice-prompts.ts`, `server/src/lib/voice-formatter.ts`, `server/src/lib/__tests__/voice-prompts.test.ts`, `server/src/lib/__tests__/voice-formatter.test.ts`, `doc/main/backend/libs.md`.
**Verification:** `cd server && npm test -- voice-prompts voice-formatter voice.test` passed (53/53). `cd server && env -u GROQ_API_KEY npm test` passed (342/342). Plain `cd server && npm test` fails in this shell because `GROQ_API_KEY` is set and the pre-existing autocomplete env test expects it unset.
**Commit:** this commit.
**Next:** Test with real voice input for messy lists and corrections; tune prompt examples before adding UI/settings.
**Blockers:** None.

---

## 2026-06-02: File Explorer multi-select (batch delete + batch drag)

**What changed:**
- `FileNodeRenderer.handleClick` now routes `metaKey || ctrlKey` to `selectMulti()`/`deselect()` and `shiftKey` to `selectContiguous()` before any preview/toggle side-effects.
- `FileExplorer`: removed `disableMultiSelection` and the controlled `selection` prop (incompatible with multi-select). `onMove` iterates `dragIds` and issues per-source `moveFile` calls. `confirmDelete` widened from `string` to `string[]`; right-click Delete on a multi-selected node deletes the whole selection, otherwise just the right-clicked node. ConfirmDialog title reads `Delete N items?` for batches.
- Added `ui/tests/e2e/file-multiselect.spec.ts` covering Ctrl+Click batch delete and the single-target regression.

**Why:**
- User reported the file tree could not be multi-selected. react-arborist 3.5.0 only listens for `metaKey` in its built-in handler, and the project's custom node renderer swallowed all modifiers — so Cmd+Click was a no-op on macOS via the renderer and Ctrl+Click was a no-op everywhere.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/components/fileExplorerNode.tsx`, `ui/tests/e2e/file-multiselect.spec.ts`, `doc/main/ui/workspace/explorer-and-changes.md`.
**Verification:** `cd ui && npx playwright test tests/e2e/file-multiselect.spec.ts` passed (2/2). Regression: `cd ui && npx playwright test tests/e2e/file-create.spec.ts tests/e2e/copy-path.spec.ts` passed (7/7). `cd ui && npx tsc --noEmit` clean. `cd ui && npx eslint src/components/FileExplorer.tsx src/components/fileExplorerNode.tsx` clean.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-06-02: Terminal voice Insert uses tmux bracketed paste

**What changed:**
- Terminal voice Insert now sends `{ type: 'text-paste', data }` instead of plain `{ type: 'input' }`.
- The server handles `text-paste` by validating the payload, loading it into a tmux buffer, and running `tmux paste-buffer -p` against the target pane without sending Enter.
- Added focused server/UI tests for the tmux paste command shape, oversized-payload rejection, and the UI message type.

**Why:**
- Codex renders plain keyboard input streams noticeably slower than Claude for composed voice text. Bracketed paste gives Claude, Codex, and shell sessions the same bulk-insert path already proven by multmux, while preserving the existing "Insert fills the input box; user presses Enter" behavior.

**Key files:** `server/src/lib/terminal.ts`, `server/src/index.ts`, `ui/src/components/Terminal.tsx`, `server/src/lib/__tests__/terminal.test.ts`, `ui/src/components/__tests__/Terminal.focus.test.tsx`, `CLAUDE.md`, `doc/main/README.md`, `doc/main/backend/server.md`, `doc/main/backend/libs.md`, `doc/main/frontend/components.md`, `doc/main/ui/workspace/sessions-and-terminal.md`, `projects/active/voice-input-improvement/implementation_summary.md`, `projects/active/voice-input-improvement/terminal-paste-plan.md`.
**Verification:** `cd server && env -u GROQ_API_KEY npm test` passed (337/337). `cd ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (8/8). `cd ui && npx eslint src/components/Terminal.tsx src/components/__tests__/Terminal.focus.test.tsx` passed. `cd ui && npm run build` passed (existing Vite large-chunk warning only). `git diff --check` passed. Repo-wide `cd ui && npm run lint` still fails on pre-existing React hook/refresh lint debt outside this change. Manual tmux probes: Claude Code accepted paste into the prompt without submit; Codex accepted paste into a real TUI prompt after a minimal first turn, without submit; temporary `wf-paste-*` sessions were cleaned up.
**Commit:** this commit.
**Next:** Restart the Workflow server if the long-running service is not watching imported server modules.
**Blockers:** None.

---

## 2026-06-02: Codex terminal color probe passthrough

**What changed:**
- `Terminal.tsx` now lets Codex sessions pass OSC 10/11/12 color report queries through to xterm.js, while Claude and shell sessions still suppress pure query replays.
- Added tests for Codex passthrough, non-Codex suppression, and provider changes updating the existing OSC handler policy.
- Updated the terminal docs to describe the provider-specific OSC color behavior.

**Why:**
- Codex v0.136 probes terminal colors via OSC. Workflow was permanently consuming those queries, so after Codex redrew the TUI (session switch, reattach, or a completed turn) it could stop emitting the input box background sequence and the prompt blended into the editor background.

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/ui/workspace/sessions-and-terminal.md`.
**Verification:** `cd ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (8/8). `cd ui && npx eslint src/components/Terminal.tsx src/components/__tests__/Terminal.focus.test.tsx` passed. `cd ui && npm run build` passed (existing Vite large-chunk warning only).
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-06-01: Voice compose draft → clipboard backup

**What changed:**
- `ComposeTray` now stashes the current `editText` on the clipboard whenever the tray closes with content via any path — Insert, Discard, X, or Esc (`backupDraft()` wrapping `handleConfirm`/`handleDiscard`, with `handleClose` routed through `handleDiscard`).
- Reuses the existing `writeTextToClipboard()` helper (Async Clipboard API + `execCommand` fallback); shows a 1.5s sonner toast on success.
- Added `ui/tests/e2e/voice-compose-backup.spec.ts` (fake mic + stubbed `/api/voice/{status,compose}`) verifying both Insert and Discard land the edited draft on the clipboard.

**Why:**
- The IME/voice insert path occasionally glitched (WS dropped or session detached mid-send) so the text never reached the terminal — and because the tray closed, the carefully-edited draft was lost with it. The clipboard backup is a defensive safety net so the text is always recoverable. The `execCommand` fallback keeps it working on mobile and over plain-HTTP LAN/Tailscale where `navigator.clipboard` is unavailable; the ~150ms close animation stays within the browser's transient-activation window so the Esc path still copies.

**Key files:** `ui/src/components/ComposeTray.tsx`, `ui/tests/e2e/voice-compose-backup.spec.ts`, `doc/main/README.md`.
**Verification:** `npx playwright test tests/e2e/voice-compose-backup.spec.ts` passed (2/2). `npx tsc --noEmit` clean.
**Commit:** `840bf80` (docs follow-up: this commit).
**Next:** None.
**Blockers:** None.

---

## 2026-05-31: Terminal right-edge gutter fix

**What changed:**
- Updated `Terminal.tsx` resize fitting to subtract xterm's internal vertical scrollbar width, not just the browser-native scrollbar width.
- Made terminal padding parsing resilient to empty computed CSS values.
- Added a component test that locks the column calculation with a simulated 14px xterm scrollbar.

**Why:**
- xterm v6 DOM renderer adds its own scrollbar element. The custom fit pass was ignoring that width, so the rightmost terminal column could be drawn under the scrollbar area and look clipped.

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/frontend/components.md`.
**Verification:** `cd ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (4/4). `cd ui && npx eslint src/components/Terminal.tsx src/components/__tests__/Terminal.focus.test.tsx` passed. `cd ui && npx tsc --noEmit` passed. Headless Playwright against `http://localhost:5173/` confirmed xterm screen/right scrollbar overlap is `0px` after the fix.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-05-31: Native browser PDF viewer

**What changed:**
- Replaced the react-pdf single-page `PdfPreview` (manual page nav, zoom, fit-to-screen toolbar) with an `<iframe>` embedding the raw-file URL, delegating to the browser's native PDF viewer.
- Deleted `PdfRenderer.tsx` and removed the `react-pdf` dependency + its CDN worker fetch.

**Why:**
- The single-page renderer couldn't scroll to the next page or navigate by keyboard. The raw endpoint already serves `application/pdf`, so the native viewer gives continuous scroll, keyboard nav, zoom, search, and thumbnails for free — far less code, more capability (KISS).
- Trade-off: viewer chrome follows the browser, not the Solarized theme.

**Key files:** `ui/src/workspace/PdfPreview.tsx`, `ui/src/workspace/PdfRenderer.tsx` (deleted), `ui/package.json`.
**Verification:** `npx tsc --noEmit` clean; `npm run build` passed.
**Commit:** 18a77a9
**Next:** None.
**Blockers:** None.

---

## 2026-05-27: Removed YACO legacy runtime compatibility paths

**What changed:**
- Removed runtime reads of repo-local `projects/progress.json` / `projects/active/*/progress.json`; `scanProgress()` now reads only `~/.yaco/projects/<id>/events.jsonl`.
- Removed the progress dismiss route and the old `progress.json` watcher service.
- Removed boot-time channel migration from `~/.workflow`; one-time migration remains in `scripts/migrate-to-yaco.sh`.
- Tightened project registry handling to the latest `{id,path}` on-disk format only.
- Changed the migration script back to moving multmux hook/wrapper scripts instead of preserving old hook paths for live pre-migration sessions.
- Updated docs and tests to reflect latest-codepath-only behavior.

**Why:**
- v0 should not carry backward-compatible runtime branches. Legacy files are migration input only; after migration, runtime uses `~/.yaco` and `events.jsonl`.

**Key files:** `server/src/lib/scanner.ts`, `server/src/index.ts`, `server/src/lib/projects.ts`, `server/src/routes/progress.ts`, `scripts/migrate-to-yaco.sh`, `scripts/yaco-doctor.sh`, `doc/main/**`, `projects/active/yaco-core/**`.
**Verification:** `cd server && env -u GROQ_API_KEY npm test` → 335 pass / 0 fail. `bash scripts/test-migrate-to-yaco.sh` → all assertions pass. `bash scripts/test-yaco-doctor.sh` → all assertions pass. `bash scripts/yaco-doctor.sh` on live state → 7/7 PASS.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

---

## 2026-05-27: YACO runtime root migration completed

**What changed:**
- Synced `projects/active/yaco-core/final/design.md` with the reviewed Chinese design: project identity now lives in `~/.yaco/projects.json`, optional `yaco.toml` is path-only, no full YACO CLI product, migration is a one-time script, and the original discussion comments are preserved in an appendix.
- Added `SPEC.md`, JSON schemas, and migration fixtures for the YACO v0 substrate.
- Added `server/src/lib/yacoPaths.ts`, `eventsLog.ts`, and tests. Runtime progress now appends/project events via `~/.yaco/projects/<id>/events.jsonl`; `scanProgress` merges events with legacy `progress.json` until migration removes the old files.
- Added `scripts/migrate-to-yaco.sh`, `scripts/yaco-doctor.sh`, and smoke tests. Migration copies old multmux hook/wrapper scripts instead of moving them, preserving live pre-migration sessions.
- Updated `projects/tasks.json`: the `yaco-core` milestone and all nine child tasks are `done`.
- Rebuilt and installed `multmux`; hot-restarted the Workflow dev server.

**Why:**
- The stack needed one coherent agent-human collaboration substrate instead of scattered `~/.workflow`, `~/.multmux`, repo-local progress files, and YACO-specific skill assumptions.
- The reviewed design intentionally keeps v0 simple: no full YACO CLI, no daemon, no DB, no first-class Run entity, and no workstream compatibility model.

**Key files:** `projects/active/yaco-core/final/{design.md,SPEC.md,schemas/**}`, `server/src/lib/{yacoPaths,eventsLog,scanner,session-reconciler,projects}.ts`, `scripts/{migrate-to-yaco.sh,yaco-doctor.sh,test-migrate-to-yaco.sh,test-yaco-doctor.sh}`, `doc/main/data-model/persistence.md`, `projects/tasks.json`.
**Verification:** `cd server && env -u GROQ_API_KEY npm test` → 345 pass / 0 fail. `bash scripts/test-migrate-to-yaco.sh` → all assertions pass. `bash scripts/test-yaco-doctor.sh` → all assertions pass. `bash scripts/yaco-doctor.sh` on live state → 7/7 PASS. `cd ../multmux && bun run test` → 223 pass / 0 fail. `cd ../agent-config && python3 -m unittest discover -s global/lib -p 'test_*.py'` → 16 pass / 0 fail. `multmux status --json --all` after install sees the YACO sessions registry.
**Commit:** this commit
**Next:** Review whether to keep session state flat (`~/.yaco/sessions` + `shell-sessions`) or split under `sessions/{agents,shells}` in a later cleanup.
**Blockers:** None.

---

## 2026-05-27: Multmux session-state root moved under YACO (yc-multmux-state-root)

**What changed:**
- `multmux/src/state.ts`: replaced the module-load constant `SESSIONS_DIR = ~/.multmux/sessions` with a call-time `sessionsRoot()` resolver — `process.env.MULTMUX_STATE_DIR` wins, otherwise `yacoHome.sessionsDir()` (= `${YACO_HOME:-~/.yaco}/sessions`). All call sites (`stateDir`, `statePath`, `ensureStateDir`, `cleanupBreadcrumbs`, `cleanupOrphanBreadcrumbs`, `renameState`, `listStateHandles`) rewired to call the resolver each invocation, so per-test env swaps take effect without a module reload.
- `multmux/src/hooks.ts`: HOOK_V2_SCRIPT and WRAPPER_V2_SCRIPT shell bodies now compute `sd="${MULTMUX_STATE_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}"`. Old hardcoded `$HOME/.multmux/sessions/` removed from both scripts.
- `multmux/src/yacoHome.ts`: dropped the "still defaults to ~/.multmux" forward-reference notes from `getYacoHome()` and `sessionsDir()` JSDoc.
- `multmux/test/{state,hooks,wrapper,lifecycle-guards}.test.ts`: replaced fakehome `.multmux/sessions` paths with `.yaco/sessions`; `state.test.ts` and `lifecycle-guards.test.ts` now set `MULTMUX_STATE_DIR` to a tmp dir in `beforeAll` (and restore in `afterAll`) so CI runs never touch the real `~/.yaco/sessions`. Added 7 new override/precedence cases across the three suites; `lifecycle-guards.test.ts` replaced its hardcoded `SESSIONS_DIR` constant with a call to `state.ts#stateDir()` so the mocked `sendKeys` / `startOscColorQueryResponder` read from wherever real `writeState` wrote.
- `workflow/server/src/lib/yacoHome.ts`: added `sessionsDir()` helper (mirrors multmux's).
- `workflow/server/src/lib/constants.ts`: `MULTMUX_SESSIONS_DIR = sessionsDir()` (resolved at module load). `MULTMUX_STATE_DIR` env override intentionally **not** honored on the workflow side — that's a multmux-CLI-side knob only.
- `workflow/server/src/lib/multmux.ts`: JSDoc updated to reference the new path.
- `workflow/server/src/lib/__tests__/{wechat-router,channel-streaming}.test.ts`: state-file fixtures moved from `.multmux/sessions` to `.yaco/sessions` under the mocked `$HOME`.
- SOTA docs synced: workflow `CLAUDE.md`, `doc/main/README.md`, `doc/main/backend/{libs,server,routes}.md`, `doc/main/data-model/{persistence,api-contracts}.md`, `doc/main/ui/notifications.md`, `doc/main/ui/workspace/sessions-and-terminal.md`, `doc/dev/workflow.md`; multmux `CLAUDE.md`, `doc/main/{architecture,state-contract,lifecycle}.md`. `projects/active/yaco-core/implementation_summary.md` extended.

**Why:**
- `final/design.md` §Canonical Path Layout + §Multmux State Contract place agent sessions at `~/.yaco/sessions/`. yc-path-shims pre-built the resolver and annotated the two leaf constants (`SESSIONS_DIR`, `MULTMUX_SESSIONS_DIR`) as this task's scope; the flip is mechanical because both repos already had `sessionsDir()` exposed. The state-file vs CLI contract is unchanged — only the storage root moves. `MULTMUX_STATE_DIR` survives as an explicit override knob because multmux tests and edge-case operators still need a way to redirect state without rebinding `HOME`. The call-time resolver (vs module-load constant) is what makes the multmux test suites safely isolate to a tmp dir via `beforeAll`.

**Key files:** `multmux/src/{state,hooks,yacoHome}.ts`, `multmux/test/{state,hooks,wrapper,lifecycle-guards}.test.ts`, `workflow/server/src/lib/{yacoHome,constants,multmux}.ts`, `workflow/server/src/lib/__tests__/{wechat-router,channel-streaming}.test.ts`, workflow `CLAUDE.md` + `doc/{main,dev}/**`, multmux `CLAUDE.md` + `doc/main/**`, `projects/active/yaco-core/implementation_summary.md`.
**Verification:** `cd multmux && npm test` → 223 pass / 0 fail (was 214; +9 new cases — 3 resolver-precedence, 4 env-override, 2 covering tmp-dir isolation + lifecycle-guards path resolution). `cd workflow/server && npx vitest run` → 326 pass / 1 fail (pre-existing `autocomplete.test.ts` GROQ env-leak, unaffected). Acceptance: `rg "\.multmux/sessions"` across both repos' SOTA docs returns nothing; only legacy/archived references remain in `doc/PROGRESS.md` history entries and `projects/archive/20260321_hooks/**`. No `multmux install-hooks` run, no global binary rebuild, no on-disk migration.
**Commit:** `5d602b3` (workflow), `8a35593` (multmux).
**Next:** `yc-migration-script` — one-shot script that copies any existing `~/.multmux/sessions/*.json` into `~/.yaco/sessions/`, rewrites installed hook/wrapper scripts via `multmux install-hooks`, then deletes the legacy directory. Until that runs, users with running agent sessions on the old multmux binary keep those state files at `~/.multmux/sessions/` and are visible only after they restart their multmux CLI.
**Blockers:** None.

---

## 2026-05-27: YACO_HOME path shims across workflow/multmux/agent-config (yc-path-shims)

**What changed:**
- `server/src/lib/yacoHome.ts` (new): `getYacoHome()` returns `process.env.YACO_HOME || ~/.yaco`; named helpers `projectsFile`, `uiStateDir`, `shellSessionsDir`, `channelsDir`, `channelScopeDir(scope)`, `projectEventsFile(id)`. `server/test/yacoHome.test.ts` (new, 10 cases, vitest) covers env override + each helper.
- Workflow call-site sweep onto helpers: `lib/projects.ts` (renamed `ensureWorkflowDir` → `ensureYacoHome`; `index.ts` caller updated), `lib/ui-state.ts`, `lib/notifications-store.ts`, `lib/terminal.ts`, `lib/channels/{auth,state}.ts`, `lib/wechat/login-flow.ts`, `lib/whatsapp/index.ts`, `lib/project-watcher.ts`. `lib/migrate-channels.ts` rewrote to keep the legacy `~/.workflow/` source but route the destination through `channelsDir()`. Existing tests under `server/src/{lib,routes}/__tests__/` updated to use `.yaco` fixtures.
- `lib/constants.ts` + `lib/multmux.ts`: `MULTMUX_SESSIONS_DIR` annotated as out of scope (yc-multmux-state-root will flip it via the new `sessionsDir()` resolver multmux now exposes).
- `multmux/src/yacoHome.ts` (new) + `multmux/src/hooks.ts`: `HOOK_V2_SCRIPT_PATH` and `WRAPPER_V2_SCRIPT_PATH` now derive from the resolver (managed scripts move from `~/.multmux/` to `${YACO_HOME:-~/.yaco}/`). Hook script body still references `$HOME/.multmux/sessions/` because that's the sessions root — out of scope here; `multmux/src/state.ts` SESSIONS_DIR annotated likewise. `multmux/test/yacoHome.test.ts` (new, 6 cases) registered in `package.json` `test:unit`. The resolver also exports `sessionsDir()` so yc-multmux-state-root's flip is one import change away.
- `../agent-config/global/lib/yaco_home.py` (new) + `test_yaco_home.py` (new, 10 cases, stdlib unittest): symmetric Python resolver for skill scripts, including `sessions_dir()`.
- Workflow docs synced: `CLAUDE.md`, `doc/main/README.md`, `doc/main/data-model/{persistence,overview,api-contracts}.md`, `doc/main/backend/{libs,server,routes}.md`, `doc/main/frontend/hooks.md`, `doc/main/ui/workspace/sessions-and-terminal.md` now show `${YACO_HOME:-~/.yaco}/…` for all workflow-owned runtime paths and flag `~/.multmux/sessions/` as the yc-multmux-state-root next step. Multmux docs synced: `doc/main/architecture.md`, `doc/main/state-contract.md`, `doc/main/providers.md`. Implementation status updated in `projects/active/yaco-core/implementation_summary.md`.

**Why:**
- `final/design.md` §Canonical Path Layout puts everything workflow-owned under `~/.yaco/`. Wiring the resolver before any data migration means a future YACO root move (or per-machine override via `YACO_HOME`) is one env var, not a code sweep. Shipping the multmux `sessionsDir()` resolver in the same change keeps yc-multmux-state-root mechanical: flip imports, not derive a new helper. Workflow's `migrate-channels` stays the only place that knows about the historical `~/.workflow/` layout, scoped to a one-shot legacy migration with documented intent.

**Key files:** `server/src/lib/yacoHome.ts` (new), `server/test/yacoHome.test.ts` (new), `multmux/src/yacoHome.ts` (new), `multmux/test/yacoHome.test.ts` (new), `agent-config/global/lib/yaco_home.py` (new), `agent-config/global/lib/test_yaco_home.py` (new). Server lib sweep across `lib/{projects,ui-state,notifications-store,terminal,migrate-channels,project-watcher,channels/{auth,state},wechat/login-flow,whatsapp/index,multmux,constants}.ts`. Test updates across `server/src/{lib,routes}/__tests__/`. Multmux: `src/{hooks,state}.ts`, `package.json` test list. Docs: workflow `doc/main/**` + `CLAUDE.md`, multmux `doc/main/**`.
**Verification:** `cd server && npm test` → 326 pass / 1 fail (pre-existing `autocomplete.test.ts` env-leak — unaffected by this work). `cd ../multmux && npm test` → 214 pass / 0 fail (was 208 + 6 new). `cd ../agent-config/global/lib && python3 -m unittest test_yaco_home -v` → 10 pass / 0 fail. Acceptance `rg "\.workflow|\.multmux/sessions"` across `server/src`, `../multmux/src`, `../agent-config/global` (excluding tests + node_modules) returns only documented legacy/forward references.
**Commit:** `c94b893` (workflow), `4dacd8f` (multmux), `72bdeb7` (agent-config).
**Next:** `yc-multmux-state-root` — flip `MULTMUX_SESSIONS_DIR` (workflow) and `SESSIONS_DIR` (multmux) to consume `sessionsDir()` and migrate live data.
**Blockers:** None.

---

## 2026-05-27: Workstream live model removed (yc-workstream-collapse)

**What changed:**
- Deleted `server/src/routes/workstreams.ts` (the `/api/workstreams` GET + status PATCH endpoints) and removed its mount from `server/src/index.ts`. Deleted `ui/src/data.ts` (unused mock dataset).
- `server/src/lib/scanner.ts`: dropped `WorkstreamStatus`, `Checkpoint`, `WorkstreamData`, `WorkstreamInfo`, `scanWorkstreams`, `updateWorkstreamStatus`, and the per-bundle `workstream.json` reader. Kept `scanProgress`, `dismissProgress`, `withFileLock`, and the `ProgressEntry` types — the `workstream` field there is now an opaque bundle directory id pending replacement by `events.jsonl`.
- `server/src/lib/project-watcher.ts`: removed the `doc/todo/*/workstream.json` → `workstreams` SSE channel route.
- `ui/src/types.ts`: removed `WorkstreamStatus`, `Workstream`, `Checkpoint`.
- Added `projects/active/yaco-core/final/fixtures/workstream-status-mapping.json` — one example per legacy status (`active→ready`, `human_review→blocked/human-review`, `blocked→blocked/external`, `parked→cancelled/[parked]`, `done→done`) plus `doc→task.design` and incomplete-checkpoint→child-task examples. Documents the migration contract; the actual migration script lands later under `yc-migration-script`.
- Updated `doc/main/{backend/libs.md, backend/routes.md, security.md, data-model/types.md, data-model/overview.md, data-model/persistence.md, data-model/api-contracts.md, frontend/hooks.md}` to frame remaining workstream mentions as historical/migration-only context.
- Appended a section to `projects/active/yaco-core/implementation_summary.md` covering this work.

**Why:**
- `final/design.md` §First-Class Entities explicitly removes Workstream from the model ("workstream is removed... [its] previous artifact directory remains only as a task/design bundle") and §Migration step 8 spells out the status mapping into `tasks.json`. Carrying a parallel `workstream.json` model while planning to migrate it was the worst of both worlds — confusing in code review, duplicated state, drift risk. Per design's "What Not To Build" item #8 ("No second workstream model or compatibility shim after migration") the cleanup is a straight delete with no shim. `projects/active/<bundle>/` survives as a plain doc folder for `/design` / `/double-design` artifacts.

**Key files:** `server/src/routes/workstreams.ts` (deleted), `server/src/lib/scanner.ts`, `server/src/lib/project-watcher.ts`, `server/src/index.ts`, `ui/src/types.ts`, `ui/src/data.ts` (deleted), `projects/active/yaco-core/final/fixtures/workstream-status-mapping.json` (new), `doc/main/**`, `projects/active/yaco-core/implementation_summary.md`.
**Verification:** `cd server && npm test` → 316/318 pass; the 2 failures (`autocomplete.test.ts` GROQ_API_KEY env-leak, `wechat-pty-tap.test.ts` flaky real-tmux capture) pre-existed and are in files not touched by this change. `rg 'workstream\.json' server/src ui/src` returns no matches; `rg 'workstream\.json' doc/main` only matches lines explicitly framed as legacy/historical/removed.
**Commit:** `e0af47d`.
**Next:** `yc-events-jsonl` — replace per-bundle `progress.json` with `~/.yaco/projects/<id>/events.jsonl`, then `yc-migration-script` will use the fixture above to convert real repos.
**Blockers:** None.

---

## 2026-05-27: YACO path-config parser (TS + Python)

**What changed:**
- `server/src/lib/yacoPaths.ts` (new) + `server/test/yacoPaths.test.ts` (new, 6 cases): `readYacoPaths(repoRoot)` parses optional `yaco.toml [paths]` using `smol-toml` and returns the four canonical YACO paths (`tasks`, `active`, `archive`, `worktrees`) with defaults applied. Missing file returns defaults; `[project]` section is ignored; absolute paths and `..` segments are rejected.
- `agent-config/global/lib/yaco_paths.py` (new) + `agent-config/global/lib/test_yaco_paths.py` (new, 6 cases, stdlib unittest): symmetric Python parser using stdlib `tomllib` (Python 3.11+) for skill scripts.
- `server/package.json`: added `smol-toml` dependency (zero-dep, ESM, lightweight).
- `doc/main/backend/libs.md`: documented `yacoPaths.ts`.
- `projects/active/yaco-core/implementation_summary.md` (new): tracks what's built vs. the broader `final/design.md`.

**Why:**
- First leaf piece of the yaco-core plan (see `projects/active/yaco-core/final/{design,SPEC}.md`). The shared helper for `yaco.toml` is needed before the registry move and event stream can be wired up. KISS: one file per language, no abstractions for hypothetical future config. Both parsers were built together so Workflow (TS) and skill scripts (Python) cannot drift.

**Key files:** `server/src/lib/yacoPaths.ts`, `server/test/yacoPaths.test.ts`, `agent-config/global/lib/yaco_paths.py`, `agent-config/global/lib/test_yaco_paths.py`, `doc/main/backend/libs.md`, `projects/active/yaco-core/implementation_summary.md`.
**Verification:** `cd server && npx vitest run test/yacoPaths.test.ts` → 6/6 pass. `cd ../agent-config/global/lib && python3 -m unittest test_yaco_paths -v` → 6/6 pass.
**Commit:** _(this commit)_.
**Next:** Wire the parser into the Workflow server (replace hardcoded `projects/tasks.json` / `projects/active` / `.worktrees` lookups). No caller imports it yet.
**Blockers:** None.

---

## 2026-05-27: Session history sorting uses embedded Claude timestamps

**What changed:**
- `server/src/lib/history.ts`: Claude history now reads first/last top-level JSONL `timestamp` values from the existing head/tail partial reads and prefers them for `created` / `modified`; filesystem birth/mtime are fallback only. Tail reads increased to 64KB so the final timestamp is available even when the last entries include large snapshots.
- `server/src/lib/__tests__/history.test.ts`: added coverage for timestamp-derived Claude created/modified values and for merged Claude/Codex sorting when a Claude file mtime is newer than its embedded session timestamp.
- Docs updated for the backend history reader and UI History tab ordering behavior.

**Why:**
- The closepaw path migration mechanically rewrote Claude JSONL files, which changed their mtimes. Workflow previously sorted Claude history by those file mtimes while Codex used SQLite `updated_at`, so the History tab showed a block of artificially-new Claude sessions above Codex history. Embedded JSONL timestamps are the durable source of truth for session chronology.

**Key files:** `server/src/lib/history.ts`, `server/src/lib/__tests__/history.test.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`.
**Verification:** `cd server && npm test -- history.test.ts` passed (25/25). Restarted Workflow services and verified `GET /api/sessions/history?project=closepaw` returns Codex first with provider counts `{ codex: 80, claude: 120 }`.
**Commit:** _(this commit)_.
**Next:** None.
**Blockers:** None.

---

## 2026-05-25: Markdown preview — resolve relative image paths, fix layout

**What changed:**
- `ui/src/workspace/WorkspaceEditorArea.tsx`: `MarkdownPreview` now accepts `projectName` and `worktree` props. In the `useLayoutEffect` that sets `innerHTML`, after mount and before `buildAnchorCache`, walks every `<img[src]>` and rewrites non-scheme srcs (anything not matching `^[a-z][a-z0-9+.-]*:` and not starting with `//`) via `rawFileUrl(projectName, resolveRelativePath(filePath, src), worktree)`. Mirrors the existing `<a href>` rewriting so READMEs with `<img src="doc/screenshots/foo.png" />` (or markdown `![]()` syntax) actually load instead of 404'ing against the dev-server origin. Call site in the same file threads the new props through.
- `ui/src/index.css`: `.markdown-preview img, .markdown-preview video` now sets `display: inline-block; vertical-align: middle;` to override Tailwind preflight's `display: block`. Without this, READMEs that pack multiple `<img>` into a `<p align="center">` (shield badge rows, side-by-side phone-screenshot grids) wrap each image onto its own line.

**Why:**
- Found while previewing `androidagent/README.md` — every relative-path image (logo, hero banner, four phone screenshots) showed as a broken icon because the browser was resolving them against `localhost:5173/`. After the src fix, layout was still wrong: 4 shield badges stacked vertically instead of inline-centering. Tailwind's preflight `img { display: block }` was the culprit.

**Key files:** `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/index.css`, `doc/main/ui/workspace/editor-and-preview.md`, `doc/main/ui/design-system.md`.
**Verification:** `cd ui && npx tsc --noEmit` clean. Playwright headless QA against `androidagent/README.md` — all 10 images load (`naturalWidth > 0`, `complete: true`), 4 shield badges render on one row, 4 phone screenshots render side-by-side in `<p align="center">`. External `img.shields.io` URLs unaffected.
**Commit:** `8611e39`.
**Next:** —
**Blockers:** None.

---

## 2026-05-19: Image preview adds fit-height + keyboard shortcuts

**What changed:**
- `ui/src/workspace/ImagePreview.tsx`: added a "Fit height" button (`MoveVertical` icon) alongside the existing fit-width (icon switched to `MoveHorizontal` for visual symmetry). New `fitMode: 'width' | 'height'` state — in height mode the image renders with `height:100%, width:auto` inside a flex-centered scroll container, so wide images scroll horizontally instead of being squashed vertically. Zooming exits fit-height back into scale mode. Toolbar shows `Fit` instead of a percentage while in fit-height mode.
- Keyboard shortcuts (when preview has focus): `W` fit width, `H` fit height, `+`/`=` zoom in, `-`/`_` zoom out. Modifier-key combos are ignored so editor shortcuts aren't shadowed. Preview container is `tabIndex={0}` and auto-focuses on mount so shortcuts work immediately.
- Tooltips updated to include the shortcut hint (e.g. `Fit width (W)`); `aria-pressed` reflects the active fit mode.
- `ui/src/workspace/__tests__/ImagePreview.test.tsx`: extended from 2 → 6 cases covering fit-height entry/exit, the `Fit` indicator, and `W`/`H`/`+`/`-` shortcut handling (including the modifier-key guard).

**Why:**
- Tall portrait screenshots opened in fit-width forced vertical scrolling to see the whole image. A fit-height mode lets the whole image fit on screen at once, with horizontal scroll only when needed.

**Key files:** `ui/src/workspace/ImagePreview.tsx`, `ui/src/workspace/__tests__/ImagePreview.test.tsx`, `doc/main/frontend/components.md`.
**Verification:** `cd ui && npx vitest run src/workspace/__tests__/ImagePreview.test.tsx` → 6/6 pass. `cd ui && npx eslint src/workspace/ImagePreview.tsx src/workspace/__tests__/ImagePreview.test.tsx` → clean.
**Commit:** `8e0d9bb`.
**Next:** —
**Blockers:** None.

---

## 2026-05-18: Channel passthrough — non-blocking streaming, active-context markers, WhatsApp lifecycle fixes

**What changed:**
- `server/src/lib/channels/router.ts`: split passthrough into await'd SEND + fire-and-forget reply streaming behind a per-session lock (`sessionStreamLock: Map<handle, Promise>`). Stream callback **re-stat's** the JSONL on lock acquire and bumps `startSize` to current file size — back-to-back same-session sends no longer replay the prior turn's content. Event prefixes added (`interim` → `⏳ `, `final` → `✅ `, `timeout` → `⌛ `; `question` keeps its own `🤔`). `/help` prepends `bound: <project> / <session>` status line; `/projects` and `/sessions` mark current/bound entries with `*`. New `STATE_CHANGING_COMMANDS` set + `isReadOnlyCommand(name)` API so channels can route read-only commands around their queue. Help text aligned: `/h`/`/f` aliases documented, `/new <claude|codex> [name]` documents optional name, `<path>` → `<relative-path>`, stale "2 min" timeout text → "60s" (matches `PASSTHROUGH_TIMEOUT_MS = 60_000`).
- `server/src/lib/whatsapp/index.ts`: read-only commands bypass `serialize(conversationId)` for instant response while a passthrough is in flight. Shared `sendReply` closure extracted (captures `msg` so WhatsApp's native quoted-reply still works on fire-and-forget streamed replies). `initWhatsApp()` retries when `state.phase ∈ {failed, disconnected}` instead of short-circuiting on the stale `client` ref. New `cleanupStaleChromeSingleton()` runs before every Client construction: walks the LocalAuth profile's `SingletonLock`, parses `<host>-<pid>`, kills the PID if alive AND `/proc/<pid>/cmdline` references our profile dir, then unlinks all `Singleton{Lock,Socket,Cookie}` symlinks. Recovers from prior unclean exits.
- `server/src/index.ts`: signal handlers (`SIGTERM`/`SIGINT`/`SIGHUP`) now route through `shutdownGracefully()` which **awaits** `shutdownWhatsApp()` before `process.exit(0)`. Without this, tsx-watch reloads orphaned the Puppeteer Chrome holding the WhatsApp LocalAuth `userDataDir`, leaving a stale `SingletonLock` that blocked subsequent `initWhatsApp()`.
- New `server/src/lib/__tests__/channel-streaming.test.ts`: integration test drives `passthroughText` end-to-end against a synthetic JSONL fixture (mocks `os.homedir` + `sendToSession`). Verifies (1) multi-event `⏳`/`✅` streaming with SEND returning in <2s, (2) two back-to-back same-session sends serialized by per-session lock with NO replay of the prior turn's content. The second test caught the missing re-stat behavior on the first run.
- `server/src/lib/__tests__/wechat-router.test.ts`: `/projects` assertion switched from `toContain('1. alpha')` to `toMatch(/1\.\s+alpha/)` to accept the new aligned-with-marker output.
- Docs: `doc/main/backend/libs.md` (router + whatsapp adapter sections), `doc/main/backend/server.md` (Graceful Shutdown § now mentions the WhatsApp await).

**Why:**
- User sent `/project` (typo of `/projects`) which fell through to passthrough → blocked 60s waiting for the agent. Subsequent `/projects`/`/p` were stuck behind it in the `serialize(conversationId)` FIFO. Bypassing for read-only commands + moving the wait out of the queue fixes both symptoms.
- During the fix, tsx-watch reloads started failing with `The browser is already running for /home/qiguo/.workflow/channels/whatsapp/session/session` — Puppeteer's Chrome was being orphaned because the SIGTERM handler was `void shutdownWhatsApp()` then immediately `process.exit(0)`. Awaiting fixes the common case; boot-time `SingletonLock` sweep + `initWhatsApp` retry handle the recovery path for prior unclean exits.
- Without the re-stat inside the per-session lock callback, the lock prevented concurrent reads but two queued streams both held `startSize = 0` from `startTurn()` — stream B started reading from byte 0 and re-emitted stream A's already-consumed content as its own. Re-statting at lock acquire is the correct fix; the QA test made the bug visible.

**Key files:** `server/src/lib/channels/router.ts`, `server/src/lib/whatsapp/index.ts`, `server/src/index.ts`, `server/src/lib/__tests__/channel-streaming.test.ts`, `server/src/lib/__tests__/wechat-router.test.ts`, `doc/main/backend/libs.md`, `doc/main/backend/server.md`.
**Verification:** `cd server && npm test` → 309/310 pass (1 pre-existing unrelated `autocomplete.test.ts` env-leak flake on missing `GROQ_API_KEY`). New `channel-streaming.test.ts` passes both cases. Manual: killed orphan Chrome + cleaned singletons, POST `/api/whatsapp/login` re-init succeeded in ~4s and bound chat preserved.
**Commit:** `f3b4aec`.

---

## 2026-05-18: Unified bell badge with sidebar via watermark-derived counts

**What changed:**
- `ui/src/hooks/useSessionUnreadState.ts`: `isEligible` no longer restricts to `type === 'session_idle'` — all `status === 'active'` progress entries with a `sessionName` for a live session now contribute to per-session/project unread counts. `markSessionRead` / `markAllRead` always advance the watermark to `Date.now()` (the old "max of matching progress timestamps" logic was overkill); `progressRef` removed. The hook now also returns `readState` so App.tsx can derive per-notification read state.
- `ui/src/App.tsx`: bell badge is `sum(projectUnreadCounts)` (from `useSessionUnreadState`), not `useNotifications.unreadCount`. Inbox items rendered in the panel have their `read` flag overridden by the same watermark check so the per-item accent border matches the badge. New `handleBellMarkRead` / `handleBellMarkAllRead` wrappers advance the relevant watermark(s) on top of the existing inbox PUTs — single click bumps the item's session watermark, "Mark all read" bumps every project's watermark.
- `ui/tests/e2e/shared-state.spec.ts`: badge assertion replaced with an inbox-row-styling assertion (the seeded notification has empty project, so it can no longer drive the watermark-sourced badge; the SSE-sync intent is still covered).
- Docs: `CLAUDE.md`, `doc/main/data-model/persistence.md` (new `unread-watermarks.json` section + `GET/PUT /api/ui-state/unread-watermarks` rows + `useSessionUnreadState` mention), `doc/main/frontend/hooks.md` (new `useSessionUnreadState.ts` section + note on `useNotifications.unreadCount` being ignored by App), `doc/main/ui/notifications.md` (bell-badge and panel-styling source notes).

**Why:**
- The bell badge (inbox `read` flags, capped at 50 items, all 4 progress types) and the sidebar badges (progress.json + watermarks, unbounded, `session_idle` only) were two structurally different counters. After "Mark all read" in the bell, the badge dropped to 0 while the sidebar still showed hundreds — investigation showed this would recur every time, not just once after the watermark migration in [ed2500f]. Routing both through the same `progress + watermarks` pipeline makes them equal by construction.
- Advancing watermarks to `Date.now()` matches the user's mental model ("I clicked into this session, so the whole session is read up to now") and is simpler than scanning progress for a max timestamp.

**Key files:** `ui/src/App.tsx`, `ui/src/hooks/useSessionUnreadState.ts`, `ui/tests/e2e/shared-state.spec.ts`, `CLAUDE.md`, `doc/main/data-model/persistence.md`, `doc/main/frontend/hooks.md`, `doc/main/ui/notifications.md`.
**Verification:** `cd ui && npx tsc --noEmit` clean; `npm run build` clean; `cd server && npm test` passes (one unrelated pre-existing `autocomplete` test fails on missing `GROQ_API_KEY`). Playwright session: confirmed bell `70` = sum(`workflow 20 + androidagent 42 + cproxy 3 + jobspace 4 + learn 1`); after PUTing watermarks for `workflow::claude-shell-env` + `workflow::claude-terminal-size`, bell dropped to `51` and `workflow`'s sidebar badge cleared, with the equality preserved.
**Commit:** `8ae1262`.
**Next:** None. Bootstrap floor (server watermark map starts at `{}`) self-clears as users mark-read or attach sessions.
**Blockers:** None.

---



**What changed:**
- `server/src/lib/terminal.ts` `configureShellTmuxSession()` now also sets `window-size latest` on managed shell tmux sessions.
- `server/src/lib/terminal.ts` `attachSession()` runs `tmux resize-window -x <cols> -y <rows>` immediately after `pty.spawn('tmux','attach-session',…)` so the window snaps to the attaching client's size, regardless of `window-size` policy or whether the new attach has been marked "latest active" yet. Crucially, follows with `tmux set-option window-size latest` to undo `resize-window`'s documented side effect of switching `window-size` to `manual` (which would otherwise freeze the window at the first-attach size forever).
- Companion change in `multmux` (`src/tmux.ts` `createSession`): bumped detached `-x 200 -y 50` → `-x 333 -y 100` and added `tmux set-option window-size latest`. Rebuilt via `bash install.sh`.

**Why:**
- Sessions were rendering inside a tiny top-left rectangle on the laptop browser even though xterm.js was at full pane size — tmux's window was clamped to a previously-attached small client (phone, or a zombie from a leaked node-pty `tmux attach-session`). A fresh attach is not always counted as "latest active" until the user types, so the window stayed clamped and clicking did nothing. The user's manual workaround — open the session on a phone, then click on the laptop — worked because a fresh attach forced tmux to re-evaluate sizes. The fix reproduces that re-evaluation server-side on every attach.
- `latest` is the correct policy for the user's workflow ("on phone I want it to fit phone, on laptop I want it to fit laptop") — not `largest`, which would force phone to see a clipped laptop-width view.
- Pitfall (fixed): `tmux resize-window -x -y` silently sets `window-size` to `manual` (per `man tmux`). Without restoring `latest` afterward, the first attach would lock the window size permanently and no later device switch could refit it.

**Key files:** `server/src/lib/terminal.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`; companion `multmux/src/tmux.ts`.
**Verification:** `cd server && npm test src/lib/__tests__/terminal.test.ts` — 18/18 pass; multmux `bun test test/lifecycle-guards.test.ts` — 15/15 pass; `bash install.sh` rebuilt and deployed the multmux binary. Live test: ran `tmux set-option -t <session> window-size latest` on an in-flight session that had been corrupted into `manual` mode, confirmed it returned to `latest`.
**Commit:** _(this commit)_.
**Next:** Existing tmux sessions still have old options — kill + recreate them, or patch live with `tmux set-option -t <handle> window-size latest`, to pick up the new behavior. Server must be restarted to use the new `attachSession`.
**Blockers:** None.

---

## 2026-05-17: Cross-device shared notifications + pinned sessions; `~/.workflow/channels/<scope>/` reorg

**What changed:**
- New server-side stores: `server/src/lib/notifications-store.ts` (inbox + read flags) and `server/src/lib/ui-state.ts` (per-project pinned sessions + order), both mutex-protected against `~/.workflow/ui-state/notifications.json` and `~/.workflow/ui-state/pinned-sessions.json`.
- REST surface: `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications`, `GET/PUT /api/ui-state/pinned-sessions?project=<p>`.
- SSE event surface widened: `notification` (full payload), `notifications:changed`, `ui-state:changed`. `useSSE.ts` forwards them to consumers; `useNotifications.ts` switched to server-sourced inbox + `notifications:changed` + visibilitychange resync; new `usePinnedSessions.ts` hook does optimistic writes with version-tracked refetch so SSE-driven refetches don't clobber in-flight edits.
- `~/.workflow/` reorganized: messaging channels now live under `~/.workflow/channels/<scope>/{auth.json, state.json, qr.txt, session/}`. One-shot boot migration (`server/src/lib/migrate-channels.ts`) moves legacy flat `wechat-*` / `whatsapp-*` files into the new layout, idempotently, awaited before `serve()` in `server/src/index.ts`; rethrows on non-benign errors.
- `NotificationItem` on the server is a superset of the in-memory `NotificationEvent` (preserves `kind`, `workstream`, `progressType`; adds `read: boolean` and numeric `timestamp`).
- `PersistedState.pinnedSessions` removed from `localStorage` — layout/tabs/drafts/mobilePane/theme remain per-device.

**Why:**
- Opening the app on a second device used to lose notification inbox + read state and reset pinned-session order, because both lived in per-device `localStorage`. Promoting them to the server makes the laptop and the desktop browser converge on the same UI state without manual reconciliation.
- The root of `~/.workflow/` was accumulating flat `wechat-*` / `whatsapp-*` siblings of `projects.json`; grouping them under `channels/<scope>/` keeps the directory readable and matches the per-scope model used by the messaging integration.

**Key files:** `server/src/lib/notifications-store.ts`, `server/src/lib/ui-state.ts`, `server/src/lib/migrate-channels.ts`, `server/src/routes/notifications.ts`, `server/src/routes/ui-state.ts`, `server/src/index.ts`, `ui/src/hooks/useNotifications.ts`, `ui/src/hooks/usePinnedSessions.ts`, `ui/src/hooks/useSSE.ts`, `doc/main/data-model/persistence.md`, `CLAUDE.md`.
**Verification:** `cd server && npm test` — 40+ new tests pass across `notifications-store`, `ui-state`, `migrate-channels`, and the `/api/notifications` + `/api/ui-state/pinned-sessions` route suites. `cd ui && npx tsc -b` clean. E2E coverage for cross-device sync lives in the `ss-e2e` task slug (Playwright, may not be merged at the time of this entry — check that branch).
**Commit:** _(merge commit; backfilled by the merge step)_.
**Next:** None.
**Blockers:** None.

---

## 2026-05-14: Session list refreshes immediately after agent `/exit`

**What changed:**
- Workflow server now starts runtime watchers only after successfully binding `WORKFLOW_PORT`, so duplicate `tsx watch` children that lose `:3001` exit before installing recursive project watchers.
- Shutdown cleanup now stops the session reconciler, progress watcher, and project watcher in addition to terminal attach resources.
- `project-watcher.ts` installs lightweight global watchers (`~/.workflow/projects.json`, `~/.multmux/sessions`) before recursive project watchers, protecting the multmux session refresh path when large workspaces consume many inotify slots.
- Added focused coverage for create/delete events in `~/.multmux/sessions` emitting `refresh:sessions`.

**Why:**
- `/exit` in Codex/Claude deleted the multmux state file promptly, and `GET /api/sessions?project=workflow` stopped returning the session within the next 0.5s poll. The UI still waited because the active server had no `~/.multmux/sessions` watcher installed.
- Root cause was duplicate Workflow server children: one served `:3001`, another was not listening but still held ~248k recursive inotify watches because watchers started before the port bind. Combined usage was near `max_user_watches`, starving later global watchers.

**Key files:** `server/src/index.ts`, `server/src/lib/project-watcher.ts`, `server/src/lib/__tests__/project-watcher.test.ts`, `doc/main/backend/server.md`, `doc/main/backend/libs.md`, `doc/dev/workflow.md`.
**Verification:** `cd server && npm test -- src/lib/__tests__/project-watcher.test.ts src/lib/__tests__/multmux.test.ts src/lib/__tests__/session-reconciler.test.ts` passed (23 tests). `cd server && env -u GROQ_API_KEY npm test` passed (259 tests). Live repro: started a disposable Codex session, sent `/exit`; tmux/state/API were gone by the next 0.5s sample and SSE emitted `refresh:sessions`. Confirmed active server has an inotify watch on `~/.multmux/sessions`.
**Commit:** `ac577af`.
**Next:** None.
**Blockers:** `cd server && npm test` with the current shell env fails one pre-existing autocomplete test because `GROQ_API_KEY` is exported; unsetting it makes the suite pass.

---

## 2026-05-14: Image paste from remote browser into desktop TUI agents

**What changed:**
- New `server/src/lib/clipboard-env.ts` and `server/src/lib/clipboard-write.ts`. The first discovers DISPLAY/XAUTHORITY/WAYLAND_DISPLAY (mutter's per-session Xauthority cookie) on Linux. The second pipes image bytes into the X11 CLIPBOARD via `xclip` (10MB cap, MIME whitelist).
- `ssh-auth.ts` `buildChildProcessEnv()` folds the discovered clipboard env into every child process spawn.
- `terminal.ts` `attachSession()` lazily calls `tmux set-environment -g` once per server lifetime so the running tmux server's globals get DISPLAY/XAUTHORITY/WAYLAND_DISPLAY — future shell/agent windows inherit them even when the tmux server pre-dates the workflow server.
- `index.ts` WS handler accepts `{type:'image-paste', mime, base64}`, writes the bytes to clipboard, and sends `\x16` (Ctrl+V) to the PTY so the focused TUI agent triggers its native paste path.
- `Terminal.tsx` adds a capture-phase `paste` listener that intercepts image MIME items, base64-encodes them, and ships them over the WS. Text paste continues through xterm's default path.

**Why:**
- When the workflow server runs on the desktop and the browser is on the laptop, `Cmd+V` of an image into a Claude Code or Codex pane did nothing — the agent was reading the desktop's clipboard (empty) instead of the laptop's. Mirroring the bytes through the WS into the desktop's X11 CLIPBOARD makes the agent's native paste path work transparently.
- Pivoted to xclip + Xwayland because GNOME mutter's Wayland clipboard portal hangs `wl-copy`/`wl-paste` indefinitely on this setup. xclip via Xwayland round-trips reliably, and both Claude Code (`xclip -t image/png -o`) and Codex (arboard Rust crate) read from the same X11 CLIPBOARD selection.

**Key files:** `server/src/lib/clipboard-env.ts`, `server/src/lib/clipboard-write.ts`, `server/src/lib/ssh-auth.ts`, `server/src/lib/terminal.ts`, `server/src/index.ts`, `ui/src/components/Terminal.tsx`, `server/src/lib/__tests__/terminal.test.ts`.
**Verification:** Lib smoke test wrote a 69-byte PNG via `writeImageToClipboard('image/png', …)` and read back byte-identical via `xclip -t image/png -o`. Server vitest 256/257 (1 pre-existing GROQ_API_KEY failure unrelated). UI `tsc -b` clean. End-to-end: user confirmed pasting screenshots into both new Claude Code and new Codex sessions works from a laptop browser against the desktop server.
**Commit:** `37d7088`.
**Next:** None.
**Blockers:** GNOME mutter's Wayland clipboard portal still broken; if it ever recovers, `wl-copy` would be a cleaner write path. Existing pre-fix agent processes need restart to pick up the new env.

---

## 2026-05-14: Suppress xterm OSC color report leakage

**What changed:**
- Workflow terminal now consumes OSC 10/11/12 color report queries before xterm.js emits automatic color responses through `onData`.
- Added focused Terminal coverage for suppressing query responses while preserving color setter fallthrough.
- Updated terminal SOTA docs for the color-report behavior.

**Why:**
- Codex sometimes prints repeated `^[]10;rgb...^[\` / `^[]11;rgb...^[\` lines on startup. This frontend handler prevents browser-side xterm color-report replies from being written back during tmux scrollback replay.
- Follow-up investigation found the primary startup pollution source in multmux's Codex OSC color-response injection. The Workflow guard remains as a secondary replay-protection layer; the root startup fix lives in multmux.

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/ui/workspace/sessions-and-terminal.md`, `doc/main/frontend/components.md`.
**Verification:** `cd ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (3 tests). `cd ui && npx eslint src/components/Terminal.tsx src/components/__tests__/Terminal.focus.test.tsx` passed. `npm run build` passed and rebuilt `ui/dist`; `:3001` now serves `assets/index-ClHjkC4t.js` with the OSC 10/11/12 query handler, while the old `assets/index-DFoq8lo1.js` returns 404.
**Commit:** 6eff93c
**Next:** None.
**Blockers:** None.

---

## 2026-05-13: Revert BASH_ENV — `bash -lic` wrapper covers the path

**What changed:**
- Removed `Environment="BASH_ENV=%h/.bash_env"` from both systemd unit templates and the `<key>BASH_ENV</key>` block from the macOS launchd plist template in `scripts/services.sh`.
- Updated `doc/dev/workflow.md` "Local Browser Automation Env" section to describe the new path (`bash -li` / `bash -lic` → `.bashrc` → `.bash_env`) instead of the old `BASH_ENV` mechanism.

**Why:**
- `BASH_ENV` was load-bearing back when the wrapper exec'd the agent directly (`/bin/sh -c '<agent>'`) — `.bashrc` was never sourced, so the only way to inject `~/.bash_env` was the bash-specific `BASH_ENV` env var that auto-sources for non-interactive bash. After the recent commits switched the wrapper to `bash -lic 'exec ...'` and SHELL sessions to `bash -li`, the inner bash is interactive and sources `.bashrc`, which (per `~/.bashrc` line 1) sources `~/.bash_env`. So both paths now reach the same env, and `BASH_ENV` is redundant.
- Keeping the redundancy was fine, but it's two mechanisms doing one job. Removing it makes `~/.bash_env` semantically just a `.bashrc` partial (env-only chunk), and the systemd unit / macOS plist no longer needs to know about a user dotfile convention.

**Key files:** `scripts/services.sh`, `doc/dev/workflow.md`.
**Verification:** Re-ran `scripts/services.sh install` on desktop → new unit has no `BASH_ENV=` line. `systemctl --user daemon-reload && systemctl --user restart workflow-server`. Spawned a new shell session via API → `ANTHROPIC_BASE_URL`, `PUPPETEER_EXECUTABLE_PATH`, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` all present (came via `.bashrc` → `.bash_env`). On laptop (macOS), re-ran `scripts/services.sh install` and reloaded the launchd plist — verified the same.
**Commit:** `7e67a39`.
**Next:** None.
**Blockers:** None.

---

## 2026-05-13: Image preview uses fit-width zoom controls

**What changed:**
- Replaced the image preview's single fit-to-viewport `<img>` with a small toolbar for zoom out, zoom in, and fit-width reset.
- Image previews now default to fit-width inside a scrollable canvas, so tall images remain readable and can be scrolled vertically instead of being shrunk to fit the pane height.
- Added component coverage for default fit-width rendering, zoom steps, and reset behavior.

**Why:**
- The previous `maxWidth: 100%` + `maxHeight: 100%` behavior forced very tall images to fit the editor pane height. That preserved the full image on screen but made long screenshots too narrow to read.

**Key files:** `ui/src/workspace/ImagePreview.tsx`, `ui/src/workspace/__tests__/ImagePreview.test.tsx`, `doc/main/frontend/components.md`.
**Verification:** `cd ui && npx vitest run src/workspace/__tests__/ImagePreview.test.tsx` passed (2 tests). `cd ui && npx eslint src/workspace/ImagePreview.tsx src/workspace/__tests__/ImagePreview.test.tsx` passed. `cd ui && npx tsc --noEmit` passed. `npm run build` passed with the existing Vite large-chunk warning.
**Commit:** `7a39a4a`.
**Next:** None.
**Blockers:** None.

---

## 2026-05-13: Shell + agent sessions launch via login + interactive bash (`-lic`)

**What changed:**
- Workflow SHELL session shell command switched from `exec <shell> --login` to `exec <shell> -li` (login + interactive). Updated terminal test assertion.
- Multmux wrapper v2 script (`~/workspace/multmux/src/hooks.ts`) now strips `npm_(config|lifecycle|package)_*` and runs the agent through `bash -lic 'exec "$@"' _ "$@"` so claude/codex see the same env as if launched from a terminal — sources `/etc/profile`, `~/.profile`, `~/.bashrc`, gets `SSH_AUTH_SOCK` (via keychain), full PATH (cargo, nvm, cuda), etc.

**Why:**
- Workflow-spawned claude/codex were missing user shell env (no SSH_AUTH_SOCK → `git push` failed; no PATH extensions → tools not found). The chain `workflow → multmux → tmux → /bin/sh -c → claude` skipped every shell init step. Wrapping the agent invocation in `bash -lic` is the simplest way to inherit the user's interactive-shell env without forcing them to maintain a parallel `~/.bash_env` for every tool.
- Picked `-lic` (over `-ic` / `-lc`) for unification: it covers macOS Terminal.app default + ssh login interactive default; honours `.bashrc` interactive guards (which `-lc` skips); and prefers "more env over less" so PATH-dependent tools just work. Same shape used for SHELL session (`-li`, no `-c` since bash drops into REPL).

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/__tests__/terminal.test.ts`, `~/workspace/multmux/src/hooks.ts` (separate repo), `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`.
**Verification:** `npx vitest run src/lib/__tests__/terminal.test.ts` → 18 passed. `bun test` in multmux → 251 passed. Live: spawned SHELL via API → `flags=himBHs`, `login_shell=YES`, `SSH_AUTH_SOCK` set, `npm_config` count = 0, `ssh-add -l` returns key. Wrapper probe in real tmux pane → `SSH_AUTH_SOCK`, `NVM_DIR`, full PATH (cargo/cuda/nvm/.local/bin) all present, no nvm warning.
**Commit:** `060c926` (workflow), `90a2796` (multmux).
**Next:** None.
**Blockers:** None.

---

## 2026-05-13: Local browser automation env for agent sessions

**What changed:**
- Moved browser automation defaults into the local `~/.bash_env` used by Workflow-launched non-interactive shells: Puppeteer points at `/usr/bin/google-chrome`, and Playwright uses `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` on this Ubuntu 26.04 machine.
- Documented the local env convention in the dev workflow guide.

**Why:**
- Playwright 1.59.1 does not recognize `ubuntu26.04-x64` for managed Chromium install/download, and Puppeteer-managed Chrome hits the local Chrome sandbox restriction. System Chrome works for Puppeteer, while the Playwright host-platform override keeps managed Chromium usable.
- Putting the values in `~/.bash_env` keeps this as local machine config while ensuring Workflow-spawned Claude/Codex multmux sessions inherit it.

**Key files:** `doc/dev/workflow.md`; local machine file `~/.bash_env`.
**Verification:** New multmux Codex session reported `BASH_ENV=/home/qiguo/.bash_env`, `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome`, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`, and passed a Playwright Chromium smoke test. New multmux Claude session reported the same env values and passed a Playwright Chromium smoke test.
**Commit:** `12ffebd`.
**Next:** None.
**Blockers:** None.

---

## 2026-05-12: HTML preview fragment links stay inside iframe

**What changed:**
- HTML preview now injects `<base href="about:srcdoc">` into documents that do not already define a `<base>` tag, so in-page links like `#s1` resolve to `about:srcdoc#s1` instead of the Workflow app URL.
- Moved srcdoc preparation into `ui/src/workspace/htmlPreviewSrcDoc.ts` and added unit coverage for head injection, existing base preservation, and fragment HTML.
- Added a Playwright regression spec for HTML preview fragment-link navigation.
- Updated the workspace editor/preview docs to describe the `about:srcdoc` base behavior and the remaining relative-asset limitation.

**Why:**
- In `srcdoc` iframes without a base tag, Chromium reports `document.baseURI` as the embedding page (`http://127.0.0.1:5173/`). A TOC link such as `href="#s1"` therefore navigated the iframe to `http://127.0.0.1:5173/#s1`, loading the Workflow app shell inside the sandbox. Because the sandbox has an opaque origin, Vite/app scripts were blocked by CORS and the iframe appeared white.

**Key files:** `ui/src/workspace/HtmlPreview.tsx`, `ui/src/workspace/htmlPreviewSrcDoc.ts`, `ui/src/workspace/__tests__/HtmlPreview.test.ts`, `ui/tests/e2e/html-preview.spec.ts`, `doc/main/ui/workspace/editor-and-preview.md`.
**Verification:** `cd ui && npx vitest run src/workspace/__tests__/HtmlPreview.test.ts` passed (3 tests). `cd ui && npx eslint src/workspace/HtmlPreview.tsx src/workspace/htmlPreviewSrcDoc.ts src/workspace/__tests__/HtmlPreview.test.ts tests/e2e/html-preview.spec.ts` passed. `cd ui && npx tsc --noEmit` passed. `npm run build` passed. Browser repro with system Chrome on `learn/flow_matching.html`: before fix `#s1` resolved to `http://127.0.0.1:5173/#s1`; after fix click leaves iframe at `about:srcdoc#s1`, title remains `Flow Matching · 一份可视化解读`, and `scrollY` becomes 817. Playwright runner could not execute the new e2e spec on this machine because its managed Chromium cache is missing and `npx playwright install chromium` reports this Playwright version does not support `ubuntu26.04-x64`.
**Commit:** pending.
**Next:** Optional — project-aware relative asset support via a file-serving base URL.
**Blockers:** None.

---

## 2026-05-12: Clean shell tmux env (nvm warning) + hide status bar

**What changed:**
- Shell session command wrapped to `unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}'); exec <shell> --login` so the new tmux pane no longer inherits the `npm_config_*` vars npm leaks when the server is launched via `npm run`.
- `buildChildProcessEnv()` (`server/src/lib/ssh-auth.ts`) now also strips those vars from the env passed to spawned children — defense-in-depth, though insufficient on its own because the long-running tmux server caches its initial env.
- `configureShellTmuxSession()` now also runs `tmux set-option -t =<name>: status off`, hiding the bottom status bar so the in-app terminal looks like a plain shell.

**Why:**
- nvm refuses to initialize when `npm_config_prefix` is set and prints a warning on every shell start. Stripping the env at the Node spawn level wasn't enough — `tmux new-session` inherits from the tmux server's cached env, not from the env we hand to spawn. Unsetting inside the shell command is the only reliable hook (tmux runs the string via `/bin/sh -c`).
- The status bar is noise in an in-app terminal where tab/title is already shown by the workspace UI.

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/ssh-auth.ts`, `server/src/lib/__tests__/ssh-auth.test.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`.
**Verification:** `npx vitest run src/lib/__tests__/{terminal,ssh-auth}.test.ts` → 22 passed. Live API probe: `POST /api/sessions/start {provider:"shell"}` → spawned tmux session has 0 `npm_config_*` vars, `bash -ic` loads nvm without warning, `tmux show-options -t <name> status` returns `status off`.
**Commit:** `751458b`.
**Next:** None.
**Blockers:** None.

---

## 2026-05-11: HTML preview for `.html`/`.htm` files

**What changed:**
- Added `HtmlPreview` (`ui/src/workspace/HtmlPreview.tsx`) — sandboxed iframe with `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`. Self-contained HTML (inline CSS/JS, data URIs, CDN assets) renders normally; relative asset URLs do not resolve (srcdoc has no base URL — deliberate scope cut).
- Generalized the markdown preview toggle so the same Edit/Split/Preview controls apply to `.html`/`.htm`. `Cmd+Shift+V` cycles modes for both.
- Renamed `mdMode` → `previewMode`, `MdMode` → `PreviewMode`, `MdModeToggle` → `PreviewModeToggle`, `canToggleMdMode` → `canTogglePreview`, `onMdModeChange` → `onPreviewModeChange`. Added `isHtmlFile`/`isMarkdownFile`/`isPreviewableFile` helpers in `ui/src/lib/binaryFiles.ts`. Dropped the legacy `previewMode: boolean` migration line in `usePersistence.ts`.
- `useWorkspaceVoice` now disables editor voice in preview-only mode for HTML too (not just markdown), via a generalized `isPreviewable` prop.

**Why:**
- HTML files only had source-code view. Previewing them rendered required exporting + opening in a browser. The same toggle UX as markdown is the obvious fit.
- Sandboxed iframe with `allow-scripts` only (no `allow-same-origin`) is the standard secure preview pattern: the document gets an opaque origin and cannot reach the parent app, localStorage, cookies, or our APIs.

**Key files:** `ui/src/workspace/HtmlPreview.tsx` (new), `ui/src/lib/binaryFiles.ts`, `ui/src/hooks/{workspaceTypes,useWorkspaceState,usePersistence}.ts`, `ui/src/workspace/{WorkspaceEditorArea,WorkspaceEditorColumn,WorkspaceTabBar,WorkspaceScreen,useWorkspaceKeyboard,useWorkspaceVoice}.tsx?`, `CLAUDE.md`, `doc/main/ui/workspace/editor-and-preview.md`.
**Verification:** `cd ui && npx tsc --noEmit` clean. `npm run lint` problem count unchanged from HEAD baseline (96/83/13). `npm run build` succeeded. Browser smoke: opened a test HTML file with inline CSS + a click-counter script — preview renders styled output, sandbox attrs verified (`allow-scripts`, `no-referrer`), in-iframe button click increments counter. Markdown regression check: `.md` still uses DOM `MarkdownPreview` (not iframe). Non-previewable file (`.json`) shows zero toggle buttons.
**Commit:** `9c7eadf`.
**Next:** Optional — relative-asset support via path-segment file endpoint + `<base href>` injection, if requested.
**Blockers:** None.



**What changed:**
- Workflow-managed shell tmux sessions now run `tmux set-option -t =<name>: mouse on` after creation and before attach.
- Existing shell sessions are upgraded on reconnect, so previously-created shells get the same behavior without being recreated.
- Added terminal unit coverage for mouse option setup and reattach-time setup. Updated backend and workspace terminal docs.

**Why:**
- Agent sessions already got `mouse on` from multmux, so wheel scrolling went through tmux copy-mode/history. Shell sessions created directly by Workflow did not, so wheel events in tmux's alternate screen were translated into shell readline Up/Down and cycled prompt history instead of scrolling pane history.

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/__tests__/terminal.test.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`.
**Verification:** `TMPDIR=server/.tmp npm test -- terminal.test.ts` passed (18 tests). Live API probe created `shell-mouse-live-*` and confirmed `tmux show-options -t =<name>: -v mouse` returned `on`. Existing live `shell-2` was also updated to `mouse=on`.
**Commit:** pending.
**Next:** None.
**Blockers:** None.

## 2026-05-11: Shell exit now removes tmux-backed shell sessions immediately

**What changed:**
- Added `reconcileShellSessionExit()` for Workflow-managed shell sessions and call it from the terminal WebSocket PTY `onExit` path.
- When a shell exits from inside tmux, Workflow now checks `tmux has-session`; confirmed-missing shell sessions have their ownership state removed and emit `refresh:sessions`. Plain attach detach keeps state because the tmux session is still live.
- Added terminal unit coverage for both shell-exit cleanup and detach-with-live-session preservation. Updated backend and workspace terminal docs.

**Why:**
- After shell sessions moved to tmux-backed persistence, typing `exit` ended the tmux session but left `~/.workflow/shell-sessions/<name>.json` until the next `/api/sessions` poll. The UI kept showing the dead shell row until that refresh happened.

**Key files:** `server/src/lib/terminal.ts`, `server/src/index.ts`, `server/src/lib/__tests__/terminal.test.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`.
**Verification:** `TMPDIR=server/.tmp npm test -- terminal.test.ts` passed (17 tests). Real WebSocket repro on a temporary updated server and the live `:3001` server: before the fix, `exit` produced `ws_close 4001`, `tmux_after_exit 1`, and `state_after_ws_close_without_sessions_get true`; after the fix the same flow ends with `state_after_ws_close_without_sessions_get false`.
**Commit:** pending.
**Next:** None.
**Blockers:** None.

## 2026-05-11: Shell sessions move to tmux-backed persistence

**What changed:**
- Replaced in-process shell PTYs with Workflow-managed tmux sessions. Shell ownership state now lives in `~/.workflow/shell-sessions/<name>.json`, while browser attach/detach uses temporary `tmux attach-session` PTYs just like agent sessions.
- Added robust shell state handling: atomic state writes, filename/name validation, stale-state pruning only for confirmed-missing tmux sessions, and preservation of state when tmux liveness is unknown.
- Expanded terminal unit tests for shell lifecycle, tmux failure handling, arbitrary tmux protection, and invalid state files. Updated backend/UI/data-model docs and the active design summary.

**Why:**
- Direct shell PTYs were owned by the Workflow server process, so server restart lost the shell. Tmux-backed shells match the Claude/Codex persistence model and survive server restarts without adding shell sessions to multmux.

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/__tests__/terminal.test.ts`, `projects/active/tmux-shell-sessions/*`, `doc/main/backend/{libs,server,routes}.md`, `doc/main/ui/workspace/sessions-and-terminal.md`, `doc/main/data-model/{overview,api-contracts}.md`, `CLAUDE.md`.
**Verification:** `TMPDIR=server/.tmp npm test -- terminal.test.ts` passed (15 tests). Real tmux QA smoke passed for start/list/close and fresh-process restart persistence. `npm run build` passed. Full `cd server && npm test` with `GROQ_API_KEY=` still has one unrelated pre-existing flaky real-tmux tap test (`wechat-pty-tap.test.ts` missing `line 5`).
**Commit:** 2f1bad3.
**Next:** None for this scope.
**Blockers:** None.

## 2026-05-10: BASH_ENV wiring — services pick up shell env without sourcing bashrc

**What changed:**
- Added `Environment="BASH_ENV=%h/.bash_env"` to both systemd unit templates and a `BASH_ENV=$HOME/.bash_env` key to the macOS launchd plist template in `scripts/services.sh`.
- Convention: env-only exports (cproxy / API keys / future workflow-specific vars) live in `~/.bash_env`; `~/.bashrc` sources it from the very top so interactive shells see the same vars.

**Why:**
- After switching the dev runner from `dev-tmux.sh` to systemd / launchd (commit `58e1f1e`), `workflow-server` no longer inherited the cproxy / `OPENAI_API_KEY` / `ANTHROPIC_BASE_URL` exports the user kept in `~/.bashrc`. The unit was started by `systemd --user` before any login shell, so PAM-level env was the only inheritance path.
- Sourcing `~/.bashrc` directly didn't help — it has the standard `case $- in *i*) ;; *) return;; esac` guard near the top, which exits before reaching the exports for non-interactive shells.
- `BASH_ENV` is exactly designed for this: bash auto-sources it in non-interactive non-login mode. Setting it in the unit/plist makes both the workflow-server itself AND every non-interactive bash it later spawns (multmux's `wrapper-v2.sh`, the agent process tree) pick up the env without any further wrapping.

**Key files:** `scripts/services.sh` (template additions only). Per-machine: `~/.bash_env` (env exports), `~/.bashrc` (one-line source at top), and the running unit/plist (manually patched for already-installed services).
**Verification:** Desktop — restarted `workflow-server.service`, spawned a fresh `claude` session via multmux, confirmed the wrapper PID's `/proc/<pid>/environ` has `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (came from auto-sourcing `~/.bash_env`). Pre-existing tmux sessions survived the restart (cgroup escape from the multmux side still works).
**Commit:** 3cd4589.
**Next:** None — future fresh installs (`scripts/services.sh install`) will set `BASH_ENV` automatically on either OS.
**Blockers:** None.

## 2026-05-09: services.sh adds UTF-8 locale on macOS launchd plist

**What changed:**
- macOS launchd plist template now also writes `LANG=en_US.UTF-8` and `LC_CTYPE=en_US.UTF-8` into `EnvironmentVariables`.

**Why:**
- launchd doesn't inherit a login shell's locale, so the workflow server (and every claude/codex it spawned via multmux+tmux) ran with no `LANG`. Multi-byte UTF-8 output from the agents was then mangled into placeholder bytes that rendered as underscores in the xterm view — visible as "中文显示成 `___`" on the laptop.
- Linux/systemd inherits `LANG` from the user manager's environment, so the systemd template was already fine.

**Key files:** `scripts/services.sh` (macOS branch only).
**Verification:** Patched the running laptop plist with PlistBuddy + reload; user confirmed CJK and special characters now render correctly in fresh sessions.
**Commit:** ddba50f.
**Next:** None.
**Blockers:** None.

## 2026-05-09: services.sh PATH fix — include ~/.local/bin, prefer Homebrew on Apple Silicon

**What changed:**
- `scripts/services.sh` now writes `~/.local/bin` into the `PATH` of every generated systemd unit and launchd plist. Previously the templates only had `$node_bin_dir:/usr/local/sbin:...:/usr/bin:/sbin:/bin` (Linux) or `$node_bin_dir:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` (macOS) — so `multmux`, `claude`, and `codex` (all installed under `~/.local/bin`) were invisible to the workflow server.
- macOS template additionally swaps the order to `/opt/homebrew/bin` *before* `/usr/local/bin`, so Apple Silicon Macs don't accidentally pick up stale Intel Homebrew binaries.

**Why:**
- After reinstalling the desktop and on the laptop both, `POST /api/sessions/start` returned `"timeout waiting for session tmux process"`. Root cause: `spawn multmux ENOENT` — the workflow server inherits the service's `PATH`, which didn't include `~/.local/bin`. The error was swallowed because the `spawn` had no `error` listener; it only surfaced as a multmux start timeout downstream.
- On the laptop the same template made the service pick `/usr/local/bin/tmux` (a 2015 Intel Cellar build referencing `libevent-2.0.5.dylib` that no longer exists) over the working `/opt/homebrew/bin/tmux 3.6a`. Reordering fixes this independent of the `~/.local/bin` issue.

**Key files:** `scripts/services.sh` (template literals only).
**Verification:** Patched both running units in place (Linux: edited `~/.config/systemd/user/workflow-server.service`; macOS: PlistBuddy patch on both LaunchAgents) and confirmed `POST /api/sessions/start` returns `{"name":"smoke"}` with a valid state file under `~/.multmux/sessions/`.
**Commit:** f190662.
**Next:** None for the script itself. Future fresh installs (`scripts/services.sh install`) on either OS will pick up the correct PATH automatically.
**Blockers:** None.

## 2026-05-09: scripts/services.sh goes cross-platform (Linux + macOS)

**What changed:**
- `scripts/services.sh` now detects the OS and dispatches to systemd (Linux) or launchd (macOS). Same UX (`status`/`start`/`stop`/`restart`/`logs`/`enable`/`disable`) on both.
- New `services.sh install` subcommand generates the unit files (Linux: `~/.config/systemd/user/workflow-{server,ui}.service`) or LaunchAgent plists (macOS: `~/Library/LaunchAgents/com.workflow.{server,ui}.plist`) using paths/Node binary detected at install time, then loads and starts them.
- macOS LaunchAgent plists set `KeepAlive { SuccessfulExit: false }` (restart on crash, not on clean exit) and log to `~/Library/Logs/workflow-{server,ui}.log`. `services.sh logs` `tail -F`s those files.
- Updated `doc/dev/workflow.md` to document both platforms in one section.

**Why:**
- Laptop (macOS) was running workflow as a stack of orphaned `tmux` + `npm run start:app` + bare `npm run dev` invocations, none auto-restarting, racing for ports 3001/5173. Wanted the same auto-restart + log-to-disk behavior as the desktop without forking the script.
- One file, OS detection inside, beats two scripts that drift.

**Key files:** `scripts/services.sh` (new install + macOS branches), `doc/dev/workflow.md` (cross-platform section). Plist/unit files generated per machine; not committed.
**Verification:** On laptop after `scripts/services.sh install`: both services `state = running`, ports 3001 + 5173 listening, `https://laptop.tailnet-example.ts.net/` returns HTTP 200. Tailscale serve was already configured pre-change.
**Commit:** pending.
**Next:** None — both machines now uniform.
**Blockers:** None.

## 2026-05-09: Workflow as systemd services + Tailscale serve

**What changed:**
- Workflow dev servers now run as two systemd user services on the desktop machine: `workflow-server.service` (`tsx watch`) and `workflow-ui.service` (`vite`). Both auto-start at boot via `loginctl enable-linger qiguo`.
- Removed `scripts/dev-tmux.sh` and the `npm run dev:tmux` script. Tmux added a process layer between systemd and the dev servers (crashes invisible to systemd, logs trapped in the pane).
- New `scripts/services.sh` wraps `systemctl --user` for both services (`status`/`start`/`stop`/`restart`/`logs`/`enable`/`disable`).
- UI exposed at `https://desktop.tailnet-example.ts.net/` via `tailscale serve --bg --https=443 http://127.0.0.1:5173`. `tailscale set --operator=$USER` lets the user manage serve without sudo.

**Why:**
- After reinstalling the desktop on Ubuntu 26.04 we wanted workflow accessible from the laptop's browser without manually starting it. Tmux-in-systemd hid crashes and serialized two real workloads behind a single Active: active line; two real units give native restart, journal logs, and per-unit status.
- Removing the tmux script also fixed a regression where the panes hung at a keychain passphrase prompt because systemd-spawned bash had no TTY (root cause patched separately by adding `--noask --quiet` to the keychain call in `~/.bashrc` on the desktop).

**Key files:** `package.json` (dropped `dev:tmux`), `scripts/services.sh` (new), `scripts/dev-tmux.sh` (removed), `CLAUDE.md`, `doc/dev/workflow.md`. Service unit files live in `~/.config/systemd/user/` on the desktop, not in the repo.
**Verification:** `curl -s -o /dev/null -w '%{http_code}\n' https://desktop.tailnet-example.ts.net/` returns 200 after a reboot, with both services active and ports :3001 / :5173 listening. `scripts/services.sh status` reports both green.
**Commit:** pending.
**Next:** Decide whether to ship `start:app` (production build, single-origin :3001) as the long-running mode for the laptop too — current dev mode keeps `tsx watch` + Vite hot-reload running idle.
**Blockers:** None.

# Progress

## 2026-05-08: /file -t flag for inline text replies

**What changed:**
- `/file <path>` (and alias `/f`) now accepts a `-t` flag: with `-t` the file is decoded as UTF-8 and returned inline as text with a `--- <path> (N lines, M bytes) ---` header, capped at 32 KB. Binary files in `-t` mode are rejected with a hint to drop `-t`. Without `-t` the existing attachment behavior is unchanged (≤5 MB).

**Why:**
- Short text files are nicer to read inline in the chat than to round-trip through WhatsApp's document viewer (tap → open → scroll → close). Attachments stay the default for binaries, large files, and "save it locally" cases; `-t` is the explicit ask for "just paste it here".

**Key files:** `server/src/lib/channels/router.ts` (handleFile arg-parses `-t`, FILE_TEXT_MAX_BYTES, looksBinary helper re-added), `server/src/lib/__tests__/wechat-router.test.ts` (2 new tests), `doc/main/backend/libs.md`.
**Verification:** `cd server && npm test` — 244 tests passing (+2).
**Commit:** a8e33b8 — pushed.
**Next:** Live-test `/f -t doc/PROGRESS.md`, `/f -t package.json`. Decide whether `-t` should grow `:line-line` range support for big files.
**Blockers:** None.

## 2026-05-08: /file command — read a file as a WhatsApp attachment, list a directory as text

**What changed:**
- New `/file <path>` channel command (alias `/f`). Resolves the path against the bound multmux session's `sessionPath` (worktree-aware; falls back to project root) and rejects anything that escapes that root. Files come back as **real attachments** (≤5 MB cap); directories come back as a text listing (`d <name>` / `f <name>`, dirs first, capped at 200 entries with `[…N more]`).
- `ReplyCallback` contract widened from `(text: string) => Promise<void>` to `(reply: ChannelReply) => Promise<void>` where `ChannelReply` is a discriminated union: `{kind:'text', text}` or `{kind:'file', path, filename, caption?}`. `dispatch()` now returns `ChannelReply` so command handlers pick the right shape; a `textReply()` helper keeps prose call sites tidy.
- WhatsApp adapter switches on `reply.kind` — text → `msg.reply(text)`; file → `MessageMedia.fromFilePath(path)` + caption. Files arrive natively (paperclip / inline image preview / PDF tap-to-open), no inline-text fallback.
- WeChat adapter (no media in the SDK contract) degrades file replies to `[附件: filename]` placeholders inside the joined text response.
- Removed the binary-file rejection and the 32 KB inline cap — both were artifacts of the inline-text first-pass `/file` and stop making sense once attachments exist.

**Why:**
- Pasting source files inline is unreadable on a phone (no syntax highlighting, no tap-to-open) and bypasses WhatsApp's native viewers for images / PDFs / archives. Native attachments are the right surface; the inline path was a stepping-stone we no longer need.
- Discriminated-union replies are the smallest contract change that lets the router emit non-text payloads without leaking channel-specific types into the shared core; channels that can't speak the kind degrade locally (wechat → placeholder) without forking the router.

**Key files:** `server/src/lib/channels/router.ts` (ChannelReply union, /file handler, dispatch return type), `server/src/lib/whatsapp/index.ts` (MessageMedia branch + caption dedup), `server/src/lib/wechat/{router,agent}.ts` (file → `[附件:…]` placeholder), `server/src/lib/__tests__/wechat-router.test.ts` (`dispatchText()` unwrap helper, attachment-shape assertions for /file), `doc/main/backend/libs.md`.
**Verification:** `cd server && npm test` — 21 files / 242 tests passing. Two new /file tests (text-file + binary-file both produce `kind:'file'`); existing dispatch-text assertions ported through the `dispatchText()` helper.
**Commit:** baf68df, 6f3d624 — pushed.
**Next:** Live-test on WhatsApp: send `/file ui/src/App.tsx`, `/file <some-image.png>`, `/file <some-dir>`. Decide whether `/file` should grow `:line-line` range support for huge files (currently rejected at 5 MB).
**Blockers:** None.

## 2026-05-08: Channel polish — slash-command passthrough, streaming replies, AskUserQuestion handling, /last via multmux capture

**What changed:**
- `channels/router.ts`: `KNOWN_COMMANDS` whitelist gates dispatch — unknown `/xxx` (e.g. `/scope-review`, `/design`, `/investigate`) falls through to the bound agent verbatim instead of returning `unknown command`.
- `channels/agent-output.ts`: replaced single-shot `awaitFinalReply` with `streamAgentReply(turn, opts)` async generator yielding `{kind: 'interim'|'question'|'final'|'timeout', text}` events. Claude: `assistant` content `text` blocks with `stop_reason='tool_use'` → `interim`; `AskUserQuestion` tool_use → `question`; `stop_reason='end_turn'` → `final`. Codex: `event_msg/agent_message` `phase='commentary'` → `interim`; `phase='final_answer'` → `final`. `thinking`, other `tool_use`/`tool_result`, `response_item`, `function_call`, `token_count` all skipped. `awaitFinalReply` kept as a thin back-compat shim.
- New `channels/keys.ts` exports `sendEscape(handle)` (`tmux send-keys -t <handle> Escape` — single Esc only; double-Esc opens Claude's backtrack dialog). Wired so when `streamAgentReply` detects `AskUserQuestion`, it cancels the TUI dialog before yielding the formatted prompt to the channel — the user can answer through WhatsApp/WeChat as a normal next-turn message instead of needing the TUI.
- `router.handleMessage(ctx, text, onReply)` and `passthroughText` now take a `ReplyCallback`; one user turn produces multiple `onReply` calls (interim text, question prompt, final answer). WhatsApp handler calls `msg.reply()` per chunk inside the existing `serialize()` queue. WeChat adapter aggregates chunks into one `\n\n`-joined string because the SDK is request/response.
- `multmux.captureSession(handle, lines)` shells out to `multmux capture --lines n --strip-ansi true`. `/last` now takes an optional line count (default 100, max 2000) and reads tmux scrollback directly — works regardless of whether a channel tap was previously acquired. Dropped the now-dead `pty-tap.tailSlice` + `TAIL_BYTES`. Tap module stays for the JSONL fallback (`passthroughViaTap`) which needs offset semantics `multmux capture` doesn't provide.

**Why:**
- Long agent turns made the channel feel dead — user sat through 60-90s of nothing then got one wall of text. Claude/Codex already emit interim text blocks while doing tool use; surfacing them as separate replies turns dead time into incremental progress.
- `AskUserQuestion` deadlocked the channel: the TUI dialog blocks `end_turn` indefinitely, the channel timed out at 2 min, and the user couldn't reach the TUI from a phone. Auto-canceling the dialog + surfacing the question text lets the user answer through the same channel.
- Unknown `/xxx` returning `unknown command` blocked Claude/Codex's own slash-command surface (e.g. `/scope-review`). The fix is a whitelist of channel commands; everything else passes through.
- The in-memory tap-tail powering `/last` was awkward: `/last` only worked AFTER a tap was acquired (so brand-new bindings got nothing), and 8KB of bytes is less intuitive than N lines. `multmux capture` is the natural API and removes one piece of process state.

**Key files:** `server/src/lib/channels/{router,agent-output,pty-tap,keys}.ts`, `server/src/lib/multmux.ts`, `server/src/lib/whatsapp/index.ts`, `server/src/lib/wechat/{router,agent}.ts`, `server/src/lib/__tests__/{agent-output,wechat-router,wechat-pty-tap}.test.ts`, `doc/main/backend/libs.md`.
**Verification:** `cd server && npm test` — 21 files / 238 tests passing (was 20/230 before the batch; +1 file +9 streaming/AskUserQuestion tests, -1 dead `tailSlice` test). Two parallel worktrees used for orthogonal slices, merged with one trivial `handleMessage` conflict resolved by combining the whitelist + callback signature.
**Commit:** b0fc384, bc3cef1, 0dc81fc (merge), ba8ba70 (merge), 3eb9a73 — pushed.
**Next:** Live-test streaming replies + AskUserQuestion auto-cancel end-to-end on a real WhatsApp conversation. Decide whether to expose `thinking` blocks behind a `/verbose` toggle (currently hard-skipped).
**Blockers:** None.

## 2026-05-08: WhatsApp channel + JSONL-based agent reply extraction

**What changed:**
- Refactored `server/src/lib/wechat/` so all channel-agnostic pieces live in `server/src/lib/channels/`: `createBindingStore(scope)`, `createAuthStore(scope, envKey)`, `createRouter(store)`, plus the existing `pty-tap.ts`. WeChat's modules became thin adapters over the factories. No behavior change for the WeChat path.
- Added a parallel WhatsApp channel under `server/src/lib/whatsapp/` using `whatsapp-web.js` (puppeteer-driven WhatsApp Web client with `LocalAuth` session persistence). Env-gated by `WHATSAPP_ENABLED=1`.
- New routes `GET /api/whatsapp/status`, `POST /api/whatsapp/login`, `POST /api/whatsapp/logout`. The same `WeChatLoginDialog` UI was generalized into an internal `ChannelLoginDialog` and re-exported as `WeChatHeaderButton` + `WhatsAppHeaderButton` — header shows whichever channels have `*_ENABLED=1`.
- Replaced the tap-based passthrough with **JSONL-based agent-output extraction** (`channels/agent-output.ts`). On send, record the agent's session JSONL file size; after send, poll the file from that offset and extract the agent's final answer text — claude via `assistant` entries with `message.stop_reason='end_turn'`, codex via `event_msg/agent_message` with `phase='final_answer'`. Tap is kept as a fallback when the JSONL log can't be located, and as the source for the `/last` command.
- WhatsApp self-chat enforcement: bot listens on `message_create` (not `message`) and only acts on `msg.fromMe`. Body-content dedup with mark-BEFORE-await prevents the message_create-fires-before-reply-resolves loop. TOFU-binds the first chat the user types in, persisted to `~/.workflow/whatsapp-auth.json`. Env override `WHATSAPP_CHAT_JID` available.
- `.gitignore`: added `.wwebjs_cache/`, `.wwebjs_auth/`, `.playwright-mcp/`.

**Why:**
- WhatsApp is the practical channel for in-flight messaging on US carriers' free WiFi (WhatsApp is whitelisted; Telegram is not). Author's WeChat account is international (non-+86) and is rejected by Tencent's iLink Bot API. WhatsApp lets the same workflow get used from a phone with no separate bot account or paid relay.
- Tap-based capture pulled the entire pane byte stream between send and idle; on Claude Code / Codex TUIs that means input-box borders, status bars, separator lines, the user's input echo, and tool-call rendering. Even after ANSI strip the result was unreadable. LLM post-processing was a band-aid on the wrong source. The agents already produce a structured JSONL turn log — read THAT and the result is exactly what the agent said, in the same language, with zero noise.
- WhatsApp has no separate bot identity (bot = user's account). Self-chat enforcement is the only way to keep the bot from auto-replying to every contact who messages the user.

**Key files:** `server/src/lib/channels/{state,auth,router,pty-tap,agent-output}.ts`, `server/src/lib/whatsapp/{index,state,auth}.ts`, `server/src/routes/whatsapp.ts`, `server/src/index.ts`, `ui/src/components/WeChatLoginDialog.tsx` (generalized), `ui/src/App.tsx`, `doc/main/backend/{routes,libs}.md`, `.gitignore`. Design ref `projects/active/wechat/design.md` (still the canonical channel architecture; the WhatsApp adapter follows the same shape).
**Verification:** `npm test` 230/230. Manual: `WHATSAPP_ENABLED=1` server boots, dialog shows QR ASCII, scan via WhatsApp → Settings → Linked Devices succeeds, TOFU auto-restores binding from `~/.workflow/whatsapp-auth.json` on subsequent boots. Live test: WhatsApp self-chat → "Hi" forwards to bound `codex-backtest` → reply is exactly `Hi. What do you want to work on next?` (no TUI noise).
**Commit:** c2c7386, 7bbae32, a7d23ab, 750fa7f, 0532973
**Next:** Phase 5 (progressive push during long turns — flusher every 15s); revisit memory pointer for WhatsApp now that real-world usage is live.
**Blockers:** None for V1. Note `whatsapp-web.js` uses puppeteer + Chromium — first install pulls ~200MB.

## 2026-05-08: WeChat integration (V1)

**What changed:**
- New `server/src/lib/wechat/` subsystem (state, auth, router, agent, pty-tap, login-flow, index) bridges WeChat ↔ multmux agent sessions via `weixin-agent-sdk`. Env-gated by `WECHAT_ENABLED=1` — when unset, server behavior is bit-identical to prior main.
- Slash commands: `/help`, `/who`, `/projects` (`/p`), `/use <project>`, `/sessions` (`/s`), `/use s <n>`, `/new <claude\|codex> [name]`, `/exit`, `/last`. Plain text forwards to the bound multmux session and replies with the captured response.
- Auth: env whitelist (`WECHAT_CONVERSATION_WHITELIST`) OR TOFU first-contact bind to `~/.workflow/wechat-auth.json`. Atomic check-and-bind (race-safe).
- Tap mechanism: `tmux pipe-pane -O -t <handle> 'cat > FIFO'` + spawned cat reader → 1MB ring buffer per handle. Offset-based slicing captures the precise reply for a turn (vs `multmux capture` which only returns a snapshot). Sweeps orphan FIFOs on boot.
- New routes: `GET /api/wechat/status`, `POST /api/wechat/login`, `POST /api/wechat/login/reset`, `POST /api/wechat/logout`. Login is single-flight (synchronous slot claim). `/logout` returns 409 if a login is mid-flight.
- New UI: `WeChatLoginDialog` + `WeChatHeaderButton` only render when server reports `WECHAT_ENABLED=1`. The QR is captured by monkey-patching `console.log` for the duration of the SDK call (the SDK's `login()` doesn't expose the QR URL via its log callback) and rendered as ASCII in a monospace `<pre>`.

**Why:**
- Reach a running Claude/Codex session from the phone over WeChat without opening the web UI. Single-user, single-device. Outbound notifications + media are deferred to V2.
- The SDK's `login()` only exposes the QR ASCII via its internal `console.log(qr)`; the URL goes to its private logger. Capturing console.log is the lowest-risk way to surface a scannable artifact in the UI without reimplementing the SDK's auth flow.

**Key files:** `server/src/lib/wechat/{index,agent,router,state,auth,pty-tap,login-flow}.ts`, `server/src/routes/wechat.ts`, `server/src/index.ts`, `server/package.json`, `ui/src/components/WeChatLoginDialog.tsx`, `ui/src/App.tsx`, `doc/main/backend/{routes,libs}.md`, design at `projects/active/wechat/{design.md,cn/design.md}`
**Verification:** `npm test` 230/230 pass (38 new wechat tests covering state, auth, router, pty-tap with real tmux, /new happy path with mocked spawn). Server boots clean with and without `WECHAT_ENABLED=1`. `POST /api/wechat/login` confirmed to capture QR ASCII end-to-end via curl. Concurrent `POST /login` calls correctly reuse the in-flight flow (same `startedAt` returned). `POST /logout` returns 409 while a login is in progress.
**Commit:** 7e09e2d (phase 1: SDK boot + read-only commands), e74ee83 (phase 2: pty tap + chat passthrough), d85a6a7 (phase 3: /new), 4c92cf5 (phase 4: QR login UI)
**Next:** Phase 5 (progressive push during long turns — same tap infra + bot.sendMessage flusher), Phase 6 (outbound notifications via `notify.ts` sink, separate project). Tool-noise cleanup TBD after observing real-world usage.
**Blockers:** None for V1. Note that `weixin-agent-sdk` declares `engines.node>=22` but works on Node 20.20.1 with `--engine-strict=false`; revisit if SDK adds Node 22-only APIs.

## 2026-05-01: Unblock event loop in server hot paths

**What changed:**
- `routes/git.ts`: replaced `spawnSync` with async `execFile` across all 8 git endpoints. `/status` now runs `git status` + `diff --shortstat` in parallel; `/refs` runs `branch` + `tag` + `log` in parallel. Concurrent `/status` requests share one in-flight subprocess via per-project Map.
- `lib/worktree.ts`: `getWorktreeStatuses` calls `git worktree list` once per project instead of once per slug, sharing the registered set.
- `lib/multmux.ts`, `session-summary.ts`, `history.ts`, `project-watcher.ts`: hot-path sync FS calls (`readFileSync`/`readdirSync`/`statSync`/`openSync`) → `fs/promises`. `resolveSessionSummaries` resolves Claude+Codex summaries in parallel.
- `lib/session-names.ts`: deleted dead `resolveTmuxSession` (unused `execSync('tmux …')`).

**Why:**
- Task tab loaded slowly on the desktop because every git endpoint blocked Node's event loop with `spawnSync`. Under desktop load (15+ agents, 2 emulators, gradle daemons), each subprocess fork took 30–100ms and serialized all concurrent requests. The laptop felt fast because lower system contention masks the same blocking; the underlying code was buggy on both.

**Key files:** `server/src/routes/git.ts`, `server/src/lib/worktree.ts`, `server/src/lib/multmux.ts`, `server/src/lib/session-summary.ts`, `server/src/lib/history.ts`, `server/src/lib/project-watcher.ts`, `server/src/lib/session-names.ts`, `server/src/routes/sessions.ts`
**Verification:** `npm test` 190/190 pass; `tsc --noEmit` clean for changed files. Live perf: 5 concurrent `/api/git/.../status` go from serialized 5×100ms to shared 1×154ms; `/api/projects` no longer blocks behind a running git status.
**Commit:** fb6e5ee
**Next:** None
**Blockers:** None

## 2026-04-24: Fix mobile viewport jump on session rename

**What changed:**
- Session rename input uses `focus({ preventScroll: true })` to prevent aggressive browser scroll
- Delayed `scrollIntoView({ block: 'nearest' })` (400ms) runs after keyboard animation so input scrolls into the correct post-keyboard visible area

**Why:**
- On mobile, focusing the rename input triggered the browser's default scroll-to-focused-element, pushing the layout up with a big blank space. Same root cause as the terminal paste input viewport jump.

**Key files:** `ui/src/workspace/WorkspaceSessionList.tsx`
**Verification:** `tsc --noEmit` clean
**Commit:** dd052c0
**Next:** None
**Blockers:** None

## 2026-04-24: Mobile terminal paste/type input

**What changed:**
- Added paste/type textarea to `TerminalKeyBar` — bypasses xterm.js's broken mobile paste (hidden textarea at z-index:-5 that mobile browsers can't interact with)
- Textarea always mounted in DOM (h-0 when closed) for synchronous `focus({ preventScroll: true })` — required for mobile keyboard activation without viewport jump
- Paste toggle button in primary row becomes "Send" (accent color) or "Close" contextually
- Moved Ctrl modifier from primary to secondary row (groups all modifiers: Ctrl, Shift, Meta)
- Removed `^` label from secondary row (redundant with Ctrl button)
- Buttons changed from `min-w-[32px]` to `flex-1` for adaptive full-width layout

**Why:**
- Mobile users had no way to paste text into terminal — xterm's hidden textarea doesn't receive paste events on mobile. Previous workaround (voice input's ComposeTray textarea) broke when voice was disabled.

**Key files:** `ui/src/components/TerminalKeyBar.tsx`
**Verification:** `tsc --noEmit` clean, `eslint` clean, manual mobile testing
**Commit:** 730dfd1
**Next:** None
**Blockers:** None

## 2026-04-24: Mobile landscape layout with collapsible nav

**What changed:**
- `useIsMobile()` detects landscape phones via `(max-height: 500px) and (pointer: coarse)` — prevents phones (width 780–932px) from getting desktop layout
- `useIsLandscape()` hook selects between portrait and landscape mobile layouts
- `LandscapeNav` component: floating toggle button in left margin, horizontal nav panel expanding right with 4 pane icons. Bell + theme toggle positioned in the right margin (symmetric layout)
- Equal left/right margins via `max(env(safe-area-inset-left), env(safe-area-inset-right), 36px)`. Icons at inner margin edge to clear iPhone rounded corners (`top: max(safe-area-inset-top, 24px)`)
- App.tsx banners use `useIsMobile()` hook instead of CSS `hidden md:flex`
- Portrait PaneSwitch gets matching lucide icons (FolderOpen, FileCode, ListTodo, SquareTerminal)
- Portrait top bar padding increased (`py-0.5` → `py-2`) for better tap targets
- TerminalKeyBar bottom safe area padding halved (`/ 2`) to redistribute space to top bar
- Extracted `useMediaQuery` helper in `useIsMobile.ts`

**Why:**
- Modern phones in landscape got desktop multi-panel layout squeezed into 375–430px height
- Landscape vertical space is precious — collapsible nav reclaims the 28px top bar
- iPhone Dynamic Island and rounded corners require safe area–aware positioning

**Key files:** `ui/src/components/LandscapeNav.tsx` (new), `ui/src/components/PaneSwitch.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `ui/src/hooks/useIsMobile.ts`, `ui/src/App.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** All three modes verified in Playwright — desktop (1200×800), portrait mobile (393×852), landscape mobile (667×375). TypeScript clean, lint clean (no new errors)
**Commit:** dc687d1
**Next:** Test on real iPhone to verify Dynamic Island safe area positioning and `pointer: coarse` landscape detection
**Blockers:** None

## 2026-04-24: Add Meta/⌘ modifier and workspace shortcut interception

**What changed:**
- Added ⌘ (Meta) sticky modifier toggle to key bar row 2 alongside Shift
- Meta+key sends ESC prefix (`\x1b` + char) to terminal, enabling shortcuts like Meta+T (toggle Claude Code thinking)
- Meta+P and Meta+B are intercepted before reaching terminal — they dispatch synthetic `KeyboardEvent` with `metaKey: true` to trigger workspace quick-open search and sidebar toggle respectively
- `applyModifiers` returns `null` for intercepted combos; all three call sites (`resolveKeyBarInput`, `onData`, IME handler) skip WebSocket send on null

**Why:**
- Mobile has no physical Meta/Cmd key, so Claude Code's Meta+T shortcut was inaccessible
- Virtual Meta modifier can't set `KeyboardEvent.metaKey` on iOS keyboard input, so workspace shortcuts (Cmd+P, Cmd+B) need explicit interception with synthetic event dispatch

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/__tests__/TerminalKeyBar.test.tsx`
**Verification:** 30 tests pass, manual test on iOS Chrome via Tailscale
**Commit:** 6810015, 58457c5
**Next:** None
**Blockers:** None

## 2026-04-24: Fix PWA app icons for iOS home screen

**What changed:**
- Regenerated `apple-touch-icon.png` (180×180), `icon-192.png`, `icon-512.png` — bolt centered at ~65% canvas on solid `#eee8d5` background
- Added `sizes="180x180"` to `<link rel="apple-touch-icon">` in `index.html`

**Why:**
- Icons were rendered at native 48×46px in the top-left corner of the canvas, leaving the rest transparent. iOS fills transparent areas with white, so the home screen icon appeared as a tiny purple speck on a white square.

**Key files:** `ui/public/apple-touch-icon.png`, `ui/public/icon-192.png`, `ui/public/icon-512.png`, `ui/index.html`
**Verification:** Visual inspection of generated PNGs
**Commit:** ecfbb39
**Next:** None
**Blockers:** None

## 2026-04-24: Redesign terminal key bar + fix iOS touch handling

**What changed:**
- Redesigned key bar layout: Row 1 = Ctrl, Esc, Tab, PgUp, PgDn, Enter, arrows. Row 2 = Shift, ^C/D/B/O/A/E/U/K/W
- Added PgUp/PgDn for scrolling Claude Code fullscreen TUI history on mobile
- Added Ctrl+K (kill to EOL), removed Ctrl+R/L/Z
- Fixed Ctrl, Shift, and expand buttons not responding on iOS Safari — switched from `onClick` to `onPointerDown` (parent `onMouseDown={preventDefault}` was suppressing the touch→click chain)
- Fixed modifier active state not showing on iOS — switched from CSS variable class to hardcoded solarized blue (`#268bd2`)
- Resolved pre-existing TypeScript build errors across 7 files

**Why:**
- Key layout optimized for Claude Code + Codex + tmux workflow (most frequent keys in row 1)
- PgUp/PgDn needed because `CLAUDE_CODE_SCROLL_SPEED` env var only affects mouse wheel, not touch scroll — PgUp/PgDn is the only way to fast-scroll through fullscreen TUI history on mobile
- iOS Safari's simulated mousedown/click chain after touch is suppressed by `preventDefault()` on the parent's mousedown handler (originally added to prevent xterm focus loss). `onPointerDown` fires before this chain and works reliably

**Key files:** `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/__tests__/TerminalKeyBar.test.tsx`
**Verification:** 28 tests pass (`npx vitest run src/components/__tests__/TerminalKeyBar.test.tsx`), manual verification on iOS Chrome via Tailscale
**Commit:** ebd7921, 44e375e
**Next:** None
**Blockers:** None

## 2026-04-23: fix iOS Safari auto-zoom on input focus

**What changed:**
- Added CSS rule in `index.css` forcing `font-size: 16px` on all `input`, `textarea`, `select` elements, scoped to iOS touch devices via `@media (pointer: coarse)` + `@supports (-webkit-touch-callout: none)`.

**Why:**
- Every input in the app had font-size 10–13px. iOS Safari auto-zooms the viewport when an input with `font-size < 16px` receives focus, pushing surrounding elements off screen. The CSS-only fix avoids touching individual components and doesn't affect desktop or Android.

**Key files:** `ui/src/index.css`, `doc/main/ui/mobile.md`
**Verification:** Build passed, CSS rule confirmed loaded via Playwright computed style check
**Commit:** 404de2a
**Next:** None
**Blockers:** None

## 2026-04-22: search-index — top-level symlink walk + loop safety (~150× faster on monorepos)

**What changed:**
- `server/src/routes/files.ts` `collectSymlinkedFiles` no longer walks the entire project tree. Now scans only top-level entries for symlinked directories and recurses only into those.
- New `walkSymlinkedDir` helper tracks ancestor `realpath()`s per recursion path so cycles (`loop -> .`, mutual `a -> b / b -> a`) terminate. Two distinct top-level aliases pointing to the same target both still index.
- Top-level symlinks resolving to the project root or an ancestor are short-circuited before any walk.
- 5 regression tests in `server/src/routes/__tests__/files.test.ts`: top-level dir symlink indexed, no double-count of file symlinks, self-loop termination, mutual-cycle termination, shared-target sibling aliases.

**Why:**
- On large monorepos (androidagent: 780k files, 47k dirs, 24GB of gitignored data under `eval/`, `debug-output/`), the old recursive walk took ~5.4s on every Cmd+P open — even though `git ls-files` itself returned in ~83ms. The walker bypassed `.gitignore` (only honored a hardcoded 10-entry ignore set).
- Trade-off: files inside *nested* symlinked directories (e.g. `reference/paperclip/.claude/skills/paperclip/*`) are no longer indexed by Cmd+P. Top-level symlinks (`.agents`, `.codex`, …) still work. Acceptable for an interactive latency-sensitive endpoint; can revisit with a hybrid (e.g. recover `mode 120000` entries from `git ls-files --stage`) if needed.

**Key files:** `server/src/routes/files.ts`, `server/src/routes/__tests__/files.test.ts`, `doc/main/backend/routes.md`
**Verification:** `npm test --run` 190/190 pass (was 185 + 5 new). Manual benchmark on androidagent: 5400ms → 37ms (≈150×). Loop hazard found by codex review of `558c4a0` and reproduced locally before fix.
**Commit:** `558c4a0` (perf), `16edf16` (loop fix + tests)
**Next:** None.
**Blockers:** None.


## 2026-04-22: Doc / project separation — Phases 2–4 complete (freeze lifted)

**What changed:**
- Phase 2 swept 7 workspace repos in parallel: `multmux 0b58e39`, `cproxy 76d869d`, `lawyer_search 58c3522`, `symphony 72bf5ff`, `autoresearch-optimizer 3d2013c`, `vvg 96d9338`, `androidagent b22be2b9` — all single-commit `git mv doc/{todo,archive} → projects/{active,archive}` with sweep + targeted archive-JSON rewrite.
- Phase 2b openweb sibling-repo split: renamed `openweb-docs/ → openweb-projects/` (commit `f0fbdba` for `todo → active`), replaced `openweb/doc/{todo,archive}` symlinks with a single `openweb/projects → ../openweb-projects` symlink, swept the runtime `mdPath` constant in `scripts/adapter-inventory.ts` plus 5 comment refs (`5a037792`), then a follow-up `7d211bd0` repointed two skill knowledge links (`adapter-recipes.md`, `add-site/verify.md`) to their archived destinations (the original `doc/todo/...` targets had been archived before the migration even started).
- Phase 3 socialsim: not a git repo — backup tarball `~/workspace/socialsim-doc-backup-20260422-154105.tgz`, plain `mv doc/todo → projects/active`, sweep.
- Phase 4 cross-repo verification: source-grep clean across all 11 repos (only legitimate exclusions remain — `doc/PROGRESS.md` historical entries, archived `projects/archive` narrative prose, untracked `workflow/note.md` user-private content). `git log --follow projects/tasks.json` continuity confirmed in workflow + agent-config. Tasks API verified serving from `projects/tasks.json` (workflow 13, androidagent 11, multmux 11). Removed dead `openweb-docs` entry from `~/.workflow/projects.json` (path renamed; `openweb` exposes the bundles via the new `projects` symlink instead).
- **Phase 0 skill-invocation freeze lifted.** All `~/.claude/skills/{update-tasks,orchestrate,design,double-design,update-doc,office-hours}` and the global `update-tasks.py` resolve `projects/tasks.json` and `projects/archive/` correctly across every migrated repo.

**Why:**
- Tier 2 had to wait for Tier 1 (workflow + agent-config back-to-back) so the global skill symlink was already pointing at the new layout before any other repo moved. Once `agent-config 75a9f15` landed, the 7 generic Tier-2 cutovers were fully parallel-safe (different repos, different filesystems, no shared state).
- openweb's two-repo split needed special handling because `openweb-docs/` was a sibling repo symlinked into `openweb/doc/{todo,archive}` — a straight rename plus symlink replacement was cleaner than collapsing it into the main repo.
- socialsim's lack of git made the tar backup mandatory — there is no `git reset` rollback path.

**Key files:** workflow `doc/PROGRESS.md`, workflow `projects/active/doc-separation/implementation_summary.md`, plus the per-repo commits listed above.
**Verification:** Cross-repo `grep -rE 'doc/(todo|archive)'` empty across 11 migrated repos (modulo expected exclusions). `git log --follow projects/tasks.json` works in workflow + agent-config. `curl http://localhost:3001/api/tasks/<project>` returns task graphs from `projects/tasks.json` for workflow / androidagent / multmux. Skill knowledge links repoint to existing archive targets (verified with `test -f` before commit). socialsim backup tarball present at expected path.
**Commit:** workflow this entry only · per-repo: `0b58e39`, `76d869d`, `58c3522`, `72bf5ff`, `3d2013c`, `96d9338`, `b22be2b9`, `f0fbdba`, `5a037792`, `7d211bd0`
**Next:** Archive `projects/active/doc-separation/` → `projects/archive/20260422_doc-separation/` and call `update-tasks.py archive doc-separation` to snapshot the now-terminal task tree.
**Blockers:** None. UI manual click-through on archived task `design` fields was not performed by the orchestrator — all design refs were rewritten programmatically with target-file existence verified, so spot-check at leisure.


## 2026-04-22: Doc / project separation — agent-config cutover (Phase 1b)

**What changed:**
- agent-config repo mirrored Phase 1a: `doc/todo/` → `projects/active/`, `doc/archive/` → `projects/archive/`, `tasks.json`/`progress.json` promoted to `projects/` root.
- Global skill prompts (`update-tasks`, `orchestrate`, `design`, `double-design`, `update-doc`, `office-hours`) and `update-tasks.py` constants updated to the new paths. Historical project notes swept.

**Why:**
- Global skills delivered via `~/.claude/skills → agent-config/global/skills` were still writing to `doc/todo/...` after Phase 1a, which would break every other repo until landed. Phase 1a + 1b had to complete inside the same freeze window.

**Key files (in agent-config):** `global/skills/{update-tasks,orchestrate,design,double-design,update-doc,office-hours}/SKILL.md`, `global/skills/update-tasks/scripts/update-tasks.py`, `global/skills/orchestrate/scripts/test-update-tasks-worktree.sh`, `doc/dev/workflow.md`, `.gitignore`, `projects/tasks.json`.
**Verification:** `update-tasks.py` runtime check confirmed `FILE`/`ARCHIVE_DIR`/`LOCK_FILE` resolve to `projects/...` and exist. `grep -rE 'doc/(todo|archive)' global/skills` empty. All design.md acceptance criteria pass.
**Commit:** agent-config `75a9f15` (workflow repo: this `docs:` commit only)
**Next:** Phase 2 — sweep remaining workspace repos (multmux, cproxy, lawyer_search, symphony, autoresearch-optimizer, vvg, androidagent) for stale `doc/todo|doc/archive` refs. Then Phase 4 lift the skill freeze.
**Blockers:** None.

## 2026-04-22: Doc / project separation — workflow repo cutover (Phase 1a)

**What changed:**
- New top-level `projects/` folder. `doc/todo/` → `projects/active/`, `doc/archive/` → `projects/archive/`. State files (`tasks.json`, `progress.json`, `.tasks.json.lock`) moved to `projects/` root, above the active/archive split. `doc/PROGRESS.md` intentionally stays in `doc/`.
- Inline path constants in 7 source files (no adapter modules): `server/src/routes/tasks.ts` (`TASKS_FILE`/`ARCHIVE_DIR`), task worktree test fixture, `ui/src/hooks/useTaskGraph.ts` (`TASKS_FILE_PATH` export reused by `useWorkspaceNavigation.ts`), `TaskArchiveView.tsx` empty-state label, `ui/src/data.ts` example tree, `scripts/update-tasks.py`.
- Three commits: `37d8b34` constants → `2ecb70f` pure git-mv (so rename detection records straight renames, no content edits in that commit) → `14035a9` sweep + archive JSON rewrite.
- Sweep across `CLAUDE.md`, `doc/main/**`, `projects/active/**` (excluded `doc-separation/` so the migration narrative keeps its historical paths).
- Targeted rewrite of all 14 `projects/archive/*.json` `design` fields. Resolution order: dated archive folder → active slug. 0 flagged.
- `CLAUDE.md` "Documentation Structure" block updated to show `doc/` (reference) + `projects/` (workstream) split.

**Why:**
- `doc/` was mixing two artifacts with opposite lifecycles — stable reference docs and live workstream state. Splitting on **audience and purpose** (read to *learn* the codebase vs. read to *execute* in-flight work) makes the file explorer surface coherent and unblocks publishing `doc/` as a public artifact later. See `projects/active/doc-separation/design.md` for full rationale and `eng-plan-review_codex.md` for the engineering review that shaped Phase 0 freeze + Tier 1 ordering.

**Key files:** `server/src/routes/tasks.ts`, `server/src/routes/__tests__/tasks-worktree.test.ts`, `ui/src/hooks/useTaskGraph.ts`, `ui/src/workspace/useWorkspaceNavigation.ts`, `ui/src/tasks/archive/TaskArchiveView.tsx`, `ui/src/data.ts`, `scripts/update-tasks.py`, `CLAUDE.md`, `doc/main/**`, `projects/active/**`, `projects/archive/*.json`
**Verification:** `cd server && npm test` → 17 files / 185 tests passed. Source-code grep `doc/(todo|archive)` across `server/src`, `ui/src`, `scripts` → empty. `git log --follow projects/tasks.json` crosses the rename and reaches pre-migration history. Playwright `tasks*.spec.ts` fails on a missing `<header>` selector — confirmed pre-existing on the same checkout with source files reverted, not caused by this migration.
**Commit:** `37d8b34`, `2ecb70f`, `14035a9`
**Next:** Phase 1b (agent-config skill prompts + self-bootstrap) so the global skills stop writing to stale `doc/todo` paths. Phase 0 skill freeze (`/update-tasks`, `/orchestrate`, `/design`, `/double-design`, `/implement`, `/update-doc`, `/office-hours`) remains in effect across `~/workspace/*` until Phase 4 verification.
**Blockers:** None.

## 2026-04-22: Remote desktop access — CORS allowlist + secure-context fallback

**What changed:**
- `server/src/index.ts`: added `desktop` and `desktop.tailnet-example.ts.net` to `DEFAULT_ALLOWED_HOSTNAMES`. Without these, `isAllowedOrigin` rejected the bare hostname (not in the set, not an IP, not `.local`, not in any private range), so WS upgrades for terminals were `socket.destroy()`'d at `server/src/index.ts:255-259` — terminal stuck in "Reconnecting".
- `ui/src/components/FileExplorer.tsx:293`: replaced `crypto.randomUUID()` with `globalThis.crypto?.randomUUID?.() ?? \`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}\``. The unguarded call threw synchronously inside react-arborist's `onCreate` over plain-HTTP non-localhost (`http://desktop:3001/` via LAN/Tailscale), which silently aborted the create flow — no pending state, no editing row, no toast, no network request. Click looked like a no-op.
- `doc/main/security.md`: extended the configured-hostname list.
- `CLAUDE.md` Conventions: added a one-liner about secure-context-only browser APIs (`crypto.randomUUID`, `navigator.clipboard`, `Notification.requestPermission`) silently failing over plain HTTP from non-`localhost` hosts; always feature-detect with `globalThis.crypto?.randomUUID?.() ?? <fallback>`.

**Why:**
- Started workflow on a Linux desktop accessed from a phone via `http://desktop:3001/`. Both bugs only manifest in this serving mode (plain HTTP + non-localhost hostname) — local dev on `localhost` always hits the secure-context path and the laptop's hostname was already in the allowlist. Workflow is explicitly designed for this remote-access pattern (`start:app` is the production/mobile entrypoint), so both classes of bug deserve to be guarded against in the SOTA conventions.

**Key files:** `server/src/index.ts`, `ui/src/components/FileExplorer.tsx`, `doc/main/security.md`, `CLAUDE.md`, `doc/PROGRESS.md`
**Verification:** Playwright run against `http://desktop:3001/`: terminal pane attaches end-to-end (no "Reconnecting" loop); both file-create paths (toolbar `+` and right-click → New File) produce the inline-edit row, accept input, and `POST /api/files/quant/create-file` returns 200 with the file appearing in the tree. No `crypto.randomUUID` errors in the page console after the fix.
**Commit:** `b1b91d4`, `4aa8356`
**Next:** None
**Blockers:** None

## 2026-04-17: Archive 6 completed projects from doc/todo/

**What changed:**
- Moved to `doc/archive/20260417_*/`: `git-compare`, `pty`, `worktree`, `frontend-redesign`, `theme`, `sessionhist`, `tasks-better`. All verified as implemented (subagent review of design docs vs. current source; task graph states `done`).
- Archived tasks: `worktree` (8 subtasks) → `doc/archive/20260417_worktree.json`; `tasks-better` (11 subtasks) → `doc/archive/20260417_tasks-better.json`; `frontend-polish` (16 subtasks, dropped unused `fp-codex-review`) → `doc/archive/20260417_frontend-polish.json`.
- Remaining in `doc/todo/`: `workflow-multmux` (2 High-priority race conditions unfixed), `potential-publish` (design-review gate unimplemented), `superset-ref` (not started), `agent-theme-toggle` (not started).

**Why:**
- Periodic sweep to keep `doc/todo/` focused on active work. Archived folders remain reachable under `doc/archive/` with date prefix.

**Key files:** `doc/todo/`, `doc/archive/20260417_*`, `doc/archive/20260417_worktree.json`, `doc/todo/tasks.json`
**Verification:** Subagent review of each folder against the code; `ls doc/todo` confirms only active projects remain.
**Commit:** pending
**Next:** Implement `agent-theme-toggle` or address `workflow-multmux` race conditions.
**Blockers:** None.

## 2026-04-17: Fix false "Server overloaded" on PTY reconnect

**What changed:**
- `server/src/lib/terminal.ts` — removed `markDegraded()` from both `pty.spawn` catch blocks. A single spawn failure (e.g. reconnect to a stale tmux session name, transient node-pty hiccup on macOS) no longer flips the whole server into degraded mode.
- `server/src/lib/pty-capacity.ts` — `PTY_LEAK_SLACK` raised from 8 to 80 with a comment explaining the choice: node-pty's `destroy()` / fd-close on macOS lags after release, so a residual actual/tracked gap is expected and is not a leak signal. The authoritative exhaustion signals are the absolute soft/hard limits. `markDegraded()` is now operator-only, still exported and covered by tests.

**Why:**
- Right after a clean server restart, browser tabs reconnecting to old sessions would quickly cause one `pty.spawn` to throw for an unrelated reason. `markDegraded` flipped state to `degraded`, and every subsequent attach was rejected with close code `4002` → the UI showed `[Server overloaded — retrying…]` on all terminals despite the server having plenty of PTY headroom.
- The sweep-based lsof measurement is the correct pressure signal; treating spawn errors as capacity signals conflated unrelated failure modes.

**Key files:**
- `server/src/lib/terminal.ts`, `server/src/lib/pty-capacity.ts`
- `doc/main/backend/libs.md`, `doc/todo/pty/implementation_summary.md`

**Verification:** `cd server && npm test` — 185 passed.
**Commit:** `6e460a1`
**Next:** —
**Blockers:** None.

## 2026-04-17: Fix PTY leak in terminal WebSocket lifecycle

**What changed:**
- `server/src/index.ts` — rewrote terminal WS handler around a single `connections: Map<WebSocket, TerminalConnection>` record and one idempotent `cleanupConnection()` helper that owns all detach cleanup (subscriptions, release, tracking). Attach path is now synchronous — removed the `await loadProjects()` gap that could orphan a PTY if the socket closed mid-handshake. `proc.onExit`, `ws.on('close')`, `ws.on('error')`, and shutdown all route through `cleanupConnection`. Added a 60s unref'd sweep that calls `pty-capacity.sweep()` and drains non-persistent tmux attaches on `draining`.
- `server/src/lib/pty-capacity.ts` (new) — `healthy` / `degraded` / `draining` state machine gated by `PTY_SOFT_LIMIT=400`, `PTY_HARD_LIMIT=448`, `PTY_LOW_WATER=320`, `PTY_LEAK_SLACK=8` on darwin's 511-slot PTY table. `assertCanSpawn()` throws `PtyCapacityError` when pressure is unsafe; `sweep()` samples via `lsof -p <pid> -F tn`, holds state when the sampler fails, and steps `draining → degraded` / `degraded → healthy` with 2-sweep hysteresis. `markDegraded()` flips state immediately on unexpected `pty.spawn` failures so the next attach fails fast.
- `server/src/lib/terminal.ts` — both spawn paths (`startShellSession`, `attachSession` tmux branch) call `assertCanSpawn()` before `pty.spawn()` and `markDegraded()` on failure. Dropped the unused `projectPath` param from `attachSession()`. Exposed `getShellSessionCount()` for the sweep's tracked-count math.
- `ui/src/components/Terminal.tsx` — close code `4002/pty_capacity` now takes a slower reconnect path (5s → 60s with jitter) and renders `[Server overloaded — retrying…]` instead of fast-reconnecting. `4001/session_ended` keeps current detach-immediately behavior.
- Tests: new `server/src/lib/__tests__/pty-capacity.test.ts` (9 tests covering state transitions, hysteresis, draining step-down, sampler failure); `terminal.test.ts` updated for new signature and now covers capacity gating + shell bypass.

**Why:**
- `pty.spawn('tmux attach-session')` can leak a master fd when node-pty throws after `openpty()`; repeated browser reconnects amplify a transient kernel hiccup into full PTY table exhaustion. The seed race (early socket close during the `await loadProjects()` window) and split cleanup between `proc.onExit` and `ws.on('close')` could also orphan PTYs. Once the 511-slot table filled, every new attach failed and the server became unusable until restart.
- Fix addresses all three windows: sync attach closes the seed race; pre-spawn capacity gate stops the amplifier before calling the leaky native path; periodic sweep compares actual vs tracked and drains non-persistent attaches at the hard limit — tmux sessions and shell sessions are never killed, so long-running agent state survives.

**Key files:**
- `server/src/index.ts`, `server/src/lib/terminal.ts`, `server/src/lib/pty-capacity.ts` (new)
- `ui/src/components/Terminal.tsx`
- `server/src/lib/__tests__/pty-capacity.test.ts` (new), `server/src/lib/__tests__/terminal.test.ts`
- `doc/main/backend/libs.md`

**Verification:** `cd server && npm test` — 185 passed (17 files); design doc at `doc/todo/pty/final/design.md`.
**Commit:** (pending)
**Next:** Restart the workflow server after deploy to clear any already-leaked PTYs the current process is carrying. Watch logs for `[pty] pressure` transitions.
**Blockers:** None.

## 2026-04-16: Terminal — auto-focus on session switch

**What changed:**
- `Terminal` now runs a `useEffect` keyed on `sessionName` that calls `termRef.current?.focus()`, so switching sessions (sidebar click, `Cmd+Ctrl+1-9`, `Cmd+Ctrl+↑/↓`) lands the caret directly in the xterm viewport.
- Added `ui/src/components/__tests__/Terminal.focus.test.tsx` — vitest + jsdom, mocks `@xterm/xterm` / addons / WebSocket / ResizeObserver / matchMedia. Covers positive case (sessionName change → focus fires) and negative case (unrelated prop change → focus does not fire).

**Why:**
- `setFocusTarget('terminal')` only feeds `closeFocusedSurface`; it never pulled DOM focus. xterm's mount-time `term.focus()` fired only once and was never re-triggered when the active session changed, so users had to click into the terminal before typing worked.
- Test locks in both the trigger (sessionName) and the narrowness of the dep list, so future refactors can't silently broaden or drop the effect.

**Key files:**
- `ui/src/components/Terminal.tsx` — new session-change focus effect
- `ui/src/components/__tests__/Terminal.focus.test.tsx` — regression test
- `doc/main/frontend/components.md` — Terminal spec updated

**Verification:** `npx vitest run src/components/__tests__/Terminal.focus.test.tsx` (2 passed); confirmed test fails when the new effect is reverted
**Commit:** (pending)
**Next:** —
**Blockers:** None

## 2026-04-16: Trailing-slash project paths broke file create — defense in depth

**What changed:**
- `server/src/lib/projects.ts` — `loadProjects`/`saveProjects` strip trailing `/` from `path`; stale entries self-heal in memory and get rewritten on next save
- `server/src/routes/files.ts:validateNewPath` — strip trailing `/` before the `startsWith` check, mirroring the existing defense in `resolveAndValidate`
- `ui/src/components/FileExplorer.tsx` — create errors now surface via `toast.error` + `refreshTree` instead of silent `console.error`
- Server unit tests for load/save normalization and a regression test for create-file with a trailing-slash project path; e2e test for header "New File" while a subdirectory is selected

**Why:**
- When `~/.workflow/projects.json` stored a project path with a trailing `/` (e.g. `androidagent`), `validateNewPath` did `absPath.startsWith(projectPath + '/')` — that became `...androidagent//`, but `join()` produces single-slash paths, so every create/rename/move got 400 "invalid path". The UI only logged it, so the inline edit input disappeared with no file created and no visible error. Belt-and-suspenders: normalize at ingestion (projects.ts) and at use (validateNewPath), plus make the next regression visible.

**Key files:** `server/src/lib/projects.ts`, `server/src/routes/files.ts`, `ui/src/components/FileExplorer.tsx`, `server/src/lib/__tests__/projects.test.ts`, `server/src/routes/__tests__/files.test.ts`, `ui/tests/e2e/file-create.spec.ts`
**Verification:** 174 server vitest tests pass; file-create e2e tests pass; confirmed regression test fails on pre-fix code and passes on fix
**Commit:** 7b16de3
**Next:** None
**Blockers:** None

## 2026-04-16: Keyboard shortcuts — Cmd+Ctrl namespace for sessions and editor tabs

**What changed:**
- Session switch moved from `Cmd+Shift+1-9` → `Cmd+Ctrl+1-9` (macOS reserves `Cmd+Shift+3/4/5/6` for screenshots, so 3-6 were unreachable)
- Session cycle moved from `Cmd+↑/↓` → `Cmd+Ctrl+↑/↓` (avoids conflict with macOS document-start/end text navigation)
- New shortcut `Cmd+Ctrl+←/→` cycles through editor tabs (mirrors `Cmd+Ctrl+↑/↓` for sessions — vertical list vs horizontal tab bar)
- Session rows now show a numeric index badge next to the name when `Cmd+Ctrl` is held, matching the existing `Cmd`-held pattern on ProjectList
- ProjectList's `Cmd`-held hint now hides when `Ctrl` is also down, so only one hint layer lights up at a time
- `ShortcutSheet` updated with the new bindings

**Why:**
- `Cmd+Shift+N` conflicted with macOS system screenshot shortcuts on 3-6; swapping to `Cmd+Ctrl+N` frees all nine slots and avoids browser tab cycling (`Ctrl+Tab`)
- `Cmd+↑/↓` is the macOS text-editor convention for jump-to-start/end — high collision inside Monaco/terminals
- Unifying sessions and editor tabs under the `Cmd+Ctrl` namespace gives a coherent mental model: `↑/↓` = vertical list (sessions), `←/→` = horizontal list (tabs), `1-9` = direct jump (sessions)

**Key files:**
- `ui/src/workspace/useWorkspaceKeyboard.ts` — new Cmd+Ctrl handlers (session 1-9, session ↑/↓, tab ←/→), threads `openTabs`/`activeTab`
- `ui/src/workspace/WorkspaceSessionList.tsx` — `SessionItem` accepts `shortcutIndex` and renders a chip next to the name
- `ui/src/workspace/useWorkspaceSessionSection.tsx` — tracks `cmdCtrlHeld` modifier state, maps `orderedSessions` index → shortcut number
- `ui/src/workspace/WorkspaceScreen.tsx` — passes `openTabs`/`activeTab` into keyboard hook
- `ui/src/components/ProjectList.tsx` — Cmd-held detection excludes Ctrl so hint layers don't overlap
- `ui/src/workspace/ShortcutSheet.tsx` — cheatsheet updated
- `doc/main/ui/keyboard.md` — table updated

**Verification:** `npx tsc --noEmit` clean
**Commit:** (pending)
**Next:** —
**Blockers:** None

## 2026-04-16: DiffTab — fix split view column overflow

**What changed:**
- `SplitRow` grid changed from `1fr 1fr` to `minmax(0, 1fr)` so text columns can shrink below min-content
- Text spans in `SplitRow` and `UnifiedRow` now set `minWidth: 0`, `overflowWrap: anywhere`, `whiteSpace: pre-wrap`
- Extracted shared `SPLIT_GRID` / `SPLIT_TEXT` / `UNIFIED_TEXT` style constants

**Why:**
- On newly-added files with long unbreakable tokens (file paths, identifiers), split view had right-column content visually overflowing into the left column area because grid items default to `min-width: auto` (= min-content). `pre-wrap` also restores code indentation that was previously collapsed.

**Key files:** `ui/src/workspace/diff/DiffTab.tsx`
**Verification:** `npx tsc --noEmit` clean; split view renders a +16/-0 markdown diff without cross-column leakage
**Commit:** (pending)
**Next:** —
**Blockers:** None

## 2026-04-16: ProjectList — Cmd-held index hints

**What changed:**
- Holding `Cmd` reveals small numeric index badges (1–9) next to the first 9 project names in the sidebar list, matching the existing `Cmd+1-9` switch shortcut
- Hints hide on keyup/blur/visibilitychange; badge sits immediately after the project name, with unread/session counts still right-aligned via `ml-auto`

**Why:**
- With many projects it is hard to know which index a project is at; surfacing the number only while `Cmd` is pressed keeps chrome clean but discoverable

**Key files:** `ui/src/components/ProjectList.tsx`, `doc/main/ui/keyboard.md`, `doc/main/ui/app-shell.md`, `doc/main/frontend/components.md`
**Verification:** Manual — Cmd press reveals/hides hints; `Cmd+1-9` still switches projects
**Commit:** 7b22a4f
**Next:** —
**Blockers:** None

## 2026-04-16: Graph view — fix parent click + show estimate badge

**What changed:**
- Fixed parent task click in graph view not opening detail panel (chevron stopPropagation was eating the selection event)
- Added t-shirt size (estimate) badge to graph view task nodes — 9px bold uppercase between state dot and title
- Added `estimate` field to `RawTaskEntry` and `TaskGraphTask` in graph data model

**Why:**
- Parent tasks were unclickable for detail view — only collapse toggled
- Estimate visibility in graph view matches board view, giving quick size context

**Key files:** `ui/src/tasks/TaskGraphNode.tsx`, `ui/src/tasks/taskGraphModel.ts`
**Verification:** `tsc --noEmit` clean
**Commit:** cc89156
**Next:** None
**Blockers:** None

## 2026-04-16: Fix session status inconsistency

**What changed:**
- (multmux) `PostToolUse`/`PostToolUseFailure` hooks set status to `processing` — keeps mtime fresh during long turns and corrects premature Stop events. `PermissionRequest` sets `idle`. Codex now also registers `PostToolUse`.
- (multmux) `reconcile()` persists capture-derived status to stale state files (mtime > 3min). `isIdle()` uses active timer pattern `(Xs ·` for robust busy detection.
- (multmux) Stale threshold reduced from 30min to 3min.
- (workflow) Session reconciler runs first reconcile immediately on startup. API reads state files only — kept accurate by hooks (real-time) + multmux reconcile (background correction).

**Why:**
- State files got stuck at "processing" when hooks failed to fire. Long turns triggered stale fallback because only UserPromptSubmit/Stop touched the state file. PostToolUse solves this by refreshing mtime on every tool completion.
- `isIdle()` matched `❯` in Claude Code's TUI even during active tool execution.

**Key files:** `server/src/lib/session-reconciler.ts`, `multmux/src/hooks.ts`, `multmux/src/commands/hook-update.ts`, `multmux/src/providers.ts`
**Verification:** 171/171 server tests pass, 232/232 multmux tests pass (12 new hook event tests).
**Commit:** 4ed3b3c (workflow), 4f8ebf3..c0185fe (multmux)
**Next:** Existing sessions need restart to pick up new hooks
**Blockers:** None
**Blockers:** None

## 2026-04-15: Add PDF and image preview in editor

**What changed:**
- Server: new `GET /files/:project/raw` endpoint serves binary files with proper MIME types (images + PDF), 20MB limit, path-validated
- UI: extension-based file type detection (`ui/src/lib/binaryFiles.ts`) skips the text FileState pipeline for binary files (no garbled UTF-8)
- `ImagePreview` renders inline `<img>` with `object-fit: contain`
- `PdfPreview` lazy-loads `react-pdf` via `PdfRenderer` (CDN worker, code-split) with page navigation, zoom +/-, and fit-to-screen button
- `PreviewErrorBoundary` class component isolates react-pdf/image failures from crashing the app
- E2E test covers Tax2025 project with persisted PDF tab, raw endpoint, and image serving

**Why:**
- Clicking image/PDF files in file explorer showed garbled text — all files were fetched as UTF-8 via the text content API. Binary files need raw binary serving and specialized renderers.

**Key files:** `server/src/routes/files.ts`, `ui/src/lib/binaryFiles.ts`, `ui/src/workspace/ImagePreview.tsx`, `ui/src/workspace/PdfPreview.tsx`, `ui/src/workspace/PdfRenderer.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`
**Verification:** tsc clean, 171 server tests pass, 3 Playwright E2E tests pass, lint no new errors
**Commit:** 0e4404e
**Next:** None
**Blockers:** None

## 2026-04-14: Fix terminal mouse garble and hidden cursor after TUI session

**What changed:**
- Client sends RIS (`\ec`) + explicit DECTCEM show (`\e[?25h`) on first WebSocket connect to clear stale screen content. Explicit cursor-show needed because xterm.js RIS doesn't reset `isCursorHidden`.
- Server sends terminal mode reset (disable mouse tracking + show cursor) unconditionally for all persistent shell sessions, not just those with non-empty buffers — PTY state can carry over even with empty buffer.

**Why:**
- Shell session buffers accumulate raw escape sequences from whatever ran in them. When Claude Code enables SGR mouse tracking (`?1003h`, `?1006h`) or hides the cursor (`?25l`), those sequences persist in the buffer. Replaying the buffer on reconnect restored those modes, causing mouse clicks to produce garbled text (`0;68;27M...`) and hiding the cursor.

**Key files:** `ui/src/components/Terminal.tsx`, `server/src/index.ts`
**Verification:** tsc clean, 171 server tests pass, eslint no new errors
**Commit:** a59ba18, 594f95f
**Next:** None
**Blockers:** None

## 2026-04-14: Fix iOS PWA keyboard viewport — layout shift on tap

**What changed:**
- `useKeyboardViewport`: added tap-based estimation fallback for iOS PWA where `visualViewport.height` may delay updating. On user tap (not scroll) inside terminal/input areas, defers a cached (or 40% estimate) keyboard height by 300ms — skipped if `visualViewport` updates first (avoids jitter). Distinguishes taps from scrolls via touchmove detection. Programmatic `term.focus()` on mount excluded via `touchedTerminal` flag. Sets `--kb-safe-bottom: 0px` when keyboard is open.
- `App.tsx`: changed root div from `h-dvh` to `h-full` so it inherits `#root`'s `var(--kb-viewport)` height (was the primary blocker — `h-dvh = 100dvh` never changes on iOS).
- `TerminalKeyBar`: bottom padding uses `var(--kb-safe-bottom, env(safe-area-inset-bottom))` to eliminate gap between content and keyboard when keyboard is open.
- Expand button animation removed (was jittering on keyboard open).

**Why:**
- On iOS standalone PWA, tapping the terminal opened the keyboard but the layout didn't shift — TerminalKeyBar and terminal cursor were hidden behind the keyboard.

**Key files:** `ui/src/hooks/useKeyboardViewport.ts`, `ui/src/App.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `doc/main/ui/mobile.md`
**Verification:** `tsc --noEmit` clean, 171 server tests pass, lint clean on changed files
**Commit:** 92ddf2a
**Next:** None
**Blockers:** None

## 2026-04-14: Git status -z parsing + tab-hidden polling suppression

**What changed:**
- Switched `git status --porcelain` to `--porcelain -z` (null-terminated) for correct filename parsing with spaces/special chars. Added rename/copy old-name skip logic.
- `usePolling` now skips fetches when `document.hidden` — background tabs don't spawn git processes. SSE visibility reconnect already handles catch-up on tab focus.

**Why:**
- VS Code research showed `-z` is standard for correctness. Our newline split could break on filenames with spaces (quoted by git) or embedded newlines.
- Background tab polling wastes server resources for invisible UI.

**Key files:** `server/src/routes/git.ts`, `ui/src/hooks/useApi.ts`
**Verification:** 171 server tests pass, 4 UI polling tests pass (including new tab-hidden test)
**Commit:** 18e0e75
**Next:** None
**Blockers:** None

## 2026-04-14: Fix Changes section lag and diff viewer all-green bug

**What changed:**
- Fixed fetch starvation in `usePolling`: replaced `tick` state + effect restart with monotonic sequence counter. SSE now calls `load()` directly without cancelling in-flight fetches — prevents data starvation during rapid agent edits.
- Reduced SSE client debounce from 500ms to 150ms (server already debounces at 200ms).
- Fixed diff endpoint 3-step fallback: `git diff HEAD` → `git diff --cached HEAD` (staged) → `--no-index /dev/null` (untracked). Previously skipped the staged check, causing files with staged-only changes to show all lines as additions.

**Why:**
- Changes section could lag many seconds when an agent was actively editing files — each SSE signal cancelled the previous in-flight `git status` fetch before it could complete.
- Diff viewer showed all lines green for files where working tree matched HEAD but index had staged changes.

**Key files:** `server/src/routes/git.ts`, `ui/src/hooks/useApi.ts`, `ui/src/hooks/useSSE.ts`
**Verification:** Server tests pass (164/164), lint clean on changed files (pre-existing warnings only), build compiles
**Commit:** 1ed112b
**Next:** None
**Blockers:** None

## 2026-04-12: File explorer copy path split + compact context menus

**What changed:**
- File explorer context menu: "Copy Path" split into "Copy Relative Path" (project-relative) and "Copy Absolute Path" (full filesystem path, worktree-aware). FileExplorer now receives `projectPath` prop.
- Menu component: reduced padding (`py-1.5` → `py-1` on items and container, `my-1.5` → `my-1` on dividers) for more compact context menus globally.

**Why:**
- Users need both relative and absolute paths depending on context (e.g., relative for imports, absolute for terminal commands). Menu items were too spread out for a utility context menu.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/components/Menu.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `tsc --noEmit` clean
**Commit:** `59a0151`
**Next:** None
**Blockers:** None

## 2026-04-12: Terminal WebSocket reconnection + auto-detach debounce

**What changed:**
- Terminal component split into two effects: xterm lifecycle (lives for mount lifetime) and WebSocket lifecycle (reconnects on disconnect). On connection loss, auto-reconnects with exponential backoff (1s→15s, 5 retries, jitter). Wake-from-sleep triggers immediate reconnect via `visibilitychange`.
- Server sends custom close code **4001** when PTY exits (session ended). Client detaches immediately on 4001 — no reconnect loop. Only connection-loss closes (code 1006) trigger reconnection.
- Shared `failCount` with 5s stability threshold prevents infinite reconnect on dead sessions (tmux "can't find session" opens+closes within ms).
- Auto-detach now requires 2 consecutive API poll misses before clearing `activeSession` (was zero-tolerance — 1 miss = instant detach). Explicit kills bypass this entirely.

**Why:**
- Terminal sessions disappeared when the WebSocket dropped (sleep/wake, network blip, server ping timeout). `onDisconnect` unconditionally detached the session with no reconnection attempt. Users had to re-click the session to reopen.

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/workspace/useWorkspaceSessions.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `server/src/index.ts`
**Verification:** `tsc --noEmit` clean on changed files, 164 server tests pass
**Commit:** `59a0151..9246465`
**Next:** None
**Blockers:** None

## 2026-04-12: Codex summary rollout JSONL fallback

**What changed:**
- `session-summary.ts`: when Codex `state_5.sqlite` threads table has no entry for a session, fall back to scanning rollout JSONL files at `~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`. Extracts last real user message (skips `#`/`<`-prefixed system context). Searches up to 7 days back.

**Why:**
- Codex stopped writing to `state_5.sqlite` after Apr 10 (all sessions since then have rollout files but no threads row). Rollout fallback ensures summaries display for all live sessions.

**Key files:** `server/src/lib/session-summary.ts`
**Verification:** 164 tests pass, smoke-tested both SQLite and rollout paths
**Commit:** `03703fe`
**Next:** None
**Blockers:** None

## 2026-04-12: Session lifecycle fixes — Codex review R1+R2 + terminal + naming

**What changed:**
- Terminal disconnect: `onDisconnect` callback fires from `ws.onclose`, parent detaches immediately instead of hanging on "[Disconnected]"
- Default naming: workflow no longer generates `provider-timestamp` names. Omits `--name`, lets multmux generate word-based handles. Unnamed session poll scans for new state files by cwd+provider+spawnTime window.
- fs.watch null filename: macOS can deliver `null` on state file deletion — now emits blanket `sessions` refresh instead of silently dropping
- R1: ENOENT guard for `~/.multmux/sessions/` on clean machines, collision suffix fallback scan by resumeId/prefix after 3s, `starting` in session pane + activity badges, spawnTime correlation window
- R2: named start only trusts NEW files (beforeFiles snapshot), verifies resumeId for resumes, unnamed correlation wrapped in per-file try-catch

**Why:**
- Codex code review (2 rounds) found: ENOENT on clean machine, resume collision suffix timeout, `starting` filtered in pane renderer, unnamed session race. All closed.

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/project-watcher.ts`, `ui/src/components/Terminal.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/useWorkspaceSessions.ts`, `ui/src/workspace/useWorkspaceSessionSection.tsx`, `ui/src/App.tsx`, `ui/src/hooks/useApi.ts`
**Verification:** 164 server tests pass
**Commit:** `cd4c53b..8de5d7d`
**Next:** None
**Blockers:** None

## 2026-04-12: Fix markdown anchor links in split mode

**What changed:**
- Anchor links (`#heading`) in markdown preview now work in split mode. Previously, clicking them did nothing because the Editor↔Preview LERP scroll sync cancelled the `scrollIntoView` animation.
- Added `anchorScrollRef` flag to suppress scroll event reporting during anchor navigation
- Added `cancelLerpRef` to cancel any active LERP before starting anchor scroll
- LERP sync callback also checks the flag to prevent editor-triggered LERP during anchor nav
- Uses `scrollend` event (with 800ms timeout fallback) to re-sync state after scroll completes

**Why:**
- In split mode, `scrollIntoView` fired a scroll event → synced Editor → Editor synced back via LERP → LERP overrode `scrollTop` each frame → cancelled the native smooth scroll, pulling position back to start

**Key files:** `ui/src/workspace/WorkspaceEditorArea.tsx`
**Verification:** `tsc --noEmit` clean, `vite build` clean
**Commit:** `ae2ce6c`
**Next:** None
**Blockers:** None

## 2026-04-12: Align workflow with multmux v2 contracts

**What changed:**
- W1: replaced `unlinkSync` state file deletion with `multmux kill` CLI call (idempotent)
- W2: replaced `checkStaleStates()` + `isTmuxAlive()` + `backfillSessionIds()` with single `fetchAllSessionsFromCli()` → `multmux status --json --all`. Reconciler now consumes authoritative CLI snapshot directly.
- W3: removed `normalizeStateFileStatus()`, status passthrough: `starting | idle | processing`
- W4: simplified `startMultmuxSession()` — poll for `pid > 0` (not just file existence), `queryMultmuxStatus()` for resume preflight
- W5: deleted `resolveSessionTmuxName()` — dead code since multmux v2 (handle == tmux session name)
- W6: `closeMultmuxSession()` and `renameMultmuxSession()` are now handle-global (no cwd parameter)
- W7: removed `loadClaudePidMap()`, `loadCodexPidMap()`, lsof calls, and state-file summary fallback
- W8: aligned `MultmuxStateFile`/`MultmuxSession` types — removed `summary`/`stateFileSummary` fields, removed `error`/`completed` status values
- Fix: `starting` sessions now appear in session list (regression from W3 removing status normalization)
- Fix: `lastStatusBySession` type updated to include `starting`

**Why:**
- Eliminate parallel session-lifecycle infrastructure. One reconciliation owner (multmux), one mutation interface (multmux CLI). Workflow reads state files for cheap discovery, uses CLI JSON for correctness. Design: `~/workspace/multmux/doc/todo/workflow-multmux/final/design.md`

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/session-summary.ts`, `server/src/lib/terminal.ts`, `server/src/routes/sessions.ts`, `ui/src/workspace/useWorkspaceSessions.ts`, `ui/src/types.ts`
**Verification:** 164 server tests pass, UI type-checks clean
**Commit:** `dd202cf`, `14aa5b7`
**Next:** None
**Blockers:** None

## 2026-04-12: Worktree hardening — 3 rounds of Codex review + tests + QA

**What changed:**
- Security: path traversal prevention in withProject middleware (slug regex + resolve + prefix check)
- Correctness: worktree registration detection via `git worktree list --porcelain` (not just existsSync)
- Correctness: deep `.worktrees/` file changes now route to `filetree` SSE (live refresh when viewing worktree)
- Correctness: session matching uses longest-prefix/descendant check (worktree sessions appear in project)
- Correctness: slug validation tightened to lowercase-only across Python + bash + docs
- Correctness: `blockReason: "merge-conflict"` added to update-tasks.py enum
- Correctness: `gh pr create` extracts OWNER/REPO from remote URL; local merge verifies clean state + --ff-only
- Race fix: stale-fetch guard in useProjectWorktrees (ref-based project identity check covers poll + SSE paths)
- Race fix: activeWorktree clears on empty worktree list
- Race fix: session resume uses bestProject descendant match
- Tests: 19 vitest server tests, 32 bash integration tests, 8 Playwright e2e tests
- QA: full lifecycle validated in /tmp sandbox (create → commit → merge → cleanup)

**Why:**
- 3 rounds of Codex code review uncovered 1 critical + 5 high + 5 medium + 1 low issues. All resolved.

**Key files:** `server/src/middleware/project.ts`, `server/src/lib/worktree.ts`, `server/src/lib/project-watcher.ts`, `server/src/routes/sessions.ts`, `scripts/worktree-*.sh`, `ui/src/hooks/useProjectWorktrees.ts`, `ui/src/App.tsx`, `ui/tests/e2e/worktree.spec.ts`
**Verification:** 162 server tests pass, 32 script tests pass, 8 Playwright e2e pass
**Commit:** `80c92ea..86cf22c` (5 fix commits + 3 test commits)
**Next:** None — ready for first real worktree orchestration use
**Blockers:** None

## 2026-04-12: Mobile 4-pane navigation — Tasks gets its own tab

**What changed:**
- Mobile navigation expanded from 3 panes (Browse/Editor/Terminal) to 4 (Browse/Editor/Tasks/Terminal)
- Tasks renders `TaskScreen` directly in its own pane — no longer routed through editor tab system on mobile
- Removed Tasks toggle from Browse pane bottom (no longer needed)
- `MobilePane` type exported from `workspaceTypes.ts`, used across 6 workspace modules
- Cleaned up unused `tasksBody` prop from `WorkspaceLayout`

**Why:**
- Tasks toggle buried at bottom of Browse was hard to discover and reach; nav bar had unused space for a 4th tab

**Key files:** `ui/src/hooks/workspaceTypes.ts`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/usePersistence.ts`, 4 workspace hooks
**Verification:** `tsc --noEmit` clean, ESLint clean (no new errors)
**Commit:** `529f0c3`
**Next:** None
**Blockers:** None

## 2026-04-12: Fix blank screen after computer sleep/wake

**What changed:**
- `useSSE.ts`: added module-level `visibilitychange` listener that force-closes and reopens SSE EventSource when page becomes visible — kills zombie connections that survive sleep without firing `onerror`
- `useApi.ts`: added `setLoading(false)` in `usePolling` catch block so failed fetches retain previous data instead of leaving state stuck in `loading=true, data=null`

**Why:**
- After computer sleep/wake, EventSource connections could become zombies (readyState not CLOSED but no data flowing, no error fired). Polling hooks that caught network errors left `loading=true` permanently, causing `projects` to stay null → `activeProject` empty → `Workspace` not rendered → blank screen requiring manual refresh.

**Key files:** `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`
**Verification:** ESLint clean on changed files
**Commit:** `a255cd4`
**Next:** None
**Blockers:** None

## 2026-04-11: Worktree isolation for parallel orchestration

**What changed:**
- Worktree lifecycle scripts: `scripts/worktree-create.sh` (idempotent create at `.worktrees/<slug>/` on branch `task/<slug>`, optional provision hook), `worktree-merge.sh` (PR or local rebase+merge modes, dirty check), `worktree-cleanup.sh` (conservative removal with `--force` override), `worktree-lib.sh` (shared `resolve_repo_root` + `validate_slug`)
- Server `worktree.ts`: `WorktreeStatus` type (`active`, `dirty`, `branch`, `ahead`, `behind`), `getWorktreeStatus()` (parallel git status + rev-list), `getWorktreeStatuses()` (batch resolve from task map), `extractWorktreeSlug()` (regex path extraction)
- `withProject` middleware now accepts `?worktree=slug` query param — rewrites `project.path` to `.worktrees/<slug>/` for transparent worktree targeting
- Task API (`GET /api/tasks/:project`) enriches each task with `worktreeStatus` via batch resolution
- Sessions API enriches responses with `worktree` field (slug extracted from `sessionPath`)
- `project-watcher.ts` routes `.worktrees/<slug>` top-level changes to `worktrees` SSE channel; deeper `.worktrees/<slug>/**` changes route to `filetree` channel for live refresh
- New `useProjectWorktrees` hook: discovers active worktrees from task API, SSE `filetree` refresh + 60s poll
- `ProjectList` renders worktree sub-items (GitBranch icon, dirty indicator, ahead/behind tooltip) under the active project
- `useApi.ts`: `appendWorktree()` helper appends `?worktree=slug` to API URLs; all file/git hooks and mutations accept `worktree` param
- `usePersistence.ts` / `workspaceTypes.ts`: `layoutKey()` and `draftsKey()` include worktree slug — tabs/drafts/layout are independent per worktree
- `WorkspaceScreen` computes `effectivePath` from `projectPath + worktree` for session cwd; threads `worktree` through all hooks
- Worktree badges across all 4 task views (Board/List/Graph/Archive) + TaskDetailPanel worktree section (branch, dirty/clean, ahead/behind)
- `TaskToolbar`: worktree filter dropdown
- `WorkspaceSessionList`: worktree badge on session rows
- `App.tsx` manages `activeWorktree` state and passes `worktrees` + `onWorktreeSelect` to Workspace

**Why:**
- Parallel orchestration requires isolated working directories — multiple agents editing the same repo on the same branch causes merge conflicts. Git worktrees provide filesystem-level isolation with full git support (separate index, HEAD, working tree) while sharing the object store. The UI needed to surface worktree context throughout (which branch am I looking at?) and keep editor state independent per worktree.

**Key files:** `scripts/worktree-*.sh`, `server/src/lib/worktree.ts`, `server/src/middleware/project.ts`, `server/src/routes/tasks.ts`, `server/src/routes/sessions.ts`, `server/src/lib/project-watcher.ts`, `ui/src/hooks/useProjectWorktrees.ts`, `ui/src/hooks/useApi.ts`, `ui/src/hooks/usePersistence.ts`, `ui/src/hooks/workspaceTypes.ts`, `ui/src/components/ProjectList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/App.tsx`, `ui/src/tasks/` (TaskToolbar, BoardCard, ListRow, TaskGraphNode, TaskArchiveView, TaskDetailPanel)
**Verification:** `tsc --noEmit` clean, ESLint clean on all changed files
**Commit:** `750a521..266f395` (4 feature commits across parallel worker dispatch)
**Next:** Worktree provision hook (`scripts/worktree-provision.sh`), automated worktree lifecycle from task state transitions
**Blockers:** None

## 2026-04-11: Tasks v2 mobile polish

**What changed:**
- Board view: scroll-snap horizontal swipe on mobile (`scrollPaddingInlineStart: 12px`, one column at a time with next-column peek)
- List view: `MobileListRow` component replaces 7-column table on mobile (44px fixed-height rows, StateDot + title + parent + priority only)
- TaskToolbar: single-row mobile layout with icon-only view tabs, collapsed SlidersHorizontal filter dropdown, toggle search (full-width when open)
- Graph toolbar: larger 32px touch targets on mobile, collapse/expand controls hidden to save space
- Graph view: removed duplicate `TaskGraphDetailPanel` mobile bottom sheet — parent `TaskScreen` handles unified detail panel (was showing two overlapping bottom sheets)
- Detail panel: mobile bottom sheet increased from 50vh to 75vh, added backdrop overlay (`--sol-overlay-bg`) with dismiss-on-tap, added sticky header with close button
- X close button added to task panel toolbar (both desktop and mobile) — wires `onLayoutUpdate({ showTasks: false })` + close tab
- Tasks toggle in Browse pane gets `paddingBottom: max(8px, env(safe-area-inset-bottom))` for notch devices
- Archive rows: taller touch targets on mobile (minHeight 44px), search input h-8, hide task ID + unarchive button
- CSS: `.no-scrollbar` utility added for hidden-scrollbar horizontal overflow

**Why:**
- Tasks desktop UX was polished but mobile was untouched — toolbar overflowed, board squeezed 4 columns into 360px, list showed 7 columns, no touch target optimization, no close button, double bottom sheet bug on graph view

**Key files:** `ui/src/tasks/` (TaskToolbar, TaskScreen, TaskBoardView, TaskListView, MobileListRow, TaskGraphScreen, TaskGraphToolbar, TaskDetailPanel, TaskArchiveView), `ui/src/workspace/` (WorkspaceEditorColumn, WorkspaceLayout), `ui/src/index.css`
**Verification:** `tsc --noEmit` clean, ESLint clean on all changed files
**Commit:** `95a5991`
**Next:** Remaining mixed files (TaskToolbar worktree filters, TaskDetailPanel worktree section, archive worktree indicators, WorkspaceScreen worktree props) to be committed with the worktree feature
**Blockers:** None

## 2026-04-11: Tasks v2 UI polish — UX + visual overhaul

**What changed:**
- Tasks is no longer an editor tab — toggled from sidebar bottom `TASKS` section header, takes full editor column height (no tab bar / breadcrumbs above)
- Graph nodes reverted to single-line 36px layout with right-aligned dep count (was 48px two-line with "x deps" text)
- Native `<select>` dropdown replaced with custom styled popover (keyboard nav, click-outside)
- Unified detail panel: graph view now uses shared editable `TaskDetailPanel` (was separate read-only `TaskGraphDetailPanel`)
- Archive rows clickable — opens detail panel with selection highlight and readOnly mode ("Archived" badge)
- Design doc links open in workspace editor for file paths, new tab for URLs only
- Task ID displayed in detail panel header (monospace badge)
- Children section + segmented progress bar added to detail panel for parent tasks
- Typography audit: font-weight reductions across list headers, column headers, filter pills, graph nodes
- Board column gap widened (8px → 12px), done column compact card readability improved
- Fixed broken `StateBadge` in graph detail panel (`STATE_COLORS[state] + '22'` → `color-mix()`)

**Why:**
- First pass was functional but UX had many rough edges — archive couldn't show detail, two different detail panels, native dropdowns, design doc links broken, graph nodes wasting space
- Sidebar toggle is more natural than a pseudo-tab for a panel that replaces the editor area

**Key files:** `ui/src/tasks/` (TaskScreen, TaskDetailPanel, InlineEdit, TaskGraphNode, TaskArchiveView, board/*, list/*), `ui/src/workspace/` (WorkspaceEditorColumn, WorkspaceLayout, WorkspaceScreen, WorkspaceTabBar), `ui/src/tasks/taskGraphModel.ts`
**Verification:** `tsc --noEmit` clean, ESLint clean (no new errors)
**Commit:** `796369c..9b57d98`
**Next:** None planned — polish pass complete
**Blockers:** None

## 2026-04-11: Compare mode UI + diff/changes UX polish

**What changed:**
- Compare mode in Changes section — toggle via GitCompareArrows icon, select base/head refs via CompareRefPicker, browse changed files, open compare diff tabs (`diff:path?base=X&compare=Y`)
- `openPreviewDiffTabById` action in useLayoutState for pre-built tab IDs
- GitChangeItem: status pill badges with tinted bg, active left accent border colored by status
- CompareRefPicker: swap rotation animation, accent-tinted bg, monospace ref names, chevron rotation on open
- RefSearchDropdown: filter tabs (All/Branches/Tags/Commits) with counts, author + relative time on commits, Tab key cycles tabs
- DiffTab: stronger diff colors (10%/30%), toolbar separators, fold icon on collapsed context, refined file dropdown with status badges, better empty/binary states
- Server refs endpoint: 50 commits (was 20), author name in response, tab-delimited log format
- Loading states: skeleton shimmer animation; empty states: two-line contextual messages

**Why:**
- T6 from git-compare design: compare mode in Changes section
- UX polish pass for world-class dev tool feel across diff/changes experience

**Key files:** server/src/routes/git.ts, ui/src/hooks/useApi.ts, ui/src/hooks/useLayoutState.ts, ui/src/hooks/useWorkspaceState.ts, ui/src/workspace/WorkspaceScreen.tsx, ui/src/workspace/WorkspaceLayout.tsx, ui/src/workspace/CompareRefPicker.tsx, ui/src/workspace/RefSearchDropdown.tsx, ui/src/workspace/WorkspaceSidebar.tsx, ui/src/workspace/diff/DiffTab.tsx, ui/src/index.css
**Verification:** TypeScript clean (no errors in changed files), ESLint passes (no new issues)
**Commit:** b615bb1
**Next:** T7 (diff hook + tab encoding + tab labels), T8 (diff toolbar context + file navigation dropdown)
**Blockers:** None

## 2026-04-10: Git compare endpoint + diff ref extension

**What changed:**
- Added `GET /api/git/:project/compare?base=REF&compare=REF` — returns `{ files: GitChange[] }` with M/A/D status (renames mapped to M). Uses `git diff --name-status` with spawnSync args array (injection-safe). Validates params, returns 400/500 via `fail()`.
- Extended `GET /api/git/:project/diff` with optional `?base=REF&compare=REF` — runs `git diff base compare -- path` when present, falls back to existing HEAD behavior when absent.

**Why:**
- Server foundation for the git compare feature (design: `doc/todo/git-compare/design.md`). The compare endpoint (T2) provides the file list for the compare sidebar, and the diff extension (T3) enables per-file diffs between arbitrary refs.

**Key files:** server/src/routes/git.ts, doc/main/backend/routes.md
**Verification:** `cd server && npm test` — 138 tests pass
**Commit:** pending
**Next:** UI components — ref picker (T4/T5), compare mode in Changes section (T6), diff tab encoding (T7), toolbar file navigation (T8)
**Blockers:** None

## 2026-04-10: Git refs endpoint for compare feature

**What changed:**
- Added `GET /api/git/:project/refs` endpoint returning branches, tags, and recent commits
- 5-second in-memory cache per project (same pattern as gitSnapshots)
- Branches via `git branch -a`, tags via `git tag --sort=-creatordate` (capped at 50), recent commits via `git log -20`
- Graceful degradation: returns empty arrays on git command failure

**Why:**
- First server-side piece of the git compare feature (T1 in doc/todo/git-compare/design.md)
- UI ref picker needs this data to populate branch/tag/commit search dropdown

**Key files:** `server/src/routes/git.ts`
**Verification:** `cd server && npm test` — 138 tests pass
**Commit:** pending
**Next:** T2 (compare endpoint), T3 (extend diff endpoint)
**Blockers:** None

## 2026-04-10: Markdown split direction toggle + mermaid flash fix

**What changed:**
- Added `SplitDirection` type (`'horizontal' | 'vertical'`) to `WorkspaceLayout`
- Split mode now supports both orientations: side-by-side (horizontal, default) and top-bottom (vertical)
- Direction toggle icon appears in tab bar when split mode is active (Rows2/Columns2 lucide icons)
- Persisted in localStorage with migration fallback for old state missing `splitDirection`
- Fixed mermaid preview flash: deferred `setHtml` until all mermaid diagrams are rendered in a detached DOM, preventing brief raw-source flicker on each keystroke

**Why:**
- VS Code-style split flexibility — vertical split useful for wide files or narrow viewports
- Mermaid flash was a pre-existing UX issue: `setHtml(rawHtml)` eagerly replaced preview with unrendered mermaid source text before async rendering completed

**Key files:** workspaceTypes.ts, usePersistence.ts, WorkspaceEditorArea.tsx, WorkspaceEditorColumn.tsx, WorkspaceScreen.tsx, WorkspaceTabBar.tsx
**Verification:** TypeScript compiles clean, Playwright mutation observer confirms 1 DOM update per keystroke (no double-render), persisted state migration tested
**Commit:** c0b9a0f
**Next:** Full editor split (multiple files side-by-side) as future enhancement
**Blockers:** None

## 2026-04-10: Frontend polish — dialog speed, accessibility, CSS consistency

**What changed:**
- Removed dialog enter animation (instant open, IDE-first principle)
- Added `--sol-glass-bg` CSS var, unified glass-card opacity across DialogShell, NotificationPanel, FileSearch
- Session status dots: error state now uses hollow ring for color-independent differentiation
- Added aria-labels to DiffTab hunk nav buttons and TaskGraph filter chips
- Added `aria-live="polite"` on session list containers
- Section headers: sentence-case instead of uppercase
- Resize handles: wider invisible hit area via `::before` pseudo-element
- SSE reconnect: added random jitter to backoff to prevent thundering herd
- Session read timestamps: use actual entry timestamps instead of `Date.now()`
- Replaced hardcoded rgba in status-glow keyframe and editor diff popup shadow

**Why:**
- Dialog 300ms enter animation felt sluggish for a dev tool (user feedback)
- Accessibility gaps: color-only status indicators, missing aria-labels
- Consistency: scattered hardcoded values should use CSS vars

**Key files:** DialogShell.tsx, index.css, WorkspaceSessionList.tsx, useSSE.ts, useSessionUnreadState.ts, ResizeHandle.tsx, SectionHeader.tsx, editorTheme.ts
**Verification:** TypeScript compiles clean, lint passes (no new errors)
**Commit:** 87b77aa
**Next:** None immediate — review doc at `doc/todo/frontend-redesign/independent-review-claude-zh.md` has deferred items (pinch-zoom, SSE heartbeat, batch refetch)
**Blockers:** None

## 2026-04-10: Fix AddProjectDialog path autocomplete filtering

**What changed:**
- Typing after a `/` in the path input now filters shown subdirectories by typed prefix instead of clearing them.
- Added "No matches" feedback when the filter yields zero results.
- Fixed stale entries flash when navigating into a subdirectory by separating `allEntries` (raw server response) from `entries` (derived by case-insensitive prefix filtering).

**Why:**
- Previously, autocomplete entries were cleared as soon as the user started typing because the path no longer ended with `/`. Now `allEntries` holds the raw server response and `entries` is derived by filtering.

**Key files:** `ui/src/components/AddProjectDialog.tsx`
**Verification:** Type-check clean, lint clean, 7/7 E2E tests pass
**Commit:** f19e7fb
**Next:** None
**Blockers:** None

## 2026-04-10: Fix markdown preview scroll issues

**What changed:**
- Wide tables now horizontally scrollable — custom `renderer.table` in `markdown.ts` wraps `<table>` in `<div class="table-scroll">` with `overflow-x: auto`.
- Code blocks no longer trap vertical scroll — changed `<pre>` from `overflow: auto; overscroll-behavior: contain` to `overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain`, so vertical wheel events propagate to parent.

**Why:**
- Tables wider than the preview area were clipped with no way to see right columns (`overflow-x: hidden` on container).
- Mouse over a code block locked all scrolling because `overscroll-behavior: contain` trapped both axes.

**Key files:** `ui/src/index.css`, `ui/src/workspace/markdown.ts`
**Verification:** TypeScript compilation clean, lint shows only pre-existing errors
**Commit:** 308f748
**Next:** None
**Blockers:** None

## 2026-04-10: Dark mode theme adaptation

**What changed:**
- Markdown preview: replaced hardcoded palette vars (`--sol-base00`, `--sol-base2`, `--sol-base01`) with new semantic vars (`--sol-preview-text`, `--sol-code-bg`, `--sol-code-fg`, `--sol-preview-heading`, `--sol-preview-heading-border`) that flip correctly between light/dark. Light mode values preserved, dark mode aligned with VSCode Solarized Dark.
- Added `--sol-overlay-bg`, `--sol-subtle-bg`, `--sol-subtle-bg-active` semantic vars for UI surfaces that need to adapt to both themes.
- Fixed ComposeTray dialog background (`--sol-base3` → `--sol-editor-bg`), VoiceControl button backgrounds, TerminalKeyBar container/button colors, DiffTab highlight colors — all replaced hardcoded `rgba(0,0,0,...)` with `var(--sol-subtle-bg)` or `color-mix()` with theme vars.
- DialogShell default overlay now uses `var(--sol-overlay-bg)` (light: `rgba(0,0,0,0.25)`, dark: `rgba(0,0,0,0.5)`).
- Codex icon: switched from `<img>` to inline SVG with `fill="currentColor"` so it adapts to text color in both themes.
- Dark mode editor cursor: `#93a1a1` → `#d30102` (red, matching VSCode Solarized Dark).
- Removed unused `--vscode-text-preformat-fg` declarations.

**Why:**
- Dark mode was added but many components still used hardcoded light-mode colors — invisible buttons, blinding code blocks, cream-colored dialog on dark background.

**Key files:** `ui/src/index.css`, `ui/src/components/ComposeTray.tsx`, `ui/src/components/DialogShell.tsx`, `ui/src/components/VoiceControl.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/SessionIcons.tsx`, `ui/src/workspace/diff/DiffTab.tsx`
**Verification:** `vite build` clean, lint shows only pre-existing errors
**Commit:** 416fee9..754dc34
**Next:** None
**Blockers:** None

## 2026-04-10: Add notification bell to mobile header

**What changed:**
- Extracted `NotificationBell` component from inline App.tsx bell code. Self-contained: manages own open/close state, renders bell icon + badge + panel.
- Passed as `notificationBell` ReactNode slot through Workspace → WorkspaceLayout for mobile header rendering.
- Panel width capped at `100vw - 24px` for narrow mobile screens.

**Why:**
- Mobile had no way to access notification history — only transient toasts. Desktop and mobile now have parity.

**Key files:** `ui/src/components/NotificationBell.tsx` (new), `ui/src/App.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`
**Verification:** `tsc --noEmit` clean
**Commit:** 1c7f7fc
**Next:** None
**Blockers:** None

## 2026-04-10: Fix notification bell mark-all-read + panel font sizes

**What changed:**
- Bell click no longer marks all notifications as read on panel open — just toggles visibility.
- Clicking an individual notification item now marks it as read (exported `markRead(id)` from `useNotifications`).
- NotificationPanel font sizes bumped 1-2px to match app conventions (titles 13px, body 12px, meta 10-11px).

**Why:**
- Opening the panel was clearing the unread badge immediately, defeating the purpose of unread state.
- Panel font sizes (9-11px) were manually set below the app's baseline (12-13px), making the list harder to read.

**Key files:** `ui/src/App.tsx`, `ui/src/components/NotificationPanel.tsx`, `ui/src/hooks/useNotifications.ts`
**Verification:** `tsc --noEmit` clean
**Commit:** 278da4b
**Next:** None
**Blockers:** None

## 2026-04-09: Fix toast notification click navigation + compact git changes

**What changed:**
- Toast notifications now navigate to project/session on click. Replaced broken `toast()` `onClick` (silently ignored by Sonner v2) with `toast.custom()` full-area click handler.
- GitChangeItem switched to compact single-line layout (was multi-line with stacked name/dir).

**Why:**
- Sonner v2.0.7 `ToastT` has no `onClick` property — only `Action.onClick` for action/cancel buttons. The `<li>` element never wires a click handler. `toast.custom()` is the only way to get full-area clickable toasts.
- Git change items were unnecessarily tall for sidebar density.

**Key files:** `ui/src/hooks/useNotifications.ts`, `ui/src/workspace/WorkspaceSidebar.tsx`
**Verification:** `tsc --noEmit` clean
**Commit:** 7ecfcc9
**Next:** None
**Blockers:** None

## 2026-04-09: Comprehensive frontend polish — 15-task orchestrated pass

**What changed:**
- **Accessibility**: ARIA labels on icon-only buttons, landmark roles (main/navigation/complementary), git status letter indicators (M/A/D/U), menu keyboard navigation (Arrow/Enter/Home/End)
- **DialogShell v2**: stack-safe keyboard (topmost shell wins), focus trap only for overlay mode, exit animations, ARIA dialog semantics (role/aria-modal/aria-labelledby)
- **New components**: BadgeCount (extracted from 3 duplicates), ShortcutSheet (? key opens cheatsheet)
- **Interactions**: CSS hover on conflict banner, 350ms long-press, dirty tab close on hover, tab bar scroll fade gradient, preview tab label, Quick Open recent files, search cap banner, session status dots (error/completed), notification timestamp auto-refresh
- **Architecture**: fileStateMachine.ts (explicit state transitions), WorkspaceScreen 750→499 lines (extracted EditorColumn, SessionSection, SidebarResize), static style extraction from render loops
- **Visuals**: Solarized scrollbar, skeleton loaders (file tree, diff, mermaid), dark theme tuning (cursor, shadows, rhythm-pulse), simplified 3px solid sash (removed panel elevation shadows)
- **Performance**: word-diff threshold (skip >500 lines)

**Why:**
- Independent frontend review identified gaps in accessibility, interaction quality, visual polish, and architecture. Orchestrated 15 parallel workers across 3 batches for efficient implementation.

**Key files:** `ui/src/components/DialogShell.tsx`, `ui/src/components/BadgeCount.tsx`, `ui/src/hooks/fileStateMachine.ts`, `ui/src/workspace/ShortcutSheet.tsx`, `ui/src/workspace/WorkspaceEditorColumn.tsx`, `ui/src/workspace/useWorkspaceSessionSection.tsx`, `ui/src/workspace/useWorkspaceSidebarResize.ts`, `ui/src/index.css`, `ui/src/components/Menu.tsx`, plus 24 other files
**Verification:** All accept criteria independently verified per task, Codex review (3 findings fixed: stack-safe keyboard, overlay-only focus trap, ARIA semantics)
**Commit:** 757bf4b (33 files, +2080 -540)
**Next:** None
**Blockers:** None

**What changed:**
- New `DialogShell` component extracts shared dialog chrome (overlay, glass card, backdrop blur, animation, Escape/click-outside dismissal, focus trapping, focus restoration) from 5 consumers: ConfirmDialog, AddProjectDialog, WorkspaceSearch (FileSearch), ComposeTray, NotificationPanel

**Why:**
- Remove duplicated dialog chrome across 5 components, fix accessibility (focus trapping, focus restoration)

**Key files:** `ui/src/components/DialogShell.tsx` (new), `ui/src/components/ConfirmDialog.tsx`, `ui/src/components/AddProjectDialog.tsx`, `ui/src/workspace/WorkspaceSearch.tsx`, `ui/src/components/ComposeTray.tsx`, `ui/src/components/NotificationPanel.tsx`
**Verification:** `cd ui && npm run lint` passes (0 new errors)
**Commit:** 0c3d03e, 4dcd402
**Next:** None
**Blockers:** None

## 2026-04-09: Frontend polish — font inheritance, CSS hover, sizing, menu collision

**What changed:**
- Body `font-family` switched from monospace to `var(--font-ui)` — UI font now inherits everywhere, eliminating ~40 inline `fontFamily` overrides across 18 components
- JS `onMouseEnter/onMouseLeave` hover handlers replaced with Tailwind `hover:bg-sol-hover-bg` in 8 components (Menu, SessionItem, GitChangeItem, HistoryItem, FileExplorerNode, NotificationPanel, SearchResult, TabBar close button)
- Dialog header heights unified to `h-10` (ConfirmDialog h-11 → h-10, NotificationPanel h-9 → h-10)
- Unread badges unified to `16x16px / text-[9px]` across bell icon, session list, project list
- Menu component now detects viewport overflow and repositions via `requestAnimationFrame`
- Removed dead `--tab-h: 36px` CSS token

**Why:**
- Post-redesign review found maintenance burden (inline fontFamily everywhere), fragile hover patterns (JS handlers don't clean up on unmount), visual inconsistencies (badge/dialog sizes), and a functional bug (menus clipped at screen edges).

**Key files:** `ui/src/index.css`, `ui/src/components/Menu.tsx`, plus 20 component files
**Verification:** TypeScript clean, lint clean (no new errors), all 6 Playwright E2E suites pass
**Commit:** 3b945ac
**Next:** None
**Blockers:** None

## 2026-04-09: Visual redesign — "Precision Instrument"

**What changed:**
- Full visual redesign across 22+ UI files using `frontend-design` plugin methodology
- **Typography**: Loaded Instrument Sans (Google Fonts) for UI chrome; code/terminal stays monospace
- **Elevation system**: 4-level theme-aware box-shadows (`--elevation-0` to `--elevation-3`)
- **Glass effects**: All dialogs, menus, panels use `backdrop-filter: blur(12px) saturate(150%)` with semi-transparent backgrounds
- **Motion**: Entry animations for dialogs (`dialog-enter`), menus (`menu-enter`), panels (`panel-slide-in`), overlays (`overlay-enter`). All respect `prefers-reduced-motion`.
- **Spacing**: Section headers 22->28px, tabs 32->36px, breadcrumbs 24->28px. List item padding kept at original density.
- **Transitions**: Unified cubic-bezier timing (fast 120ms, normal 200ms, slow 300ms)
- **Components**: SectionHeader chevron rotation, resize handle accent color, refined command palette
- **`--sol-warning` CSS var**: Replaced all hardcoded `#C4A241` hex across badge, tab borders, conflict banner, file explorer
- **Session/History items**: Summary now inline after title with `line-clamp-2` instead of truncated second row
- **NotificationPanel**: Fixed positioning, removed luminous-edge
- **Luminous Edge removed**: Initially added as signature gradient border, removed after review — too decorative for a developer tool

**Why:**
- UI was functional but flat and utilitarian (6.5/10). The frontend-design plugin emphasizes bold, intentional aesthetics that avoid generic "AI slop". Solarized palette was kept as the distinctive foundation; the redesign added depth, motion, and typographic hierarchy.

**Key files:** `ui/src/index.css` (foundation), `ui/index.html` (font loading), plus 22 component files
**Verification:** `vite build` passes, all 6 Playwright E2E test suites pass, lint clean (no new errors)
**Commit:** a8642e1..c8ff4df
**Next:** None
**Blockers:** None

## 2026-04-09: Fix resume timeout + unify icons

**What changed:**
- **Resume PID fix** (multmux repo): `getAgentPid()` was called once after `createSession()`. If the agent hadn't spawned yet inside the wrapper, it returned null and PID was never written to the state file → downstream poll for `pid > 0` timed out. Fixed by polling for up to 3s with 200ms intervals.
- **Icon unification**: replaced custom SVG provider icons with lucide-react, unified icon colors to CSS vars.

**Why:**
- Resume of Claude sessions with large context would timeout (10s) even though the session started successfully. Root cause was in multmux's single-attempt PID capture, not the workflow server's timeout.

**Key files:** `~/workspace/multmux/src/commands/start.ts`, `ui/src/App.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/SessionIcons.tsx`
**Verification:** 133 server tests pass, 150 multmux tests pass
**Commit:** 23ad001 (multmux), 2f45834..deb3652 (workflow)
**Next:** None
**Blockers:** None

## 2026-04-09: Notification list panel + session auto-scroll

**What changed:**
- Notification bell icon in header with unread badge. Click opens dropdown panel showing accumulated notifications (max 50, in-memory). Items show title, message, relative time. Click navigates to project/session.
- `useNotifications` now accumulates items alongside existing toast/browser notification delivery.
- `SessionItem` auto-scrolls into view when activated (`scrollIntoView({ block: 'nearest', behavior: 'smooth' })`).

**Why:**
- Sonner toasts auto-dismiss in ~4s — users miss notifications when not watching. Persistent list solves this.
- Active session could be off-screen in a long session list, requiring manual scrolling to find it.

**Key files:** `ui/src/components/NotificationPanel.tsx`, `ui/src/hooks/useNotifications.ts`, `ui/src/App.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`
**Verification:** tsc --noEmit clean, vite build passes
**Commit:** 0cd1edc
**Next:** None
**Blockers:** None

## 2026-04-09: UI polish — icons, dialogs, notifications

**What changed:**
- Replaced all Unicode symbols (☼☾▸▾×⚠◆●↻✕▶⇄···) with lucide-react icons across 11 component files.
- Added `ConfirmDialog` component for destructive actions (remove project, delete file), replacing native `confirm()`.
- Replaced native `alert()` with sonner `toast.error()` for error feedback.
- Removed server-side osascript notifications (fired macOS system alerts that opened wrong app on click).
- Replaced `useBrowserNotifications` (dead code — permission never requested) with `useNotifications`: foreground → sonner toast, background → Web Notification API. Auto-requests permission on mount.
- Added `sonner` dependency, removed unused `@codemirror/theme-one-dark`.
- Theme toggle upgraded from Unicode ☼/☾ to Lucide Sun/Moon pill toggle.

**Why:**
- Unicode symbols rendered poorly at small sizes. Lucide icons are crisp, consistent, and scalable.
- Native `alert()`/`confirm()` block the main thread and look out of place in a polished UI.
- osascript notifications were unreachable (click opened Script Editor, not browser) and redundant with SSE-based browser notifications.

**Key files:** `ui/src/components/ConfirmDialog.tsx`, `ui/src/hooks/useNotifications.ts`, `server/src/lib/notify.ts`, `ui/src/App.tsx`, `ui/src/components/FileExplorer.tsx`, `ui/src/workspace/SectionHeader.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`
**Verification:** tsc --noEmit clean, vite build passes, 133 server tests pass
**Commit:** df9be90
**Next:** None
**Blockers:** None

## 2026-04-09: History reader perf (1.5s → 20ms)

**What changed:**
- `getClaudeHistory()` now reads only head (16KB) + tail (8KB) per JSONL instead of full-reading all 307MB. Head has the first user message, tail has the last custom-title.

**Why:**
- 240 JSONL files totaling 307MB made the history endpoint take 1.5s. Partial reads bring it to ~20ms (cold 118ms).

**Key files:** `server/src/lib/history.ts`
**Verification:** 133 server tests pass, benchmark: 240 sessions in 20ms (warm), 56/57 titles found
**Commit:** 874ce99
**Next:** None
**Blockers:** None

## 2026-04-09: Dark/Light theme selector

**What changed:**
- CSS variable foundation: semantic vars (`--sol-bg`, `--sol-text`, `--sol-header-bg`, etc.) in `:root` + `[data-theme="dark"]` block with VS Code Solarized Dark values. Tailwind `@theme` block for `bg-sol-*`/`text-sol-*`/`border-sol-*` tokens.
- Theme module (`ui/src/lib/theme.ts`): `getTheme()`, `setTheme()`, `toggleTheme()`. FOUC prevention via inline `<script>` in `index.html`.
- CodeMirror: `EditorView.theme()` + `HighlightStyle` using CSS var strings — no compartment needed, vars cascade automatically.
- Terminal: `MutationObserver` on `data-theme` attribute, rebuilds xterm ITheme from resolved CSS vars.
- Migrated ~30 component files from `SOLARIZED_LIGHT_UI` JS constants to CSS vars. Deleted `solarizedLight.ts` entirely.
- Sun/moon toggle in desktop header + mobile PaneSwitch bar. `<meta theme-color>` updates on toggle.

**Why:**
- Users requested dark mode. CSS vars with `data-theme` attribute is the simplest approach — no React state needed, all surfaces react automatically.

**Key files:** `ui/src/index.css`, `ui/src/lib/theme.ts`, `ui/src/lib/editorTheme.ts`, `ui/src/components/Terminal.tsx`, `ui/src/App.tsx`, `ui/index.html`
**Verification:** vite build passes, Playwright e2e 29/29 pass, Codex review findings addressed
**Commit:** 5ed07dd..a8a7cb7
**Next:** None
**Blockers:** None

## 2026-04-09: Session History tab

**What changed:**
- History data reader (`server/src/lib/history.ts`): reads Claude JSONL files (custom-title last-wins, slash-command normalization) + Codex SQLite/session_index.jsonl (thread_name last-wins). Optional sessions-index.json enrichment.
- `GET /api/sessions/history?project=<name>` route returning `HistorySession[]` sorted by modified DESC, capped at 200, with live session tagging.
- Resume passthrough: `startMultmuxSession()` accepts `resumeId`, passes `--resume` to multmux CLI. Collision-safe handle discovery (scan state files by sessionId). Idempotency preflight prevents duplicate spawns. Handle return fix (resolved handle, not echoed name).
- Multmux `--resume` flag in `~/workspace/multmux/src/commands/start.ts`: extracts flag, rewrites Codex to subcommand, writes sessionId in initial state file.
- UI: `useHistory` hook (on-demand, not polled), `HistorySession` type, `formatRelativeTime()`, Live/History tab toggle in Sessions section, `WorkspaceHistoryList` component with resume/go-live flow.

**Why:**
- Users need to browse and resume past Claude/Codex sessions. Resume must go through multmux (owns session lifecycle). Claude's sessions-index.json is unreliable (GitHub #25032, #18897) — JSONL files are the primary source.

**Key files:** `server/src/lib/history.ts`, `server/src/routes/sessions.ts`, `server/src/lib/multmux.ts`, `ui/src/workspace/WorkspaceHistoryList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useApi.ts`, `~/workspace/multmux/src/commands/start.ts`
**Verification:** 133 server tests pass, Playwright e2e 29/29 pass, Codex review findings addressed
**Commit:** b323789..a8a7cb7
**Next:** None
**Blockers:** None

## 2026-04-08: Codex session start returns instantly (no blocking on agent idle)

**What changed:**
- `startMultmuxSession()` now spawns the multmux CLI detached and polls for the state file to have a non-zero PID (~1-2s), instead of awaiting full process completion (which blocks on `waitForReady` up to 30s).
- The multmux process continues in the background handling `waitForReady`, Codex `/rename`, and sessionId resolution.
- Removed unused `MULTMUX_START_TIMEOUT_MS` import from multmux.ts.

**Why:**
- Codex takes 15-30s to show its idle prompt, while Claude takes 1-3s. The old approach awaited full multmux completion before calling `setActiveSession`, so the UI POST would timeout (15s) or block too long — the session appeared in the sidebar via SSE but was never auto-attached. Users had to click the session manually.

**Key files:** `server/src/lib/multmux.ts`
**Verification:** 111 server tests pass, build clean
**Commit:** 381a534
**Next:** None
**Blockers:** None

## 2026-04-08: Reconciler GC restored with tmux server pre-check

**What changed:**
- Reconciler `checkStaleStates` restored to destructive GC (defense-in-depth for SIGKILL). The earlier log-only mode was reverted once the true root cause was found in multmux.
- `isTmuxAlive` keeps the tmux server pre-check (`list-sessions`) and 5s timeout — prevents false "dead" when tmux server is unreachable.
- Root cause was in multmux's wrapper EXIT trap, not the reconciler (see multmux repo commit `9ae23e5`): `tmux display-message` returns a random live session when the caller's session is dead, causing the wrapper to delete the wrong state file. Fixed by passing the handle explicitly as `$1` to the wrapper.

**Why:**
- The reconciler GC is useful as defense-in-depth (e.g. wrapper can't fire after SIGKILL). The tmux server pre-check makes false positives from server-down scenarios impossible.

**Key files:** `server/src/lib/session-reconciler.ts`
**Verification:** 111 server tests pass, state files stable across multiple reconciler cycles
**Commit:** ce8c2c6
**Next:** None
**Blockers:** None

## 2026-04-08: Archive 10 completed design projects

**What changed:**
- Archived 10 `doc/todo/` folders to `doc/archive/20260408_*/`:
  diff-viewer, editor-ux, md-link-nav, multmux-redesign, sidebar-collapse,
  time-awareness, voice-formatting, voice-formatting-v2, session-nav, sync-name
- Remaining in todo: autocomplete (partial — CM6 bugs), sessionhist (not started), superset-ref (reference only)

**Why:**
- Housekeeping — these projects are fully implemented and verified

**Key files:** `doc/archive/20260408_*/`
**Verification:** Each folder checked by agent against codebase for implementation completeness
**Next:** Fix autocomplete CM6 bugs, decide on sessionhist/superset-ref
**Blockers:** None

## 2026-04-08: Markdown link navigation — folder expansion and anchor scrolling

**What changed:**
- Folder links (hrefs ending with `/`, e.g., a `backend/` folder link) now expand the target folder in the file explorer sidebar instead of trying to open it as a file
- Anchor links (`#heading`) now scroll the preview to the matching heading — headings get slugified `id` attributes via a custom `renderer.heading` override (e.g., `## Key Data Flow` → `id="key-data-flow"`)
- New `slugify()` utility in `markdown.ts` converts heading text to lowercase, hyphen-separated IDs
- `WorkspaceEditorArea` detects folder links (trailing `/`) and delegates to `onNavigateDir` prop; anchor links use `scrollIntoView` on the matching `id`

**Why:**
- Folder links previously attempted to open as files, which failed. Now they integrate with the explorer's expand behavior, making doc navigation seamless.
- Anchor links had no working target — headings lacked `id` attributes, so `#heading` clicks did nothing.

**Key files:** `ui/src/workspace/markdown.ts`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript clean, manual testing — folder links expand in sidebar, anchor links scroll to heading
**Commit:** f478339

## 2026-04-08: Markdown preview link navigation

**What changed:**
- Clicking relative file links in markdown preview now opens the target file in an editor tab instead of causing a page refresh
- External URLs (http/https) open in a new browser tab via `window.open`
- Anchor-only links (`#heading`) pass through normally for in-page navigation
- `resolveRelativePath()` utility resolves `./`, `../`, and bare relative paths against the current file's directory

**Why:**
- Relative links in markdown files (e.g., a `./overview.md` link) previously triggered a full page navigation, breaking the SPA experience. Now they integrate with the tab system like any other file open action.

**Key files:** `ui/src/workspace/markdown.ts`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript clean, manual testing — relative links open in tabs, external links open in new browser tab, anchor links scroll in-page
**Commit:** 4897629

## 2026-04-08: Pending rename for processing sessions

**What changed:**
- Session rename now works while session is processing: queued as pending, auto-fires when idle
- Session list shows `name → newName` indicator for pending renames
- Pending state persisted to `localStorage` (`workflow-pending-renames:<project>`) — survives refresh and project switching
- Guard against premature cleanup: effect skips when sessions haven't loaded yet (`sessions === null`)

**Why:**
- Rename API only works on idle sessions (multmux CLI constraint). Previously, renaming a processing session silently failed. Now the UI queues it and handles it automatically.

**Key files:** `ui/src/workspace/useWorkspaceSessions.ts`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript clean, manual testing — pending rename persists across refresh/project switch, auto-fires on idle
**Commit:** b1bd912

## 2026-04-08: Smooth scroll sync for mobile preview and desktop split mode

**What changed:**
- Mobile preview scroll: replaced React synthetic `onScroll` with native passive listener; touch devices debounce to scroll-end (120ms) for native momentum
- Desktop split-mode sync: imperative sync channel bypasses React state entirely — each side registers a LERP scroll function, called directly from the other's scroll handler
- LERP interpolation (ease=0.2) on the passive side eliminates micro-jitter during momentum deceleration; `wheel`/`touchstart` events cancel LERP on direct user interaction
- Cached block anchor positions (`buildAnchorCache`) — zero DOM reads during scroll; rebuilt on html change + ResizeObserver
- `position: relative` on `.markdown-preview` ensures `offsetTop` is container-relative for correct cache coordinates
- Local viewport line state in `WorkspaceEditorArea` (debounced persist) avoids full Workspace tree re-render; `latestLineRef` flush on tab/mode change prevents stale initial positioning; `useLayoutEffect` prevents mount flash

**Why:**
- Mobile preview momentum scrolling was choppy — per-frame `querySelectorAll` + React `setState` disrupted the compositor thread
- Desktop split sync had visible jitter on the passive side — programmatic `scrollTop` jumps are visible during deceleration
- VS Code has the same known limitation (microsoft/vscode#68623, marked out-of-scope); LERP interpolation is the industry best practice

**Key files:** `ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/index.css`
**Verification:** TypeScript clean, manual testing on desktop (split sync both directions) and mobile (preview momentum scroll)
**Commit:** 8537c7d
**Next:** None
**Blockers:** None

## 2026-04-08: Sidebar reorder (Changes above Search) and dynamic resize max

**What changed:**
- Reordered sidebar: Changes now renders above Search (higher usage frequency)
- `useResize` hook accepts `number | (() => number)` for dynamic max via ref
- Bottom section max heights computed from sidebar height minus fixed overhead (headers, projects, explorer min, tasks, resize handles)
- Added `shrink-0` to Changes and Search containers to prevent flex compression artifacts
- Re-clamp effect auto-shrinks sections when available space decreases (section toggle, window resize)
- `flexFallback` prioritizes Changes over Search when Explorer is collapsed

**Why:**
- Changes is used far more frequently than Search, deserves higher position
- Static pixel max (300px) prevented Changes from using available space on large screens
- Flex-shrink caused visual glitches where Search appeared to grow/shrink when dragging Changes handle

**Key files:** `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/useResize.ts`
**Verification:** TypeScript passes, Playwright E2E passes, Codex code review (3 findings addressed)
**Commit:** 8b55d8a
**Next:** None
**Blockers:** None

## 2026-04-08: Reconciler GC uses three-state liveness to prevent false session deletion

**What changed:**
- `isTmuxAlive` now returns three-state: `true` (alive), `false` (confirmed dead via exit code 1), `null` (uncertain — tmux error, timeout, or unavailable)
- `checkStaleStates` only deletes state files on confirmed death (`false`); sessions with uncertain status (`null`) are preserved in the live set

**Why:**
- Previously, any `tmux has-session` failure (including timeouts or tmux being temporarily unresponsive) was treated as "session dead," causing false deletion of `~/.multmux/sessions/<handle>.json` state files. This led to phantom session disappearances in the UI.

**Key files:** `server/src/lib/session-reconciler.ts`
**Verification:** Existing server tests pass
**Commit:** 402e4cd
**Next:** None
**Blockers:** None

## 2026-04-08: Voice formatter v2 — structure detection and raw copy

**What changed:**
- Formatter prompt upgraded with structure detection: numbered/bullet lists from 2+ sibling markers, explicit formatting commands (heading, bullet, code block)
- Added meaning-preservation constraint ("restructure for clarity, never alter intent")
- Whisper vocabulary conditioning now includes Claude, Codex, multmux
- Context snippets enriched: markdown files get formatting hints, terminal surface allows structure for agent prompts
- Contrastive few-shot examples prevent false-positive list detection on single ordinals
- ComposeTray: raw transcript now has Copy button and is text-selectable

**Why:**
- Voice formatting was cleanup-only (filler removal, punctuation) with no structural intelligence. Dictated lists came out as run-on sentences. Competitor analysis (SuperWhisper, Tambourine Voice) showed structure detection is table-stakes.
- Codex design review flagged: restrict implicit structure to 2+ markers, add contrastive examples, keep thinking off.

**Key files:** `server/src/lib/voice-prompts.ts`, `server/src/lib/__tests__/voice-prompts.test.ts`, `ui/src/components/ComposeTray.tsx`
**Verification:** 111 server tests pass, lint clean (pre-existing errors only)
**Commit:** 9b51bc7
**Next:** Test with real voice input, evaluate whether thinking model experiment is worth pursuing
**Blockers:** None

## 2026-04-08: Session counts in sidebar, tab context menu, terminal touch improvements

**What changed:**
- Project sidebar now shows active/total session count (e.g. `2/5`) next to each project, alongside existing unread badges
- Tab bar gains right-click context menu with Save (dirty files) and Close/Close Without Saving actions
- Terminal touch handling distinguishes scroll gestures (>8px delta) from long-press (text selection), enabling native text selection on mobile
- xterm `screenReaderMode` enabled on touch devices with CSS `::selection` highlight for accessibility tree

**Why:**
- Session counts give at-a-glance visibility into agent activity per project without switching
- Tab context menu provides standard editor affordance for save/close workflows
- Previous terminal touch handling intercepted all touch events, preventing text selection on mobile

**Key files:** `ui/src/App.tsx`, `ui/src/components/ProjectList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/index.css`
**Verification:** TypeScript type-check passed, lint clean (pre-existing errors only)
**Commit:** fad6bea..f19e750
**Next:** None
**Blockers:** None

## 2026-04-07: Fix editor scroll jitter, preview click cursor, markdown line breaks

**What changed:**
- Editor↔preview scroll sync now uses fractional viewport lines (sub-pixel precision) instead of integer line numbers, eliminating visible scroll snapping
- Added echo-back suppression (`lastSelfReportedLineRef`) so the editor doesn't snap its own scroll position when its reported viewport line round-trips through React state
- Preview click-to-cursor no longer force-scrolls the editor — uses `scroll: false` on jump request so cursor is placed without `scrollIntoView`
- Fixed intermittent off-by-one on preview click-to-cursor: each source line now gets equal share of block height via `Math.floor(lineStart + ratio * lineCount)` instead of uneven `Math.round` distribution
- Enabled `breaks: true` in `marked.parse()` so single newlines in markdown render as `<br>` (was collapsing multi-line text into single lines)

**Why:**
- Editor scroll was jittery due to viewport line sync feedback loop: scroll → report integer line → state update → prop change → snap scrollTop to line block top → visible position jump on every frame
- Preview click was scrolling the editor and sometimes placing cursor on wrong line
- Markdown preview was not rendering line breaks in plain text paragraphs

**Key files:** `ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/markdown.ts`
**Verification:** TypeScript type-check passed, lint clean
**Commit:** 60d7b23
**Next:** None
**Blockers:** None

## 2026-04-07: Add time awareness — dark pill clock + rhythm pulse

**What changed:**
- Clock restyled as dark pill badge (`base02` bg / `base2` text, `rounded-md`) for visual anchoring in Solarized Light UI
- Added rhythm pulse vignette overlay triggered at real clock quarter marks: :15/:45 light pulse (3s, 50% opacity), :00/:30 strong pulse (4s, full opacity)
- Clock interval aligned to minute boundaries to prevent skipping quarter-hour marks
- CSS animation uses opacity interpolation on static radial-gradient vignette (0.5 edge opacity) for smooth fade

**Why:**
- Clock was effectively invisible (13px, same `textDim` color as surrounding text)
- User wanted ambient time awareness without breaking flow state — periodic visual "breathing" at quarter-hour marks

**Key files:** `ui/src/App.tsx`, `ui/src/index.css`, `doc/todo/time-awareness/ux-design.md`
**Verification:** TypeScript type-check passed, lint clean (no new errors), build succeeded
**Commit:** 81c133a
**Next:** User verification — check pill visibility and pulse intensity at next quarter-hour
**Blockers:** None

## 2026-04-07: Fix Chinese/CJK IME input in terminal

**What changed:**
- Extended xterm v6 IME input fallback from touch-only to all platforms
- Changed `queueMicrotask` to `setTimeout(0)` for correct ordering with xterm's CompositionHelper timeout

**Why:**
- Chinese characters typed in terminal sessions were silently dropped on desktop — xterm v6's CompositionHelper can fail to extract committed text from its hidden textarea

**Key files:** `ui/src/components/Terminal.tsx`
**Verification:** Type-check passed, lint clean (no new errors)
**Commit:** 6aa0bd1
**Next:** User verification with Chinese IME input
**Blockers:** None

## 2026-04-06: Preserve shell sessions across detach

**What changed:**
- Removed the detached-shell idle reaper that had been added in the prior PTY cleanup hardening pass
- Kept the safe part of the fix: tmux attach PTYs are still destroyed on terminal detach and on server shutdown
- Updated backend and workspace terminal docs to state explicitly that neither shell sessions nor multmux sessions should disappear silently after a UI detach

**Why:**
- Terminal detach should only sever the browser attach, not mutate session liveness
- Silent shell cleanup conflicts with the expected workflow model where sessions remain visible and recoverable until the user explicitly kills them

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/constants.ts`, `doc/main/backend/libs.md`, `doc/main/backend/server.md`, `doc/main/ui/workspace/sessions-and-terminal.md`, `doc/PROGRESS.md`, `CLAUDE.md`
**Verification:** pending
**Commit:** pending
**Next:** Add diagnostics for `node-pty` attach failures without changing session liveness semantics
**Blockers:** None

## 2026-04-06: PTY leak hardening for terminal attach/detach

**What changed:**
- Centralized terminal detach cleanup through `releaseSession()` so tmux attach PTYs are always destroyed on WebSocket close and server shutdown
- Expanded shutdown cleanup from `SIGTERM` only to `SIGINT`, `SIGHUP`, and normal `exit`, covering more `tsx watch` and local dev restart paths
- Added terminal tests covering shell attach/release behavior and tmux attach cleanup
- Updated backend and terminal docs to describe detached-shell reaping and the broader shutdown cleanup behavior

**Why:**
- Workflow terminals were reaching a bad state where new `node-pty` attaches failed with `posix_spawnp failed`, leaving the UI stuck on disconnected shells
- The immediate trigger was leaked PTY/FD state from repeated terminal attach/detach and dev restarts, especially when cleanup did not run on every exit path

**Key files:** `server/src/lib/terminal.ts`, `server/src/index.ts`, `server/src/lib/constants.ts`, `server/src/lib/__tests__/terminal.test.ts`, `doc/main/backend/libs.md`, `doc/main/backend/server.md`, `doc/main/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd server && npm test` (108 passed), `curl http://localhost:3001/api/health`, `curl http://localhost:3001/api/sessions?project=workflow`, manual WebSocket attach smoke tests for `codex-mnnmijav` and `shell-1`
**Commit:** pending
**Next:** Add terminal resource-pressure logging when `node-pty` attach fails so future PTY regressions are easier to diagnose
**Blockers:** None

## 2026-04-06: Diff viewer — unified/split diff tab + word-level highlights

**What changed:**
- Added full diff viewer as a workspace tab (`DiffTab.tsx`) with unified and split view modes, j/k keyboard navigation between changes, collapsible unchanged context, and toolbar
- Rewrote `parseDiff.ts` to return `ParsedFileDiff` with canonical `DiffRow[]` per hunk — one model shared by both the diff tab and the gutter popup card
- Added `wordDiff.ts` module using `diff` (jsdiff) package for word-level diff computation (`computeWordDiff`, `pairChanges`), pre-computed at parse time so both views get highlights for free
- Upgraded `diffGutter.ts` popup with word-level highlights, change badges, line numbers, prev/next navigation, and Show more truncation
- Unified diff cache in `useWorkspaceDiff.ts` — stores raw + parsed per path, invalidates on git SSE changes
- `WorkspaceEditorArea.tsx` now renders `DiffTab` instead of the old raw `DiffView`
- Added `diff` + `@types/diff` dependencies to `ui/package.json`
- Extended `solarizedLight.ts` with CSS classes for popup badge, nav, linenum, and show-more elements

**Why:**
- The old diff display was raw text with no structure — no word-level highlights, no navigation, no split view
- Gutter popup showed plain added/deleted lines with no context about what changed within a line

**Key files:** `ui/src/workspace/diff/DiffTab.tsx`, `ui/src/lib/wordDiff.ts`, `ui/src/lib/parseDiff.ts`, `ui/src/lib/diffGutter.ts`, `ui/src/workspace/useWorkspaceDiff.ts`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/lib/solarizedLight.ts`
**Verification:** `ui/src/lib/__tests__/wordDiff.test.ts` (21 tests), `ui/src/lib/__tests__/parseDiff.test.ts`, server tests (106 passed), TypeScript clean
**Commit:** b2e039d..95c13cc
**Next:** Observe real usage, consider file-level diff navigation (prev/next file)
**Blockers:** None

## 2026-04-06: Multmux v2 workflow-state migration

**What changed:**
- Switched workflow server session discovery from per-project `.multmux/` directories to the global `~/.multmux/sessions/` directory
- Added `MULTMUX_SESSIONS_DIR`, replaced `tmuxSession` usage with `handle`, and threaded `sessionPath` through session attribution and Claude summary lookup
- Reworked project-watcher to use one global multmux sessions watcher with `sessionPath`-based project filtering
- Updated session reconciler to read the global sessions dir, delete stale files there, and backfill via `multmux status --json --path <project-path>`
- Removed `*-mt` fallback assumptions from terminal attach/name resolution and refreshed the affected server tests/docs

**Why:**
- Multmux v2 makes session state global and uses `sessionPath` instead of per-project directory scoping
- Workflow needed to follow the new contract so sessions started in subdirectories still show up under the right registered project

**Key files:** `server/src/lib/constants.ts`, `server/src/lib/multmux.ts`, `server/src/lib/project-watcher.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/terminal.ts`, `server/src/lib/session-summary.ts`, `server/src/routes/sessions.ts`
**Verification:** `cd server && npm test` (106 pass)
**Commit:** Uncommitted
**Next:** Verify against a live multmux v2 install once `~/.multmux/sessions/` exists locally
**Blockers:** Waiting on the parallel multmux repo refactor to create/populate the new sessions directory in a live environment

## 2026-04-04: Inline code autocomplete (Copilot-style)

**What changed:**
- Added GitHub Copilot-style inline code autocomplete to the CodeMirror editor
- Custom in-repo CM6 ghost text extension (StateField + ViewPlugin + Decoration + Tab/Esc keymap) — not using `codemirror-copilot` npm package due to edge cases with programmatic doc changes and stale cursors
- Server completion endpoint using OpenAI SDK + Groq baseURL (same pattern as voice formatting)
- Multi-model rotation with fallback: `qwen/qwen3-32b` → `kimi-k2-instruct` → `llama-3.1-8b-instant` (dodges per-model rate limits, ~3K effective RPD)
- UI toggle ("AI" button) in editor tab bar, persisted in localStorage
- Rate limit protection: 1500ms debounce, min 3 non-whitespace chars on line before triggering
- Context truncation: 6KB prefix (with file header retention) + 2KB suffix, line-aware, byte-measured
- End-to-end AbortSignal propagation: CM6 plugin → fetch → Hono route → OpenAI SDK

**Why:**
- Enable faster coding in the workflow editor without leaving the app
- Groq free tier provides zero-cost inference; multi-model rotation maximizes daily capacity

**Key files:** `server/src/lib/autocomplete.ts`, `server/src/routes/autocomplete.ts`, `ui/src/lib/editor/inlineAutocomplete.ts`, `ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `cd server && npm test` (104 pass, including 21 autocomplete tests), `cd ui && npx tsc --noEmit` (no errors in changed files)
**Commit:** 0d45baa..74b296e
**Next:** observe real completion quality, add normalization if suffix echo/fencing occurs
**Blockers:** None

## 2026-04-04: Sidebar expand/collapse UX redesign

**What changed:**
- Sidebar sections now use Explorer-flex model: Explorer body is always `flex:1`, bottom sections (Search, Changes, Tasks) have fixed resizable heights
- Resize handles appear between adjacent expanded section bodies (Explorer↔Search, Search↔Changes)
- `flexFallback` promotes first expanded bottom section to flex when Explorer is collapsed
- Eliminated fragile `availableSectionHeight`/`visibleHandleCount`/`explorerMax` calculations and ResizeObserver dependency
- Added `searchSize`/`changesSize` to layout persistence
- Explorer has `minHeight: 80`, bottom sections drop `shrink-0` with `minHeight: 50` — flex shrinks them on short windows (codex review fix)
- Projects section is now collapsible (`showProjects` toggle, same pattern as other sections)

**Why:**
- Sidebar sections had coupled layout behavior — toggling Changes changed Explorer's CSS mode (`flex:1` ↔ fixed height), causing unpredictable jumps. Multiple `flex:1` sections competed for space. Resize handles were sparse (only 2 inside sidebar).

**Key files:** `WorkspaceLayout.tsx`, `WorkspaceScreen.tsx`, `workspaceTypes.ts`, `usePersistence.ts`
**Verification:** `npx tsc --noEmit` clean, `cd server && npm test` 83/83 pass, codex review passed
**Commit:** ec67d2e..39065f2
**Next:** None
**Blockers:** None

## 2026-04-04: Voice formatting pipeline improvement

**What changed:**
- Replaced inline voice formatter prompts with shared speech-to-writing prompt (`voice-prompts.ts`) covering both terminal commands and editor prose in a single prompt
- Added Whisper `initial_prompt` conditioning with bilingual base sentence for better term recognition (Claude vs Cloud, etc.)
- Replaced direct `groq-sdk` formatter call with `openai` SDK multi-model fallback chain (`voice-formatter.ts`): qwen3-32b → kimi-k2 → gpt-oss-120b, leveraging per-model rate limits
- Added thinking-token stripping for Qwen3 `<think>` blocks
- Refactored `voice.ts` to thin handler importing new modules
- Added file-type context snippets derived from `filePath` extension
- 31 new tests (83 total passing) including golden test cases for bilingual, filler removal, self-correction, and fallback scenarios

**Why:**
- Voice formatting quality was mediocre — output read like cleaned-up speech, not typed text
- Groq API reliability issues (rate limits, model unavailability) caused total voice failure
- No Whisper vocabulary conditioning led to misrecognized product names

**Key files:** `server/src/lib/voice-prompts.ts`, `server/src/lib/voice-formatter.ts`, `server/src/routes/voice.ts`, `server/src/lib/__tests__/voice-*.test.ts`
**Verification:** 83 server tests passing, manual voice compose QA confirmed working
**Commit:** 648fbde..398798a
**Next:** Monitor formatting quality in practice, consider project-specific vocabulary if needed
**Blockers:** None

## 2026-04-04: Dynamic syntax highlighting for 100+ languages

**What changed:**
- Editor now async-loads language support for any file type via `@codemirror/language-data` (Kotlin, Go, Rust, Java, C/C++, SQL, YAML, etc.)
- Uses CodeMirror `Compartment` pattern: static languages (JS/TS/JSON/Python/Markdown) load instantly, all others resolve via `LanguageDescription.matchFilename()` and hot-swap into the editor

**Why:** Needed Kotlin (`.kt`) highlighting; rather than adding one language at a time, leveraged the existing `@codemirror/language-data` dependency to support 100+ languages with zero new packages.

**Key files:** `ui/src/components/Editor.tsx`
**Verification:** `tsc --noEmit` clean, dev server loads without blank page
**Commit:** `5abd272`
**Next:** None
**Blockers:** None

## 2026-04-04: VS Code Seti file icons + blank page fix

**What changed:**
- Replaced hand-drawn badge icons with real VS Code Seti icon theme SVGs (135 icons, full extension matching)
- Inlined icon dataset as static JSON (seti-definitions.json + seti-icons.json + setiIcons.ts) — no runtime npm dependency
- Fixed blank page caused by stray `xplorerInner` text at end of FileExplorer.tsx (truncated leftover from worker edit)

**Why:** Badge icons (colored rectangles with "TS"/"JS" text) looked blurry at 14x14. seti-icons npm package crashed in Vite ESM context (CJS/svgo dependency), so data was pre-extracted.

**Key files:** `fileExplorerIcons.tsx`, `ui/src/lib/setiIcons.ts`, `ui/src/lib/seti-icons.json`, `ui/src/lib/seti-definitions.json`, `FileExplorer.tsx`
**Verification:** `npm run build` clean, Playwright confirms page loads with zero errors
**Commit:** `6df5668..1c80521`
**Next:** None — editor-ux-v1 milestone complete
**Blockers:** None

## 2026-04-04: Code review fixes for editor-ux-v1

**What changed:**
- Deferred tab/state cleanup on delete until server confirms (was losing drafts on failed delete)
- Added rollback for tab retargeting on failed rename/move
- Extracted editing row in fileExplorerNode to fix Rules of Hooks violation
- Added `error` listener on spawned rg process to prevent process-fatal crash
- Validated search-index response before caching (prevents error objects from polluting cache)
- Text search UI no longer overwrites error state with a later done frame
- Removed dead directory branch from search navigation (fuzzy search already filters to files only)
- Replaced byte-offset highlighting with matchedText for non-ASCII safety

**Why:** Codex code review identified 1 CRITICAL, 4 HIGH, 3 MEDIUM issues across the 8 implementation commits.

**Key files:** `FileExplorer.tsx`, `fileExplorerNode.tsx`, `search.ts`, `quickOpenIndex.ts`, `WorkspaceTextSearch.tsx`, `useWorkspaceNavigation.ts`
**Verification:** `npm run build` clean, `cd server && npm test` 52/52 pass
**Commit:** `6df5668`
**Next:** None — editor-ux-v1 milestone complete
**Blockers:** None

## 2026-04-03: Optimistic explorer mutations with tab retargeting

**What changed:**
- File explorer CRUD operations (rename, move, delete) now apply optimistic local tree patches before the server call completes, with automatic revert on failure
- On rename/move: openTabs, activeTab, previewTab, file state (useFileState), and selectedFilePath are retargeted to the new path. Directory renames retarget all descendant paths. Diff tabs are also retargeted.
- On delete: affected tabs are closed immediately and file state entries removed
- Inline rename now selects only the stem (filename without extension) — directories select the full name
- Inline rename validates names: rejects no-ops, empty names, `..`, and `/`
- Added "Reveal in Finder" context menu item with `POST /api/files/:project/reveal` server endpoint (`open -R` on macOS, `xdg-open` on Linux)
- New hooks: `useLayoutState.retargetPaths()`, `useLayoutState.closeTabsUnder()`, `useFileState.retargetFile()`, `useFileState.removeFilesUnder()`
- `useFileTree` now exposes `patchTree` for optimistic tree mutations from FileExplorer

**Why:**
- File operations previously waited for SSE refresh before the tree updated, causing a visible delay
- Renaming or moving a file left stale tabs pointing at the old path
- Deleting a file left orphaned tabs open

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/components/fileExplorerNode.tsx`, `ui/src/hooks/useLayoutState.ts`, `ui/src/hooks/useFileState.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useApi.ts`, `server/src/routes/files.ts`
**Verification:** `npm run build` passed (pre-existing type errors in test files and parseDiff.ts unchanged), acceptance criteria verified
**Commit:** pending
**Next:** Explorer collapse-all, file search cache+ranking, cross-file text search UI
**Blockers:** None

## 2026-04-03: Per-file-type icons in explorer and tab bar

**What changed:**
- Replaced generic colored file shape icons with per-extension badge icons (colored rounded rect + short label) for 13 extensions: ts, tsx, js, jsx, json, md, css, scss, html, py, sh, yml, yaml
- Added `BADGE` config map in `fileExplorerIcons.tsx` — each entry is `[bg, fg, label]`
- Tab bar now shows file type icons before tab names (skipped for Tasks/Diff tabs)
- Generic colored document icon retained as fallback for unmapped extensions

**Why:**
- File type icons were generic (same shape for all files, only color varied), making it hard to distinguish file types at a glance in both explorer and tabs

**Key files:** `ui/src/components/fileExplorerIcons.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`
**Verification:** `vite build` passed
**Commit:** pending
**Next:** Tab path disambiguation, Cmd+P fuzzy search, cross-file text search UI
**Blockers:** None

## 2026-04-03: CodeMirror editor polish (brackets, fold, indent)

**What changed:**
- Enabled `closeBrackets()` + `closeBracketsKeymap` for auto-closing brackets and quotes
- Enabled `indentOnInput()` for language-aware auto-indentation
- Enabled `foldGutter()` + `foldKeymap` for code folding with clickable gutter markers
- Enabled `highlightActiveLineGutter()` for active line gutter highlight
- Added `@codemirror/autocomplete` dependency (for closeBrackets)
- Kept existing `bracketMatching()`

**Why:**
- Editor setup was minimal — useful built-in CodeMirror editing behaviors were not enabled, making the editing experience feel bare compared to VS Code. These are low-effort, high-impact improvements from the editor UX design doc.

**Key files:** `ui/src/components/Editor.tsx`, `ui/package.json`
**Verification:** `vite build` passes, all acceptance criteria grep checks pass
**Commit:** (pending)
**Next:** File-path breadcrumbs, tab disambiguation (remaining editor micro-interactions from design doc)
**Blockers:** None

## 2026-04-03: Ripgrep cross-file text search backend

**What changed:**
- Added `GET /api/search/:project/text` endpoint in new `server/src/routes/search.ts`
- Spawns `rg --json` with smart-case, context lines, hidden files, and hard-ignore list (`.git`, `node_modules`, `dist`, `build`)
- Streams NDJSON lines: `match`, `context`, `done`, `error` types
- Hard-cap at 5000 matches (kills `rg` process when reached)
- Kills `rg` on client disconnect via `AbortSignal`
- Checks `rg` availability upfront, returns 503 if missing
- Supports query params: `q`, `regex`, `caseSensitive`, `wholeWord`, `glob`, `context`

**Why:**
- No project-wide text search existed in the UI — this provides the backend for the cross-file search feature from the editor UX design doc

**Key files:** `server/src/routes/search.ts` (new), `server/src/index.ts`
**Verification:** `cd server && npm test` — 52 tests pass
**Commit:** pending
**Next:** UI sidebar text search component (`WorkspaceTextSearch.tsx`)
**Blockers:** None

## 2026-04-03: Fix symlink support in file explorer and search

**What changed:**
- Symlinked directories now display as folders and expand correctly in the file explorer. `listDir` resolves symlink targets via `stat()` since `Dirent.isDirectory()` returns `false` for symlinks.
- `resolveAndValidate` now validates the request path (pre-symlink) instead of the resolved target, allowing symlinks that point outside the project (e.g., `doc/todo → ../../openweb-docs/todo`).
- Trailing slashes in project paths (from `projects.json`) no longer break directory expansion.
- `/children` endpoint passes the symlink-relative path as `relPrefix` to `listDir`, so child entries get correct paths like `doc/todo/file.txt` instead of `../openweb-docs/todo/file.txt`.
- Search index (`/search-index`) now includes files inside symlinked directories via `collectSymlinkedFiles`, which walks the tree and adds files reachable through symlinks that `git ls-files` skips.

**Why:**
- Projects with symlinked doc directories (e.g., `doc/todo`, `doc/archive` pointing to a separate docs repo) were completely broken: symlinked folders appeared as files, couldn't expand, and their contents were invisible to Cmd+P search. Three independent root causes: `Dirent` type flags are mutually exclusive (symlink vs directory), `realpath`-based traversal check rejected external targets, and `git ls-files` doesn't follow directory symlinks.

**Key files:** `server/src/routes/files.ts`
**Verification:** 52 server unit tests pass. Manual verification of path logic with real symlinks.
**Commit:** (pending)
**Next:** None
**Blockers:** None

## 2026-04-03: Graceful PTY cleanup on SIGTERM

**What changed:**
- Added `process.on('SIGTERM')` handler to destroy all non-persistent PTY attach processes and terminate WebSocket connections before exit. Prevents orphaned `tmux attach-session` client processes from accumulating `/dev/ttys*` devices across `tsx watch` restarts.

**Why:**
- `posix_spawnp failed` errors observed after prolonged dev sessions. PTY device numbers reached `/dev/ttys509` (macOS limit: 511). Root cause: `tsx watch` restarts kill the Node process but orphaned `tmux attach-session` children could survive, holding PTY slave FDs. The SIGTERM handler ensures all attach-client PTYs are explicitly destroyed before exit. Tmux sessions themselves are unaffected.

**Key files:** `server/src/index.ts`
**Verification:** Manual — server restart clears PTY accumulation, SIGTERM handler confirmed via `tsx watch` reload
**Commit:** 307e083
**Next:** None
**Blockers:** None

## 2026-04-02: Fix file/folder creation not appearing in tree + CHANGES reveal

**What changed:**
- Fixed file/folder creation inside directories not appearing in the file tree after creation. `onCreate` in FileExplorer now calls `onExpandDir()` for parent directories, registering them with `useFileTree.loadedDirsRef` so SSE refresh re-fetches their children.
- Fixed clicking a changed file in the CHANGES panel not revealing it in the explorer tree. `activateChange` now calls `revealInExplorer()` to expand parent directories and `setSelectedFilePath()` to select the file.
- Fixed `handleExpandFolder` (used by CHANGES dir label click and search dir select) to call `expandDir()` for each path segment, loading children from the server instead of only opening directories in react-arborist's internal state.

**Why:**
- Root cause: react-arborist's `treeRef.open()` opens a directory in the tree UI but does NOT register it with `useFileTree.loadedDirsRef`. SSE-triggered `refreshExpanded()` only re-fetches dirs in `loadedDirsRef`, so directories opened only via `treeRef.open()` were silently skipped. Files/folders created inside those dirs were written to disk but never appeared in the tree.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/workspace/useWorkspaceNavigation.ts`
**Verification:** 4 e2e Playwright tests (file/folder at root + inside subdirectory), 10 server unit tests for create-file/create-dir endpoints. All pass.
**Commit:** f1e9b42
**Next:** None
**Blockers:** None

## 2026-04-02: Fix PTY file descriptor leak and dead WebSocket detection

**What changed:**
- Changed `proc.kill()` to `proc.destroy()` in the WebSocket close handler for non-persistent terminal sessions — `kill()` only signals the child process but leaves the PTY master FD open, causing gradual FD exhaustion
- Added WebSocket ping/pong heartbeat (30s interval via `WS_PING_INTERVAL_MS`) — dead connections are now detected and terminated within 30s instead of waiting ~2h for TCP keepalive

**Why:**
- Investigation found 31 leaked PTY master FDs with only 1 active child process on a running server. node-pty's `kill()` sends SIGHUP but doesn't close the master FD or destroy the socket; `destroy()` does both. Combined with no dead connection detection, PTY FDs accumulated until macOS's 511 limit was hit, cascading to tmux server instability.

**Key files:** `server/src/index.ts`, `server/src/lib/constants.ts`
**Verification:** Server unit tests passed (42/42). PTY leak confirmed via `lsof -p <pid> | grep ptmx`.
**Commit:** 78765af
**Next:** None
**Blockers:** None

## 2026-04-02: Mobile terminal Ctrl/Shift modifier keys + IME double-space fix

**What changed:**
- Fixed double-space bug on mobile English keyboard: the IME fallback handler now listens on the container (parent) with capture instead of directly on xterm's textarea, and a companion `keydown` listener skips the fallback when keyCode !== 229 (xterm already handled it via keydown path)
- Added sticky Ctrl and Shift modifier toggle buttons to the TerminalKeyBar first row — tap to activate (blue highlight), next virtual keyboard or key bar keypress applies the modifier and auto-clears
- Ctrl+letter sends control character (A-Z → \x01-\x1a), Shift+arrow sends shifted escape sequence, Shift+Tab sends \x1b[Z
- Modifier state managed by Terminal, shared between key bar and `onData` interception

**Why:**
- English mobile keyboards fire space with keyCode 32 (not 229), so xterm processes it via keydown. The IME fallback's flag reset ran after `onData` already set it (same-element listeners fire in registration order), causing a duplicate send
- Ctrl/Shift modifiers enable combining with any virtual keyboard key, not just the fixed set of Ctrl shortcuts in the secondary row

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/TerminalKeyBar.tsx`
**Verification:** `npx tsc --noEmit` — no type errors. Manual mobile testing confirmed single-space and modifier behavior.
**Commit:** a15a6b3
**Next:** None
**Blockers:** None

## 2026-04-01: Margin bar clock, editor cursor fix, session name fix

**What changed:**
- Top/bottom margin bars now show project name (left) + live clock (right), using `textDim` color for better readability
- Bottom margin bar mirrors top bar content (was previously an empty spacer)
- Editor: preserve cursor position during external content updates via minimal diff (common prefix/suffix) instead of full document swap
- Diff gutter: defer popup dismiss to next frame to avoid layout shift during mousedown
- Session name bar: scoped `font-semibold` to session name only, no longer bolding voice icon

**Why:**
- Clock display needed for fullscreen use where system clock is hidden
- Cursor jumping on external file changes was disorienting during editing
- Voice icon inheriting bold weight was a visual bug

**Key files:** `ui/src/App.tsx`, `ui/src/components/Editor.tsx`, `ui/src/lib/diffGutter.ts`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `npx vite build` passed
**Commit:** ed6e959..HEAD
**Next:** None
**Blockers:** None

## 2026-04-01: Long-press context menus on mobile

**What changed:**
- Added touch-based long-press detection (500ms, 10px threshold) to `useContextMenu` hook via new `bind()` method
- All three context menu sites (file explorer, project list, session list) now support long-press on mobile with the same menu as desktop right-click
- `touchend` preventDefault suppresses click after long-press activation
- FileExplorer context changed from `openContextMenu(event, path, type)` to `bindContextMenu(path, type)` returning spreadable handlers

**Why:**
- Context menus were inaccessible on mobile — right-click has no touch equivalent

**Key files:** `ui/src/components/Menu.tsx`, `ui/src/components/FileExplorer.tsx`, `ui/src/components/fileExplorerNode.tsx`, `ui/src/components/ProjectList.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`
**Verification:** `npx tsc --noEmit` clean, `npx vite build` passed
**Commit:** 2489d29
**Next:** None
**Blockers:** None

## 2026-04-01: UI layout polish — remove header, mobile optimizations, aligned bars

**What changed:**
- Removed the "Workflow" header bar, replaced with minimal project name bar (desktop only)
- Moved Add Project (+) button into sidebar "Projects" section header
- Top/bottom 40px margins for fullscreen breathing room, hidden on mobile
- TerminalKeyBar: smaller buttons (32×28px), safe-area bottom padding, Ctrl row shows `^` prefix once
- PaneSwitch (Browse/Editor/Terminal): tighter padding for more mobile content space
- Session name bar: styled with SectionHeader background/color, 12px semibold
- Editor tab bar: 35px → 32px to align with session bar

**Why:**
- Maximize content area especially on mobile — every pixel counts
- Visual consistency between editor and terminal header bars
- iPhone safe area padding prevents buttons being clipped by rounded corners

**Key files:** `ui/src/App.tsx`, `ui/src/components/PaneSwitch.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`
**Verification:** `npx tsc --noEmit` clean
**Commit:** 8aa42b8, 51a8cab
**Next:** None
**Blockers:** None

## 2026-04-02: Unify session idle detection across all providers

**What changed:**
- Removed `if (session.provider === 'claude') continue` guard in `session-reconciler.ts` — idle detection now works uniformly for Claude and Codex
- Claude sessions now get `session_idle` entries with `sessionName`, fixing missing unread pills
- multmux `ensureClaudeHooks()` now cleans up deprecated `~/.claude/hooks/on-stop.sh` and its settings.json entry
- Extracted `cleanupDeprecatedHooks()` as testable pure function in multmux

**Why:**
- Claude unread pills never appeared because `on-stop.sh` (unmanaged local file) wrote entries without `sessionName`. The UI's `isEligible()` requires `sessionName`.
- Idle detection was split: Claude via external hook, Codex via server reconciler. Unified to single path (reconciler) since `sessionName` is a multmux concept and the server already had the logic.

**Key files:** `server/src/lib/session-reconciler.ts`, `multmux/src/hooks.ts`, `multmux/test/hooks.test.ts`
**Verification:** All tests pass in both repos (workflow server 41 tests, multmux 130 tests)
**Commit:** pending
**Next:** Consider expanding notification model beyond `session_idle` to include `tasks.json` changes
**Blockers:** None

## 2026-04-01: Codebase quality refactor — full implementation

**What changed:**
- **P0 God file decomposition**: Split 5 god files into 22 focused modules
  - useWorkspaceState (764→144L) → useLayoutState + useFileState + usePersistence + workspaceTypes
  - WorkspaceScreen (1008→555L) → 5 extracted hooks (Keyboard, Navigation, Sessions, Diff, Voice)
  - TaskGraphScreen (588→237L) → useTaskGraphInteraction + useTaskGraphKeyboard + TaskGraphStatusPane
  - FileExplorer (481→333L) → fileExplorerIcons + fileExplorerNode
  - useVoice (463→169L) → voiceStateMachine (reducer) + voiceRecording (plain module)
- **P1 Server**: withProject middleware (eliminates 15-handler boilerplate), MULTMUX_PATH dedup, terminal/voice/search constants consolidated
- **P1 UI**: shared Menu.tsx (MenuItem/MenuDivider/useContextMenu), shortcuts.ts, taskGraphConstants.ts (STATE_COLORS), useSSETick hook
- **P2 Errors**: ApiError class, fail() server helper, drop ok from success responses, AsyncData<T> type, hook return conformance
- **Code review fixes**: task graph 404 handling, voice error parsing, stale session type

**Why:**
Multi-iteration codebase had accumulated god files (5 over 400L), 27+ instances of duplicated project lookup, 5 different error handling patterns, and ~40 hardcoded hex colors. Refactor improves maintainability, consistency, and testability.

**Key files:** 53 files changed — see `git diff 31a784a..adba4f2 --stat`
**Verification:** Vite build clean, server 41/41 tests pass, tsc --noEmit clean, Codex code review with 4 findings (all fixed)
**Commit:** 0ff4891..adba4f2
**Next:** None — refactor complete
**Blockers:** None

## 2026-04-01: Codebase quality design docs

**What changed:**
- Added P0/P1/P2 design docs for codebase quality refactoring in `doc/todo/codebase-quality/`
- P0: god-file decomposition (WorkspaceScreen.tsx 889→~400 lines via controller/view split)
- P1: server middleware extraction + UI shared component library
- P2: error standardization (structured error types, centralized handling)
- Includes double-design review discussions (Claude + Codex) for P0 and P2

**Why:**
Structured plan for addressing code quality issues identified across the codebase — oversized files, duplicated patterns, inconsistent error handling.

**Key files:** `doc/todo/codebase-quality/review.md`, `doc/todo/codebase-quality/p0-god-file-decomposition/`, `doc/todo/codebase-quality/p1-server-middleware/`, `doc/todo/codebase-quality/p1-ui-shared-components/`, `doc/todo/codebase-quality/p2-error-standardization/`
**Verification:** Documentation only
**Commit:** 3afc853
**Next:** Implement P0 (WorkspaceScreen decomposition)
**Blockers:** None

## 2026-04-01: Replace 50+ hardcoded hex colors with CSS vars and theme constants

**What changed:**
- Replaced hardcoded hex color values across 15 UI files with `SOLARIZED_LIGHT` / `SOLARIZED_LIGHT_UI` JS constants (for inline styles) and `var(--sol-*)` CSS variables (for stylesheets)
- Added `SOLARIZED_LIGHT_UI` semantic palette object (`bg`, `editorBg`, `headerBg`, `border`, `text`, `textDim`, `muted`, `accent`, `hover`, `sash`) to `solarizedLight.ts`

**Why:**
Hardcoded hex values scattered across components made theme consistency fragile. Centralizing to constants and CSS vars ensures a single source of truth for the Solarized Light palette.

**Key files:** `ui/src/lib/solarizedLight.ts`, `ui/src/App.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/components/FileExplorer.tsx`, `ui/src/components/AddProjectDialog.tsx`, `ui/src/components/ProjectList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/workspace/WorkspaceSearch.tsx`
**Verification:** `tsc --noEmit` — pass. Visual inspection — no color regressions.
**Commit:** e236824
**Next:** None
**Blockers:** None

## 2026-04-01: Code quality cleanup — constants, error logging, type safety

**What changed:**
- Extracted `server/src/lib/constants.ts` — shared constants for buffer sizes (`GIT_MAX_BUFFER`, `FILE_SIZE_LIMIT`), timeouts (`MULTMUX_COMMAND_TIMEOUT_MS`, `GIT_COMMAND_TIMEOUT_MS`, `SSE_HEARTBEAT_MS`), and sentinels (`PENDING_SESSION_ID`)
- Added `console.warn` to 28 silent `catch` blocks across 9 server files (was swallowing errors with empty catch)
- Fixed unsafe type assertions in UI hooks (`useApi.ts`, `usePanZoom.ts`, `useVoice.ts`)

**Why:**
Magic numbers were duplicated across files (e.g., `50 * 1024 * 1024` in 3 places, `PENDING_SESSION_ID` string in 2 places). Silent catches masked bugs during development. Unsafe casts risked runtime type errors.

**Key files:** `server/src/lib/constants.ts` (new), `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/session-summary.ts`, `server/src/routes/files.ts`, `server/src/routes/git.ts`, `ui/src/hooks/useApi.ts`, `ui/src/hooks/useVoice.ts`
**Verification:** `cd server && npm test` — all tests pass. `tsc --noEmit` — pass.
**Commit:** 2a2541e
**Next:** P0 god-file decomposition
**Blockers:** None

## 2026-04-01: Cmd+Arrow session navigation + terminal auto-focus + sidebar resize

**What changed:**
- Added Cmd+ArrowUp/Down keyboard shortcut to cycle through terminal sessions in display order (pinned → processing → idle), wraps around
- Terminal auto-focuses on session connect — switching sessions (Cmd+Arrow, click, or page load) immediately gives keyboard focus to the terminal
- Added draggable resize handle between Projects list and File Explorer in the sidebar (was hardcoded `maxHeight: 160`). New `projectSize` persisted in layout state.

**Why:**
- Quick session switching without mouse or memorizing session numbers
- Eliminates extra click to focus terminal after switching sessions
- Projects list height was not adjustable — users with many projects couldn't see them all

**Key files:** `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/hooks/useWorkspaceState.ts`
**Verification:** `tsc --noEmit` — pass. ESLint — no new errors.
**Commit:** (pending)
**Next:** None
**Blockers:** None

## 2026-04-01: Fix SSE fetch cascade and memory leaks

**What changed:**
- Added 500ms per-channel trailing-edge debounce to SSE refresh dispatch (`useSSE.ts`) — prevents fetch storms during rapid agent file writes
- Added AbortController to `refreshExpanded` (`useApi.ts`) — cancels in-flight tree refresh when new SSE event arrives
- Capped parallel directory fetches at 6 concurrent (`batchMap` helper in `useApi.ts`) — was unbounded `Promise.all`
- Added AbortController to `refetchOpenFiles` (`useWorkspaceState.ts`) — cancels in-flight file content fetches
- Clean up `diffs` state when diff tabs close (`WorkspaceScreen.tsx`) — was accumulating indefinitely
- Added `ws.on('error')` handler (`server/src/index.ts`) — triggers existing cleanup on WebSocket transport errors

**Why:**
- Chrome tab was consuming 10GB memory during long sessions with active agents. Root cause: each SSE refresh event triggered ~71 parallel HTTP requests (root + 50 expanded dirs + 20 open file tabs), with no cancellation or throttling. Multiple overlapping cycles accumulated response buffers.

**Key files:** `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `server/src/index.ts`
**Verification:** `server && npm test` — 41 tests pass. ESLint on modified files — no new errors. TypeScript build — no new errors.
**Commit:** (pending)
**Next:** Monitor memory in Chrome DevTools during active agent sessions to verify stabilization
**Blockers:** None

## 2026-04-01: Flat indented tree layout for task graph

**What changed:**
- Replaced nested-box group model with VS Code-style flat indented tree
- Groups are now 1px vertical guide lines instead of background rectangles with accent bars
- All cards uniform 220x32 at full opacity — no depth-dependent styling
- Hierarchy via 24px/level indentation + bold headers with chevrons
- Fixed browser `:focus` outline overflow (was rendering around SVG `<g>` bounding box)
- Same-lane edge arcs now scale by vertical distance to reduce overlap

**Why:**
The nested-box approach compounded visual noise at each depth level — overlapping borders, stacking padding, accent bars fighting for attention. The flat tree pattern (VS Code / Figma layer panel) eliminates all of this while remaining intuitive.

**Key files:** `taskGraphModel.ts`, `TaskGraphGroup.tsx`, `TaskGraphCanvas.tsx`
**Verification:** TypeScript clean, ESLint clean, Vite build passes
**Commit:** a276035..b3575d3

---

## 2026-04-01: Replace milestone model with recursive parent-child task graph

**What changed:**
- Replaced hardcoded 2-level milestone visualization with generic parent-child hierarchy at any depth
- New recursive layout algorithm: bottom-up fit-to-content width, DFS-ordered visible tree
- SCC-based cycle detection (Tarjan's) replaces heuristic per-column detection
- Unified selection model: `Selection = string | null` (no separate milestone type)
- Tree-style keyboard navigation: ArrowUp/Down for DFS order, ArrowLeft/Right for parent/child + collapse/expand
- New `TaskGraphGroup.tsx` component for depth-styled container frames
- Deleted `TaskGraphMilestone.tsx`
- Unified detail panel: breadcrumb chain, group progress, collapse toggle for any task with children
- Search auto-expands collapsed ancestors when navigating to results
- Removed `hiddenNodeIds` — display layout handles visibility via `computeVisibleSet`

**Why:**
The data model (`tasks.json`) supports arbitrary-depth parent-child trees via the `parent` field, but the visualization flattened everything into a 2-level milestone/task model. This mismatch lost hierarchy information and prevented multi-level task organization.

**Key files:**
- `ui/src/tasks/taskGraphModel.ts` — full rewrite (recursive layout, SCC, visible tree)
- `ui/src/tasks/taskGraphSelection.ts` — unified selection
- `ui/src/tasks/TaskGraphGroup.tsx` — new
- `ui/src/tasks/TaskGraphScreen.tsx` — collapsedTaskIds, tree keyboard nav
- All other task graph components updated

**Verification:** TypeScript clean, ESLint clean, Vite build passes, server tests pass (41/41).

**Commit:** b7beb0d

**Design docs:** `doc/todo/pc-task-graph/final/design_aligned.md` (double-design: Claude + Codex)

---

## 2026-03-31: Workspace consolidation — remove Monitor, collapse to single-workspace shell

**What changed:**
- Collapsed the three-view app shell (Monitor / Workspace / Tasks) into a single Workspace shell — App.tsx now renders one `<Workspace>` keyed by active project with no view switcher
- Moved project list with unread badges and drag-reorder into the workspace sidebar
- Added session unread pills (per-session new-output counts) and project unread badges (aggregate across sessions)
- Embedded task graph as a stable workspace tab (synthetic `'\0tasks'` tab ID)
- Added `useSessionUnreadState` hook for derived unread tracking from progress + sessions + localStorage timestamps
- Added browser notification routing: clicking a notification navigates to the correct project and session
- Deleted dead components: `Monitor.tsx`, `TaskGraph.tsx` (re-export), `RoadmapView.tsx`
- Updated CLAUDE.md architecture section, app-shell.md, workspace overview, frontend/components.md, frontend/hooks.md, and monitor.md docs

**Why:**
- The Monitor was a separate dashboard that duplicated session info already available in the workspace, and required context-switching away from the code editor. Consolidating into a single workspace shell eliminates the view toggle, reduces cognitive load, and surfaces session status (unread counts, processing indicators) where the user already works.

**Key files:** `ui/src/App.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/hooks/useSessionUnreadState.ts`, `CLAUDE.md`, `doc/main/ui/app-shell.md`, `doc/main/ui/workspace/overview.md`, `doc/main/frontend/components.md`, `doc/main/frontend/hooks.md`, `doc/main/ui/monitor.md`
**Verification:** `cd ui && npx vite build` exits 0; `cd ui && npm run lint` pre-existing errors only (no new issues from consolidation)
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-31: Embed the task graph as a stable Workspace tab

**What changed:**
- Added a synthetic non-file Tasks tab (`'\0tasks'`) with shared `isFileTab()` / `isDiffTab()` / `isTasksTab()` guards so workspace hydration, SSE refetch, and draft persistence only treat real files as files
- Added `showTasks` layout state plus a sidebar Tasks doorway in desktop and mobile Workspace layouts, and wired `Cmd+Shift+T` to open, focus, or close the Tasks tab without creating duplicates
- Rendered `TaskGraphScreen` inside the Workspace editor column when the Tasks tab is active, with explicit missing/error wrapper states and new e2e coverage for Tasks-tab behavior
- Updated workspace, keyboard, mobile, and frontend architecture docs to reflect the embedded Tasks tab and its layout/shortcut behavior

**Why:**
- The task graph needed to behave like a first-class workspace surface instead of a separate top-level mode, while keeping the existing file-tab, preview-tab, draft, and session behavior stable

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/hooks/useTaskGraph.ts`, `ui/src/tasks/TaskGraphScreen.tsx`, `ui/tests/e2e/workspace-tasks-tab.spec.ts`, `doc/main/ui/workspace/overview.md`, `doc/main/ui/keyboard.md`
**Verification:** `cd ui && npx vite build`; `cd ui && npx playwright test`; `cd server && npm test`; security scan via `rg -n "api_key|apiKey|API_KEY|sk-|key-" ui/src server/src`
**Commit:** TBD
**Next:** Reduce the existing repo-wide ESLint baseline so `/verify` can go fully green
**Blockers:** `cd ui && npm run lint` still fails on pre-existing issues outside this task (`App.tsx`, `ComposeTray.tsx`, `FileExplorer.tsx`, `Terminal.tsx`, `useApi.ts`, `useSSE.ts`, `WorkspaceScreen.tsx`, and several older tests); code-quality check still reports legacy files over 400 lines

## 2026-03-31: Make `dev:tmux --restart` rebuild pane processes

**What changed:**
- Replaced the `--restart` path in `scripts/dev-tmux.sh` from `send-keys C-c` + retyping commands to `tmux respawn-pane -k`
- Before respawning, the script now syncs key environment variables (`PATH`, `SHELL`, locale vars, `SSH_AUTH_SOCK`, etc.) into the tmux session
- Updated the dev guide and script help text to reflect the new restart behavior

**Why:**
- The old restart path reused the existing pane shell, so it kept stale environment like old `SSH_AUTH_SOCK` values and could queue commands into a pane that had not cleanly returned to a shell prompt yet

**Key files:** `scripts/dev-tmux.sh`, `doc/dev/workflow.md`
**Verification:** `bash -n scripts/dev-tmux.sh`; detached smoke check with a temporary tmux session confirmed `--restart` respawned both panes and both returned to live `node` processes
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-31: Auto-repair SSH auth for spawned terminal sessions

**What changed:**
- Added `server/src/lib/ssh-auth.ts` to validate `SSH_AUTH_SOCK` before spawning shell or multmux child processes
- On macOS, stale sockets are repaired by discovering the live `ssh-agent` socket via `pgrep` + `lsof`
- If the agent is reachable but empty, the server now runs `ssh-add --apple-load-keychain` before starting new sessions
- `terminal.ts` and `multmux.ts` now use the repaired child env, and new unit tests cover stale-socket and empty-agent cases

**Why:**
- The workflow server could inherit a dead `SSH_AUTH_SOCK`, so new project sessions started with a broken SSH environment and Git-over-SSH commands inside shell/Codex/Claude sessions got stuck until you manually warmed up auth in a separate terminal

**Key files:** `server/src/lib/ssh-auth.ts`, `server/src/lib/__tests__/ssh-auth.test.ts`, `server/src/lib/terminal.ts`, `server/src/lib/multmux.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd server && npm test`; live probe confirmed stale socket, repaired socket, and successful `ssh -T git@github.com` after `ssh-add --apple-load-keychain`
**Commit:** TBD
**Next:** Restart the workflow server so new sessions inherit the repaired SSH env path
**Blockers:** Existing already-running agent processes keep their old environment until restarted

## 2026-03-31: Expand mobile terminal key bar shortcuts

**What changed:**
- Added a dedicated Enter key to the mobile terminal key bar primary row and rendered it as `↵` to save space
- Moved `^C` into the expandable secondary row and added `^O` / `^B` control shortcuts there
- Updated the key bar unit tests and touch UI docs to match the new primary/secondary row layout

**Why:**
- Mobile terminal use needed a visible submit key without widening the always-visible row too much, and the secondary row needed a few extra control shortcuts without turning the bar into a stateful modifier keyboard

**Key files:** `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/__tests__/TerminalKeyBar.test.tsx`, `doc/main/ui/mobile.md`, `doc/main/ui/workspace/sessions-and-terminal.md`, `doc/main/frontend/components.md`
**Verification:** `cd ui && npx vitest run src/components/__tests__/TerminalKeyBar.test.tsx`
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-31: Fix terminal attach disconnect for all sessions

**What changed:**
- `server/src/lib/terminal.ts` now imports `node-pty` via namespace import (`import * as pty`) instead of default import
- Added `server/src/lib/__tests__/terminal.test.ts` covering project-scoped tmux attach, fallback attach, and the import-shape regression

**Why:**
- Under the current `tsx` + ESM runtime, `import pty from 'node-pty'` resolved to `undefined`, so `attachSession()` threw before spawning `tmux attach-session`. Session status still rendered correctly from `.multmux/*.json`, but opening any terminal immediately closed the WebSocket and the UI showed `Disconnected`.

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/__tests__/terminal.test.ts`
**Verification:** `cd server && npm test`; direct WebSocket attach smoke check against `codex-mnb8iog7`
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-27: Fix session routing collision across projects

**What changed:**
- Terminal WebSocket now includes `project` query param for project-scoped tmux session lookup
- New `resolveSessionTmuxName()` reads `.multmux/<handle>.json` state file's `tmuxSession` field
- `attachSession()` uses project-scoped lookup first, falls back to global `resolveTmuxSession()` search

**Why:**
- When two projects had sessions with the same handle (e.g. `codex-design` in both openweb and androidagent), clicking a session in one project could attach to the other project's tmux session. `resolveTmuxSession()` returned whichever tmux session appeared first in `tmux list-sessions`.

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/terminal.ts`, `server/src/index.ts`, `ui/src/components/Terminal.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** UI vite build clean, server module imports verified
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-26: File search UX + Changes preview tabs + specs/tests

**What changed:**
- Search-index uses `git ls-files` (7ms vs 3s walk), with `?ignored=true` toggle for gitignored files
- Search results include directories (derived from file paths); dir selection expands in explorer
- File selection from search opens as preview tab + reveals in explorer (sequentially expands ancestors via `expandDir`)
- Changes sidebar: diff tabs now open as preview (temporary) tabs via `openPreviewDiffTab`
- UX specs updated: `user-flows.md`, `explorer-and-changes.md` with new file search and changes behavior
- Playwright tests: `file-search.spec.ts` covering nested search, gitignore toggle, diff preview tabs

**Why:**
- Lazy-loading broke Cmd+P search (only root files visible); Changes diffs opened as permanent tabs cluttering the tab bar; behavior needed formal specs and test coverage

**Key files:** `server/src/routes/files.ts`, `ui/src/workspace/WorkspaceSearch.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useWorkspaceState.ts`, `doc/main/ui/workspace/user-flows.md`, `doc/main/ui/workspace/explorer-and-changes.md`, `ui/tests/e2e/file-search.spec.ts`
**Verification:** UI type-check clean, lint clean, server tests 35/35 pass
**Commit:** TBD
**Next:** Run Playwright e2e tests to validate
**Blockers:** None

## 2026-03-25: Cmd+P file search — independent of lazy tree

**What changed:**
- Added `GET /api/files/:project/search-index` endpoint — recursive walk returning flat `{name, path}[]` list (respects .gitignore, 10k file budget)
- `FileSearch` now fetches from this endpoint on mount instead of flattening the lazy tree
- Removed dead `flattenTree` utility and `allFiles` derivation from `WorkspaceScreen`

**Why:**
- Lazy-loading broke Cmd+P search — `flattenTree` only saw root-level files since subdirectories aren't loaded until expanded

**Key files:** `server/src/routes/files.ts`, `ui/src/workspace/WorkspaceSearch.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** UI type-check clean, lint clean, server tests pass (35/35)
**Commit:** `14fa5a2`
**Next:** None
**Blockers:** None

## 2026-03-25: Archive completed projects — docs + tasks

**What changed:**
- Archived design doc folders: `ignore`, `lazyloading`, `slow`, `twopane-md`, `voice` → `doc/archive/260325_*`
- Archived stale `roadmap.md` (milestones 1-5 all done)
- Archived all 5 completed task trees (26 tasks total) from `tasks.json` → `doc/todo/archive/260325_*.json`: keys, task-visualize, sse-memleak, project-ux, voice-input
- Marked voice-input (vi-verify) as done — manual e2e testing passed
- `tasks.json` is now empty — clean slate

**Why:**
- Housekeeping — all projects shipped, design docs and tasks cluttering active workspace

**Key files:** `doc/archive/260325_*`, `doc/todo/archive/260325_*.json`, `doc/todo/tasks.json`
**Verification:** `tasks.json` is `{}`, `doc/todo/` has only `task_visualize/` and `sessionhist/` remaining
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-25: Codex session summary fallback + reconciler sessionId backfill

**What changed:**
- fix: Codex session summary — workflow reads optional `summary` field from .multmux state files as fallback when Codex DB has no thread entry. Reverted hacky rollout file scanner — summary resolution now fully delegated to multmux.
- feat: reconciler triggers multmux sessionId backfill — calls `multmux status --json` for projects with sessions missing sessionIds (defense-in-depth for when hook-based resolution fails)
- `MultmuxSession` and `MultmuxStateFile` types updated with optional `summary`/`stateFileSummary` fields

**Why:**
- Codex sessions often lack thread entries in the local DB, leaving summaries blank. multmux already extracts summaries from rollout files — surfacing that via the state file `summary` field is simpler and more reliable than duplicating the scanner in workflow.

**Key files:** `server/src/lib/session-summary.ts`, `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`
**Verification:** `cd server && npm test`
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-25: Lazy-loading file tree (VS Code pattern)

**What changed:**
- Replaced eager full-tree `buildTree()` with lazy per-directory loading
- Server: new `GET /api/files/:project/children?dir=path` endpoint returns one directory's children
- Root endpoint `GET /api/files/:project` now returns only top-level entries (dirs with `children: []`)
- Removed: recursive buildTree, tree cache, tree watcher, budget cap, insideIgnored depth hack
- Frontend: `useFileTree` manages lazy state — `expandDir(path)` fetches children on demand
- SSE refresh: re-fetches root + all expanded dirs in parallel, preserving expanded state
- Gitignored directories are now fully expandable and recursive — just dimmed

**Why:**
- Previous approach needed budget caps and depth hacks to handle large projects (eval/ with 337k files, debug-output/ with 217k files). Gitignored dirs couldn't be fully expanded. VS Code solves this by loading one directory at a time on expand — always fast, no heuristics needed.

**Key files:** `server/src/routes/files.ts`, `ui/src/hooks/useApi.ts`, `ui/src/components/FileExplorer.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `cd server && npm test` — 35/35 pass; `cd ui && npx vite build` — success
**Commit:** 234b3d2

## 2026-03-25: Session reconciler deletes stale .multmux state files

**What changed:**
- Session reconciler now deletes `.multmux/*.json` state files when the corresponding tmux session is dead (was read-only before)
- Added `unlinkSync` import; `checkStaleStates` calls `unlinkSync(stateFile)` on dead sessions
- Tests updated to reflect new behavior: verify `unlinkSync` import instead of asserting read-only invariant

**Why:**
- Race between multmux's async `SessionEnd` hook (`sed>tmp&&mv`) and wrapper `EXIT` trap (`rm -f`) can recreate deleted state files, leaving orphaned entries. Reconciler cleanup is defense-in-depth.

**Key files:** `server/src/lib/session-reconciler.ts`, `server/src/lib/__tests__/session-reconciler.test.ts`
**Verification:** `cd server && npm test` passes
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-25: Two-pane markdown split view

**What changed:**
- Added third markdown viewing mode: Split — editor on left, live preview on right, side-by-side
- Draggable divider between panes (20%–80% range), size persisted to localStorage
- Bidirectional scroll sync using existing viewportLine infrastructure
- 3-segment toggle `[Edit | Split | Preview]` in tab bar (2-segment on touch/mobile — no split)
- `Cmd+Shift+V` cycles through all three modes
- State migrated: `previewMode: boolean` → `mdMode: 'edit' | 'preview' | 'split'` + `splitSize: number`

**Why:**
- Editing markdown with only toggle between edit/preview is awkward — no way to see rendered output while typing

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `npx tsc --noEmit` clean, `npm run lint` no new errors, build passes
**Commit:** `162fb2e`
**Next:** None
**Blockers:** None

## 2026-03-25: Fix mobile formatting stuck + unify Insert label

**What changed:**
- Fixed race condition: `setState('formatting')` is async but `stateRef.current` was only synced on render — late guard silently returned before reaching composing state. Now manually sync `stateRef.current` immediately after each `setState` call.
- Unified confirm button label to "Insert" for both editor and terminal surfaces.

**Why:**
- Mobile renders are slower, so `stateRef` wasn't updated by the time `await res.json()` resolved, causing the late guard `stateRef.current !== 'formatting'` to be true → silent return → stuck spinner.

**Key files:** `ui/src/hooks/useVoice.ts`, `ui/src/components/ComposeTray.tsx`
**Verification:** `cd ui && npx vite build` passed
**Commit:** `6ce8f6f`
**Next:** None
**Blockers:** None

## 2026-03-25: Voice compose floating dialog + surface toggle

**What changed:**
- ComposeTray changed from inline tray to centered floating dialog — eliminates terminal resize/scroll/jitter
- Dialog opens at recording start: shows pulsing dot + elapsed timer + Stop button
- Transcribing/formatting states show spinner inside dialog
- Surface target (Editor ↔ Terminal) toggleable via click or Tab key in dialog
- F5 added as voice recording shortcut (alongside Ctrl+Shift+V)
- Debounced terminal ResizeObserver (150ms) to prevent thrash during layout changes

**Why:**
- Inline tray caused terminal container to resize → tmux re-render → visible scroll from top to bottom
- Users frequently needed to change target surface after starting recording

**Key files:** `ui/src/components/ComposeTray.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/index.css`
**Verification:** `cd ui && npx vite build` passed, Playwright headless test passed
**Commit:** `0161dd4`
**Next:** None
**Blockers:** None

## 2026-03-25: Voice input UX improvements

**What changed:**
- Ctrl+Shift+V toggles voice recording (start/stop), auto-detects editor vs terminal surface by focus
- Enter in compose tray sends/inserts, Shift+Enter for newline, Esc to discard
- Terminal auto-focuses xterm after Send so user can immediately press Enter to execute
- Switched formatter model to `openai/gpt-oss-120b`

**Why:**
- Keyboard-driven workflow: record → review → Enter → execute without touching mouse
- Terminal focus was broken after Send — text entered PTY but xterm didn't have focus

**Key files:** `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/ComposeTray.tsx`, `ui/src/components/Terminal.tsx`
**Verification:** `cd ui && npx vite build` passed, manual testing confirmed all three fixes
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-25: Fix voice multilingual transcription

**What changed:**
- Removed `navigator.language` hint from voice upload — was sending `language: "en"` causing Whisper to force-transcribe Chinese speech as English
- Switched formatter model to `openai/gpt-oss-120b` for better multilingual formatting

**Why:**
- `navigator.language` reflects browser UI language, not spoken language. Passing it as a hint made Whisper ignore the actual spoken language. Auto-detect is correct for multilingual/mixed input.

**Key files:** `ui/src/hooks/useVoice.ts`, `server/.env`
**Verification:** `cd ui && npx vite build` passed, manual test confirmed Chinese raw transcript
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-25: Voice input feature (v1)

**What changed:**
- Three-stage voice input pipeline: Groq Whisper STT → LLM formatter → compose tray review
- Backend: `server/src/routes/voice.ts` with `GET /api/voice/status` and `POST /api/voice/compose`
- Frontend: `useVoice` hook (recording lifecycle, state machine), `VoiceControl` (mic button), `ComposeTray` (review/edit/confirm)
- Integrated into editor tab bar and terminal header in `WorkspaceScreen`
- Editor insert via CodeMirror dispatch (undoable), terminal send via PTY (no trailing newline)
- Formatter supports multilingual input — preserves original language, does not translate
- Models: `whisper-large-v3` (STT), `llama-3.1-8b-instant` (formatter), configurable via env vars
- `dotenv` added to server for `server/.env` loading
- Fixed TDZ bug: `isMd` referenced before declaration in voice eligibility check

**Why:**
- Voice input for dictating commands/text into tmux-attached terminals (where inline editing is awkward) and the editor
- Designed via `/double-design` (Claude + Codex independent designs, cross-review, 5-round alignment)

**Key files:** `server/src/routes/voice.ts`, `ui/src/hooks/useVoice.ts`, `ui/src/components/VoiceControl.tsx`, `ui/src/components/ComposeTray.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Editor.tsx`, `ui/src/components/Terminal.tsx`
**Verification:** `cd server && npm test` (35 passed), `cd ui && npx vite build` passed, Playwright headless project-switching test passed
**Commit:** pending
**Next:** E2E tests, formatter tuning for mixed-language dictation
**Blockers:** None

## 2026-03-25: Fix keystroke re-render cascade

**What changed:**
- Wrapped `FileExplorer` in `React.memo` — prevents re-rendering on every keystroke (props are stable during typing)
- Stabilized `dirtyTabs`/`conflictTabs` Set references in `useWorkspaceState` — structural comparison prevents new Set allocation when content hasn't changed

**Why:**
- Every keystroke triggered `setFiles()` → WorkspaceScreen re-render → FileExplorer re-render (6.6k nodes for large projects). FileExplorer props don't change during typing, so the re-render was 100% wasted. Cost scaled linearly with tree size.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/hooks/useWorkspaceState.ts`
**Verification:** `cd ui && npx vite build` — success; `cd server && npm test` — 35/35 pass
**Commit:** c07768b
**Design:** `doc/todo/slow/design.md`

## 2026-03-25: Improve session status indicator visibility

**What changed:**
- Processing session indicator changed from solarized green (`#859900`) to solarized cyan (`#2aa198`) — much higher contrast against idle gray (`#93a1a1`)
- Replaced Tailwind `animate-pulse` (opacity fade to 50%) with custom `status-glow` animation (solid dot + expanding glow ring) for clearer "active" signal
- Updated in both Monitor view (`SessionCard`) and Workspace sidebar (`SessionItem`)

**Why:**
- Solarized green was too muted/olive on the light background, making processing and idle sessions nearly indistinguishable at a glance.

**Key files:** `ui/src/index.css`, `ui/src/components/Monitor.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`
**Verification:** `tsc --noEmit` clean
**Commit:** pending

## 2026-03-25: .gitignore-aware file tree + dimmed UI

**What changed:**
- New utility `server/src/lib/gitignore.ts` — parses root `.gitignore` per project, caches by mtime
- `buildTree()` now skips recursion into gitignored directories (87x speedup for large projects: 1.3s → 15ms)
- Gitignored entries still appear in the file tree but marked with `gitignored: true` and rendered dimmed
- `project-watcher.ts` filters SSE events for gitignored paths — no more spurious filetree/git refreshes
- `FileExplorer.tsx` renders gitignored entries with muted color (#93A1A1) and 50% icon opacity
- `FileNode` type extended with optional `gitignored` field in both server and UI

**Why:**
- Typing lag in editor when working with large projects (e.g., androidagent with 650k files). Root cause: `buildTree()` traversed 578k entries including massive gitignored dirs (debug-output, eval, .reference). The constant tree rebuilds and SSE events created background churn competing with keystroke handling.

**Key files:** `server/src/lib/gitignore.ts`, `server/src/routes/files.ts`, `server/src/lib/project-watcher.ts`, `server/src/index.ts`, `ui/src/types.ts`, `ui/src/components/FileExplorer.tsx`
**Verification:** `cd server && npm test` — 35/35 pass; `cd ui && npx vite build` — success
**Commit:** 5b7a98c

## 2026-03-25: Backend voice pipeline

**What changed:**
- New route group `server/src/routes/voice.ts` with two endpoints: `GET /api/voice/status` and `POST /api/voice/compose`
- STT via Groq Whisper (`whisper-large-v3-turbo`) + formatter LLM (`llama-3.1-8b-instant`), both configurable via env vars
- Surface-specific formatter prompts: terminal normalizes CLI syntax, editor fixes punctuation/casing
- Formatter failure degrades to raw transcript (`fallback_raw`), not a fatal error
- Error mapping: 503/400/413/429/502 with stable `{ error, message }` JSON
- 12 new unit tests covering status, compose success, formatter fallback, empty transcript, error mapping
- `groq-sdk` added to server dependencies

**Why:**
- First implementation step for voice input feature — backend pipeline must exist before frontend can integrate
- Groq API key stays server-side to avoid browser exposure

**Key files:** `server/src/routes/voice.ts`, `server/src/routes/__tests__/voice.test.ts`, `server/src/index.ts`, `server/package.json`
**Verification:** `cd server && npm test` — 35/35 pass
**Commit:** pending
**Next:** Frontend voice controller, compose tray UI, surface integrations
**Blockers:** None

## 2026-03-24: Project management UX improvements

**What changed:**
- Context menu on project tabs: right-click → Copy Path / Remove (with confirmation, neighbor auto-select)
- Add Project dialog: replaced `window.prompt()` with modal dialog featuring directory autocomplete via new `/api/browse` endpoint, git repo indicators, drill-down navigation, `~` expansion
- New backend endpoint: `GET /api/browse?prefix=...` lists subdirectories with `isGit` detection, `$HOME` security boundary
- Fix: resize handles (explorer/changes, sidebar/editor) had 1px hit target — now 3px transparent padding, same visual
- Fix: file explorer scroll position reset every SSE/poll cycle — now only resets on first load
- Fix: file tree maxDepth 6→10 for deep directory structures (e.g. `doc/todo/.../cn/design.md`)
- Fix: context menu on bottom project tabs opened downward off-screen — now opens upward
- Fix: `workspaceProject` TDZ crash from variable used before declaration
- 17 new Playwright E2E tests

**Why:**
- Projects could be opened but never closed (backend DELETE existed, no UI)
- Adding projects required remembering full absolute paths — poor UX
- Resize handles were nearly impossible to grab on retina displays
- Explorer scroll jumping made it hard to browse files

**Key files:** `ui/src/App.tsx`, `ui/src/components/AddProjectDialog.tsx`, `ui/src/hooks/useApi.ts`, `server/src/routes/browse.ts`, `server/src/index.ts`, `ui/src/workspace/ResizeHandle.tsx`, `ui/src/components/FileExplorer.tsx`, `server/src/routes/files.ts`
**Verification:** `cd ui && npx vite build` passes, `cd server && npm test` 21/21 pass, 28/28 Playwright E2E pass
**Commit:** 4ab3065
**Next:** None
**Blockers:** None

## 2026-03-24: Fix text overflow and accent bar visuals

**What changed:**
- Text clipping: replaced character-count truncation with SVG `<clipPath>` on task nodes and milestone titles — text now cleanly clips at node boundaries regardless of font width
- Accent bar: inset left state accent bar by 8px top/bottom to stay within milestone column rounded corners
- Wider layout: nodes 180→220px, columns 240→280px for more readable titles

**Why:**
- Task titles were overflowing past node borders; left accent bar was poking out above the rounded corner

**Key files:** `ui/src/tasks/TaskGraphNode.tsx`, `ui/src/tasks/TaskGraphMilestone.tsx`, `ui/src/tasks/taskGraphModel.ts`
**Verification:** `cd ui && npx vite build` passes, 6/6 Playwright E2E tests pass
**Commit:** 7f61db5
**Next:** None
**Blockers:** None

## 2026-03-24: Fix task graph click interactions

**What changed:**
- Fixed chevron collapse: SVG `<g>` only captures events on painted children — added transparent hit rect behind the tiny chevron text
- Fixed task selection: SVG's `onClick={onClearSelection}` was overriding child click handlers via React event ordering — added `clickConsumed` ref guard
- Fixed hover-panning: `onPointerMove` now guards against unregistered pointers; removed `setPointerCapture` (was stealing clicks from child elements); added 3px drag threshold
- Added 6 Playwright E2E tests: render, click select, chevron collapse, hover no-pan, drag pan, search

**Why:**
- Three interaction bugs found during manual testing: individual milestone collapse not working, clicking tasks not showing detail panel, graph panning on hover without click

**Key files:** `ui/src/hooks/usePanZoom.ts`, `ui/src/tasks/TaskGraphMilestone.tsx`, `ui/src/tasks/TaskGraphScreen.tsx`, `ui/tests/e2e/task-graph.spec.ts`
**Verification:** 6/6 Playwright E2E tests pass, `cd ui && npx vite build` passes
**Commit:** 32b958f
**Next:** None
**Blockers:** None

## 2026-03-24: Task graph visualization — v1 + granularity control

**What changed:**
- New "Tasks" view (third top-level view alongside Monitor and Workspace) renders `doc/todo/tasks.json` as an interactive graph
- V1: Milestone columns with task nodes (parent-child containment), SVG bezier dependency edges, pan/zoom (wheel/pinch/buttons), click-to-select with upstream/downstream chain highlighting, toolbar (zoom, state filters, search), detail panel (desktop right rail / mobile bottom sheet), minimap, keyboard navigation
- V2 granularity: Milestone collapse/expand with edge aggregation, tooltip on hover (400ms), enhanced detail panel (breadcrumbs, collapsible sections, segmented progress bar, richer milestone view)
- Bug fixes: desktop milestone detail panel, search bar as-you-type highlight + match count
- Two rounds of Codex code review with all HIGH findings resolved

**Why:**
- Need to visualize task graphs from `tasks.json` (used by `/update-tasks` and `/orchestrate` skills) to understand parent-child hierarchies and dependency ordering at a glance

**Key files:** `ui/src/tasks/` (11 files), `ui/src/hooks/useTaskGraph.ts`, `ui/src/hooks/usePanZoom.ts`, `ui/src/App.tsx`
**Verification:** `cd ui && npx vite build` passes, Codex review × 2 rounds
**Commit:** ac9e0b9..705138a
**Next:** Fix remaining bugs found during manual testing
**Blockers:** None

## 2026-03-24: Persist pinned session order across view/project switches

**What changed:**
- Moved `pinnedSessions` from ephemeral `useState` in `WorkspaceScreen` into `useWorkspaceState` hook, which persists to `localStorage["workflow-workspace:<project>"]` via debounced writes + `beforeunload` flush.
- `WorkspaceScreen` now consumes `pinnedSessions` and `actions.setPinnedSessions` from the shared hook instead of managing its own local state.

**Why:**
- Session pins were lost whenever the Workspace component unmounted (switching projects via `key=` prop, switching between Monitor/Workspace/Tasks views). Every other piece of workspace UI state was already persisted — pinned sessions was the only gap.

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript compilation clean, no new lint errors
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-24: Align session handling with multmux state model

**What changed:**
- Reconciler is now read-only — never writes to `.multmux/*.json` state files. Dead sessions are excluded from snapshot without polluting state files with `stopped` status.
- `closeMultmuxSession` now uses `multmux kill` instead of direct `tmux kill-session`, ensuring state file cleanup.
- `startMultmuxSession` uses `--json` flag and returns parsed `{ handle, sessionId }` from CLI output.
- Sentinel sessionId (`pending:awaiting-first-prompt`) handled in session-summary — skips wasted DB/file lookups.
- Removed process tree traversal from PID fallback (agent CLI PIDs are now stored directly by multmux).
- Dropped `stopped` from `MultmuxStateFile.status` type to match multmux's 3-state model.

**Why:**
- Multmux changed its lifecycle model (commits 2026-03-21 → 2026-03-24): file existence = live session, file deletion = session ended, only 3 status values. Workflow was writing `stopped` back into state files and bypassing the CLI for kill, causing phantom sessions and race conditions with multmux's own GC.

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/session-summary.ts`, `server/src/routes/sessions.ts`
**Verification:** Zero TS errors, code review passed, 21 server unit tests passing (vitest)
**Commit:** b0589ed..4fc49a1
**Next:** None
**Blockers:** None

## 2026-03-24: Fix SSE memory leak causing browser crashes

**What changed:**
- Replaced EventSource built-in auto-reconnect with manual close-and-recreate + exponential backoff (1s → 30s) in `useSSE.ts`. Prevents listener accumulation and refresh storms on reconnect.
- Added LRU eviction to `fileTreeCache` in `useApi.ts` (max 20 entries, oldest evicted on insert). Prevents unbounded memory growth across project switches.

**Why:**
- Chrome "Aw, Snap!" Error code 5 (renderer OOM) was occurring intermittently. Root cause: each EventSource reconnection cycle added duplicate event handlers that amplified refetch work per SSE event. Combined with unbounded cache growth, long sessions would exhaust renderer memory.

**Key files:** `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`
**Verification:** Zero TS errors in changed files, `vite build` passes, code review approved
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-23: Archive completed projects and align doc structure

**What changed:**
- Archived 17 completed projects from `doc/todo/` to `doc/archive/YYMMDD_<project>/`
- Moved flow research artifacts (`ref_analysis/`, `retro/`) to `doc/archive/`
- Created `CLAUDE.md` with architecture overview, data flow, and doc pointers
- Aligned doc structure with `/init-all` and `/update-doc` conventions:
  - Trimmed `doc/dev/guide.md` → `workflow.md` (dev how-to only, specs point to `doc/main/`)
  - Created multi-agent symlinks: `AGENTS.md`, `GEMINI.md` → `CLAUDE.md`; `.agents/`, `.codex/` → `.claude/`
  - Moved stray design doc out of `doc/dev/`
- Added Ecosystem section to `CLAUDE.md` documenting the three-repo stack (workflow, multmux, agent-config)
- Gitignored runtime artifacts: `progress.json`, `reference/`, `test-results/`
- Added vitest, testing-library, jsdom to UI devDependencies
- Fixed stale doc references to archived projects

**Why:**
- `doc/todo/` had grown to 18 project folders, most already shipped. Archiving gives a clean view of what's actually in-flight.
- Doc structure was inconsistent with skill conventions — `guide.md` mixed dev how-to with system specs, no multi-agent symlinks, dead links to archived content.

**Key files:** CLAUDE.md, doc/dev/workflow.md, doc/main/README.md, .gitignore, doc/main/ui/workspace/sessions-and-terminal.md
**Verification:** All symlinks resolve, no dead links in SOTA docs
**Commit:** `98a97ba..90d04e7`
**Next:** Only `sessionhist` remains in `doc/todo/`
**Blockers:** None

## 2026-03-23: Fix file explorer empty gap bug

**What changed:**
- Defer `react-arborist` Tree mount until container has real dimensions (`size.height >= 1`) instead of rendering with `height=1`
- Reset virtual-list scroll position (`scrollTo(0)`) when tree data reference changes

**Why:**
- Intermittent bug: file explorer showed a large empty gap at the top with items pushed to the bottom. Refresh fixed it. Root cause: `react-window` `FixedSizeList` initializing with `height=1` could retain stale `scrollOffset`, and data refreshes (SSE/polling) could leave scroll position desynchronized from the new item count.

**Key files:** `ui/src/components/FileExplorer.tsx`
**Verification:** TypeScript build passed, page loads correctly
**Commit:** `a28498a`
**Next:** Monitor if the bug recurs
**Blockers:** None

## 2026-03-23: Mobile IME fix + virtual keyboard viewport

**What changed:**
- Fixed spaces and symbols being silently dropped when typing with Chinese mobile keyboard in xterm. Root cause: xterm v6 `_inputEvent()` guard drops `insertText` events when `ev.composed=true` and `_keyDownSeen=true` (set by prior IME keydown 229). Workaround: capture-phase `input` listener on xterm textarea, microtask-based detection of unprocessed input, direct WebSocket send.
- Added `useKeyboardViewport` hook + `interactive-widget=resizes-content` viewport meta for virtual keyboard layout adjustment. `#root` uses `var(--kb-viewport, 100dvh)`.
- Fixed key bar buttons stealing focus from xterm textarea (dismissing virtual keyboard). `onMouseDown` with `preventDefault()` on the bar container keeps focus on the textarea.

**Why:**
- Chinese keyboard spaces/symbols were completely unusable in the terminal on mobile — critical for Claude Code chat.
- Virtual keyboard was covering the terminal content and key bar.
- Tapping Tab/arrows/etc. dismissed the keyboard, breaking the typing flow.

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `ui/src/hooks/useKeyboardViewport.ts`, `ui/src/index.css`, `ui/index.html`
**Verification:** TypeScript build passed
**Commit:** `6d72691..2384266`
**Next:** Test on real iOS and Android devices
**Blockers:** iOS standalone PWA doesn't update visualViewport.height until first keystroke (WebKit bug, no workaround)

## 2026-03-22: Mobile terminal key bar

**What changed:**
- New `TerminalKeyBar` component: touch-only key bar with Esc, Tab, arrows, ^C (primary row) and ^D, ^Z, ^L, ^R, ^A, ^E, ^W, ^U (expandable secondary row)
- Terminal.tsx wraps xterm in flex column, renders key bar conditionally via `useIsTouch()`
- All keys send escape sequences through existing WebSocket input channel — no server changes
- Arrow keys support hold-to-repeat (400ms delay, 80ms interval)
- Arrow keys resolve dynamically via `xterm.modes.applicationCursorKeysMode` (CSI vs SS3 for vim etc.)
- ARIA labels, `role="toolbar"`, click fallback for assistive tech, `touchcancel` handling
- Timer cleanup on unmount, RAF cancellation, disposed guard on WebSocket callbacks
- 20 unit tests covering key mappings, expand/collapse, repeat timer, cleanup

**Why:**
- Mobile virtual keyboards lack terminal-essential keys (arrows, Ctrl combos, Esc, Tab), making the terminal nearly unusable on phones. Key bar follows proven Termux/Blink pattern.

**Key files:** `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/components/__tests__/TerminalKeyBar.test.tsx`
**Verification:** TypeScript build passed, 20/20 vitest tests pass, Codex review applied
**Commit:** `b86b352..880fe3b`
**Next:** Manual mobile testing, consider sticky modifier keys (v2)
**Blockers:** None

## 2026-03-22: Git diff gutter indicators in CodeMirror editor

**What changed:**
- Added VS Code-style diff gutter markers (green=added, blue=modified, red=deleted) to the CodeMirror editor
- Clicking a gutter marker opens an inline hunk popup showing the diff context
- New `parseDiff.ts` wraps `parse-diff` library to convert unified diff text → `DiffHunk[]`
- New `diffGutter.ts` implements the full CodeMirror extension: gutter, line decorations, popup widget, dismiss handlers
- `Editor.tsx` accepts `diffHunks` prop and dispatches `setDiffData` StateEffect
- `WorkspaceScreen.tsx` fetches per-file diff for git-changed files and threads hunks through to editor
- `solarizedLight.ts` extended with diff gutter and popup styles

**Why:**
- Previously users had to switch to the separate diff tab to see what changed in a file. Inline gutter indicators provide at-a-glance feedback while editing, matching VS Code UX expectations.

**Key files:** `ui/src/lib/diffGutter.ts`, `ui/src/lib/parseDiff.ts`, `ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/lib/solarizedLight.ts`
**Verification:** TypeScript build passed
**Commit:** `7a85982`
**Next:** v1 follow-ups — shared diff hook, syntax highlighting in popup, live unsaved-buffer diff
**Blockers:** None

## 2026-03-22: Session summary hover tooltip + Codex summary fix

**What changed:**
- SessionItem: added hover tooltip for truncated summary text — detects overflow via `scrollWidth > clientWidth`, shows styled tooltip after 300ms delay, dismisses on mouseleave
- session-summary.ts: removed server-side `truncate(summary, 120)` — full strings now sent to frontend, CSS handles visual truncation
- session-summary.ts: added `loadCodexPidMap()` — resolves Codex session IDs from PIDs via `lsof` (finds open rollout JSONL files). Codex sessions previously always had empty `sessionId` in multmux state, so summaries were never resolved.

**Why:**
- Summary lines were clipped with no way to see full content — users had to click into a session to remember its context
- Codex summaries silently failed because multmux doesn't populate `sessionId` for Codex sessions; the PID fallback (which Claude already had) was missing for Codex

**Key files:** `ui/src/workspace/WorkspaceSessionList.tsx`, `server/src/lib/session-summary.ts`
**Verification:** TypeScript build passed (UI `tsc --noEmit`)
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-22: Fix markdown preview code block horizontal scroll snap-back

**What changed:**
- Replaced `dangerouslySetInnerHTML` with manual innerHTML management via ref + `useLayoutEffect`
- `appliedHtmlRef` tracks the last applied HTML string; innerHTML is only set when the value actually changes
- `<pre>` horizontal scroll positions are saved before and restored after DOM recreation
- Added `overscroll-behavior: contain` on `.markdown-preview pre` to prevent scroll chaining
- Added `lastReportedLineRef` to prevent scroll-sync round-trip from resetting scroll positions

**Why:**
- React 19 re-applies `dangerouslySetInnerHTML` on every render when the `{ __html }` wrapper object is a new reference, even if the HTML string is identical. This recreated all DOM nodes ~14 times per 2 seconds, resetting `<pre>` `scrollLeft` to 0 every ~285ms. Diagnosed via Playwright instrumentation: innerHTML setter interception showed React's `commitUpdate → updateProperties → setProp` path calling `element.innerHTML = value` with identical strings.

**Key files:** `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/index.css`, `ui/tests/e2e/codeblock-scroll.spec.ts`
**Verification:** TypeScript build passed, 3 new Playwright E2E tests pass (scrollLeft persistence, content re-render survival, DOM churn elimination), 3 existing workspace E2E tests pass
**Commit:** `ea3729c`, `ee39481`
**Next:** None
**Blockers:** None

## 2026-03-22: Fix file tree explorer going blank on desktop

**What changed:**
- FileExplorer: moved Loading state inside the ResizeObserver-tracked container so size is pre-measured when data arrives (prevents stuck `{0,0}` size)
- FileExplorer: removed `size.width > 0 && size.height > 0` gate — Tree is always rendered with `Math.max(1, dim)` clamping so it stays mounted through layout transitions
- WorkspaceScreen: added `showSidebar` to sidebar ResizeObserver effect deps so it re-attaches after sidebar toggle (prevents stale `sidebarHeight` → collapsed explorer)

**Why:**
- The file tree explorer frequently went blank on desktop web with no user action. Root cause: two interacting bugs — (1) the Loading early-return bypassed the measured container, leaving size at `{0,0}` when data arrived; (2) the sidebar ResizeObserver didn't survive sidebar toggle, making `explorerHeight` collapse to 0. Both caused the size-gate to permanently suppress the Tree component.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript build passed (`tsc --noEmit`), code review clean
**Commit:** `73b12c5`
**Next:** None
**Blockers:** None

## 2026-03-22: Fix mobile terminal blank on new session

**What changed:**
- Removed `projectSessions.some()` gate on `attachedSession` — Terminal now mounts immediately when `activeSession` is set, instead of waiting for `refreshSessions()` API poll to resolve
- Added `knownSessionsRef` auto-detach: tracks previously-seen sessions and only clears `activeSession` when a known session disappears (not when a just-created session hasn't appeared in the list yet)
- Added `requestAnimationFrame` refit + `term.refresh()` in Terminal mount — ensures xterm canvas paints correctly on mobile where container dimensions may not be final in the first frame

**Why:**
- On mobile, creating a Claude/Codex session auto-switched to the Terminal tab, but the terminal was blank because `attachedSession` was gated by `projectSessions` (which hadn't refreshed yet). Users had to switch away and back to see content. Codex sessions were permanently invisible if the API response was slow.

**Key files:** `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Terminal.tsx`
**Verification:** TypeScript build passed (`tsc --noEmit`)
**Commit:** `462b116`
**Next:** None
**Blockers:** None

## 2026-03-22: Session display enhancements + inline rename

**What changed:**
- Session summary: shows first user message below session name, resolved from Claude JSONL (`<sessionId>.jsonl`) and Codex SQLite
- PID fallback: builds process tree via `ps -eo pid,ppid` to find agent CLI PID when `sessionId` is empty in state file (pane PID ≠ agent PID)
- Cached Codex SQLite handle (opened once per server lifecycle)
- Batch summary resolution: one JSONL read per session, one process tree per poll
- Pin sessions: diamond toggle pins sessions to top; pinned sessions drag-reorderable
- Session ordering: pinned → processing → idle with dividers
- `Cmd+Shift+1-9`: switch to Nth session in display order (uses `e.code` for layout-independent digit detection)
- Right-click rename: context menu → inline input, calls `multmux rename` via `POST /api/sessions/:handle/rename`
- Project tab drag fix: added `dataTransfer.setData()` for Safari compatibility
- New dependency: `better-sqlite3` for reading Codex `state_5.sqlite`

**Why:**
- Sessions named `claude-mn0pgumg` are unidentifiable — first message provides context at a glance
- PID mismatch (tmux pane shell vs agent CLI) was causing silent summary resolution failures
- Pin/reorder gives users control over session list priority without changing processing/idle semantics

**Key files:** `server/src/lib/session-summary.ts` (new), `server/src/lib/multmux.ts`, `server/src/routes/sessions.ts`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useApi.ts`
**Verification:** Vite build passed, Codex QA 6/6 PASS (Playwright), code review with fixes applied
**Commit:** `020389e..4cd3032`
**Next:** None
**Blockers:** None

## 2026-03-21: Workspace layout extraction + desktop sessions to activity column

**What changed:**
- Extracted `WorkspaceLayout.tsx` (175 lines) from `WorkspaceScreen.tsx` — separates layout composition from controller logic
- Desktop: sessions moved from left sidebar to right-column ActivityColumn (below Terminal)
- Mobile: layout unchanged — sessions remain in Files pane
- Session UI defined once in WorkspaceScreen, placed via slot assignment in WorkspaceLayout
- Added `viewport-fit=cover` to viewport meta and safe-area CSS for iPhone home indicator
- Bottom project tab bar applies `padding-bottom: var(--safe-area-bottom)` with `minHeight` instead of fixed `height`
- Desktop sidebar simplified: only Explorer + Changes, section header count fixed to constant 2

**Why:**
- WorkspaceScreen.tsx was 673 lines mixing controller logic with layout JSX — now 570 lines (controller only)
- Sessions next to terminal is more natural for desktop workflows (select session → see output immediately)
- Safe-area padding prevents project tabs from being occluded by iPhone gesture zone

**Key files:** `ui/src/workspace/WorkspaceLayout.tsx` (new), `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/App.tsx`, `ui/src/index.css`, `ui/index.html`
**Verification:** TypeScript type check passed, Vite build passed, code review (subagent) with all critical/major findings fixed, Codex review medium finding fixed (session click mobilePane guard), QA 7/8 PASS (test 5 expected 0px in Playwright emulation)
**Commit:** df5d9ba, f0d45da
**Next:** None
**Blockers:** None

## 2026-03-21: Event-driven session state from .multmux/*.json state files

**What changed:**
- Replaced 3s `multmux status` text polling with direct reads of `.multmux/<handle>.json` state files as primary session source
- `multmux.ts`: added `readSessionsFromStateFiles()`, removed text-parsing functions. Status normalization: `starting→idle`, `stopped→excluded`
- `project-watcher.ts`: `.multmux/*.json` changes route to `sessions` channel (event-driven updates)
- `terminal.ts`: shell session lifecycle callback emits `refresh:sessions` on start/close/exit
- `sessions.ts`: reads state files directly, no longer depends on poller cache
- `session-reconciler.ts` (new): 60s health-check loop replaces 3s poller. Verifies tmux liveness for all active sessions, writes `stopped` to stale state files, keeps Codex idle detection
- `session-poller.ts`: deleted
- `dev-tmux.sh`: added `--restart` flag for one-command server restart
- `.gitignore`: added `.multmux/`, `progress.json.lock`

**Why:**
- `multmux status` text parsing was brittle and added latency vs structured JSON state files
- Event-driven updates via file watcher provide near-instant session state changes in UI
- Reconciler demoted to safety net (catch missed watcher events, health-check dead sessions)

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/project-watcher.ts`, `server/src/lib/terminal.ts`, `server/src/routes/sessions.ts`, `server/src/index.ts`
**Verification:** Code review (delegated subagent), server hot-reload confirmed working, state file reads verified against live `.multmux/*.json` files
**Commit:** 42f6382
**Next:** None
**Blockers:** None

## 2026-03-21: Codebase Health Phase 3 — behavior-preserving workspace refactor

**What changed:**
- Decomposed `Workspace.tsx` (1,182 lines) into 10 modules in `ui/src/workspace/`
- `WorkspaceScreen.tsx` (671 lines) — controller + layout composition
- `WorkspaceEditorArea.tsx` (266 lines) — editor, preview, diff, conflict banner
- `markdown.ts` (118 lines) — rendering utilities, syntax highlighting, mermaid
- `WorkspaceTabBar.tsx`, `WorkspaceSearch.tsx`, `WorkspaceSessionList.tsx`, `WorkspaceSidebar.tsx`, `SectionHeader.tsx`, `ResizeHandle.tsx`, `useResize.ts` — small extracted components/hooks
- Added Playwright e2e test infrastructure (`playwright.config.ts`, `tests/e2e/workspace.spec.ts`) with 3 regression tests: SSE refresh, conflict detection, draft persistence

**Why:**
- Workspace.tsx was a 1,182-line monolith mixing markdown utils, resize hooks, presentational components, keyboard shortcuts, and layout JSX
- Refactor creates seams aligned with future workstreams (workspace-layout, editor-ux, workspace-state)
- Playwright tests formalize the regression safety net validated in M1 QA

**Key files:** `ui/src/workspace/*.tsx`, `ui/src/workspace/*.ts`, `ui/playwright.config.ts`, `ui/tests/e2e/workspace.spec.ts`
**Verification:** Vite production build passed. TypeScript type check passed (exit 0). Code review found 1 unused-import fix (applied).
**Commits:** 7fe5d18..023aefb (8 commits)
**Next:** Browser QA to verify must-not-regress behaviors. Downstream workstreams (workspace-layout, editor-ux) can now proceed against cleaner seams.
**Blockers:** None

## 2026-03-20: Editor UX — preview tabs, cursor visibility, mermaid rendering

**What changed:**
- Preview tabs: single-click in file explorer opens a temporary preview tab (italic title, replaced by next click). Double-click or edit pins it. `previewTab` state added to `useWorkspaceState` with localStorage persistence.
- Cursor visibility: changed `editorSelectionBackground` from `#EEE8D5` to `#D5CCB5` so text selections are distinguishable from the active line highlight.
- Mermaid rendering: ` ```mermaid ` code fences render as SVG diagrams in markdown preview via `mermaid.render()`. Early return in `renderer.code`, per-diagram `useEffect` with inline error display on failure.

**Post-review fixes:**
- `openPreviewTab()` no longer demotes already-pinned tabs to preview state (codex review)
- Mermaid: switched from `mermaid.run()` to `mermaid.render()` — root cause was `run()` reading `innerHTML` (HTML-escaped entities `--&gt;` broke the parser). `render()` takes `textContent` (browser-decoded) directly.

**Why:**
- Preview tabs reduce tab clutter — browsing files no longer accumulates persistent tabs
- Selection color was identical to active line highlight, making cursor invisible during selection
- Mermaid code blocks rendered as plain text, requiring external tools to visualize diagrams

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/components/Workspace.tsx`, `ui/src/components/FileExplorer.tsx`, `ui/src/lib/solarizedLight.ts`, `ui/src/index.css`, `ui/package.json`
**Verification:** QA 5/5 PASS (see `doc/todo/editor-ux/qa_1.md`). Vite production build passed.
**Commits:** 3d2bbb9, 9dc451a, feae6d7
**Next:** M4 codebase-health Phase 3 — no roadmap adjustments needed from M3
**Blockers:** None

## 2026-03-20: Workspace state synchronization

**What changed:**
- Fixed git invalidation: broader `.git/` routing, emit `git` alongside `filetree` for working-tree changes
- Added last-known-good git snapshot with stale marker (no more empty Changes panel on transient failures)
- Revision-aware file API: `GET content` returns mtime revision, `PUT content` accepts `baseRevision` with 409 on conflict
- New `useWorkspaceState` hook: centralized state with localStorage persistence for layout/tabs and drafts (separate keys), hydration from server truth, SSE-driven refetch for open files
- Conflict detection and resolution UX: yellow tab indicator, inline banner with "Accept Disk Version" / "Keep Mine & Save"
- Quota-error-driven eviction for draft localStorage persistence
- Migrated Workspace.tsx from inline state management to the new hook

**Why:**
- Four linked failures in Workspace: clean tabs not updating after agent edits, refresh losing unsaved edits, empty Changes panel on transient git failures, lost scroll position on refresh
- Root cause was fragmented state ownership — some state in React memory, some in localStorage, some derived from server with coarse invalidation

**Key files:** `server/src/lib/project-watcher.ts`, `server/src/routes/git.ts`, `server/src/routes/files.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/useApi.ts`, `ui/src/components/Workspace.tsx`
**Verification:** TypeScript type check passed. Vite production build passed.
**Commit:** 12bfc56
**Next:** End-to-end testing of conflict resolution flow; consider persisting viewport for clean files more aggressively
**Blockers:** None

## 2026-03-20: doc/main hierarchy and UI spec recovery (codebase-health Phase 1-2)

**What changed:**
- Created 25-file `doc/main/` structured hierarchy per the codebase-health aligned design, replacing the single `architecture.md`
- New sections: `backend/` (server, routes, libs), `data-model/` (overview, types, api-contracts, persistence), `frontend/` (components, hooks, state), `ui/` (7 spec pages + 6 workspace spec pages), `security.md`
- Each page has ownership sections (Owns, Does Not Own, Related Code) to prevent the hierarchy from collapsing back into a monolith
- Created `ui/history.md` recovery ledger tracing 25 git-history entries to permanent spec pages
- Workspace state machine formalized: 4 document states (Empty, FileEdit, FilePreview, Diff) + 4 layout states (Desktop, Mobile Files/Editor/Terminal)
- All 12 canonical workspace behaviors documented across spec pages
- Retired `architecture.md` with redirect to `README.md`

**Why:**
- `architecture.md` compressed system overview, stack, app shell, workspace behavior, and security into one file — impossible to answer focused questions about ownership boundaries
- UI specs must exist as explicit regression contracts before the Phase 3 behavior-preserving refactor can begin

**Key files:** `doc/main/README.md`, `doc/main/backend/*.md`, `doc/main/data-model/*.md`, `doc/main/frontend/*.md`, `doc/main/ui/*.md`, `doc/main/ui/workspace/*.md`, `doc/main/security.md`
**Verification:** Code review verified: all 25 files present, types match source, keyboard shortcuts match source, all canonical behaviors covered, localStorage keys and draft persistence model corrected against `useWorkspaceState.ts`
**Commit:** 8c25b0a
**Next:** Phase 3 — behavior-preserving refactor of App.tsx and Workspace.tsx around documented seams
**Blockers:** None

## 2026-03-20: Single-origin mobile app shell and PWA assets

**What changed:**
- Added backend UI serving in `server/src/index.ts`, so `http://localhost:3001/` now serves the built React app from `ui/dist` with SPA fallback and static asset delivery
- Added iPhone/PWA shell metadata in `ui/index.html`: manifest link, Apple touch icon, theme color, Apple standalone tags, final app title
- Added `ui/public/manifest.webmanifest` plus generated `icon-192.png`, `icon-512.png`, and `apple-touch-icon.png`
- Added root scripts `start:server` and `start:app` so the backend can be used as the stable app entrypoint without Vite
- Updated local hostname/origin defaults from `moonkeys-mbp` to `laptop`, including the full tailnet hostname `laptop.tailnet-example.ts.net`

**Why:**
- The mobile app needed a stable single-origin entrypoint and install metadata before it could be used as an iPhone home-screen web app
- Keeping the installed app on Vite `:5173` would leave the product tied to development infrastructure instead of the real backend runtime

**Key files:** `server/src/index.ts`, `ui/index.html`, `ui/public/manifest.webmanifest`, `package.json`, `ui/vite.config.ts`
**Verification:** `npm run build` passed. Verified `http://127.0.0.1:3001/`, `/manifest.webmanifest`, SPA fallback route, API health, Vite host acceptance for `laptop.tailnet-example.ts.net`, CORS with `Origin: https://laptop.tailnet-example.ts.net`, and WebSocket handshake using a temporary shell session. Tried `tailscale serve --bg 3001` and `tailscale cert laptop.tailnet-example.ts.net`; both are currently blocked by tailnet/account settings rather than local code.
**Commit:** Uncommitted
**Next:** Enable Tailscale Serve / HTTPS certificates in the tailnet admin settings, then verify `https://laptop.tailnet-example.ts.net` on iPhone Home Screen
**Blockers:** Tailnet/account currently does not allow `tailscale serve` or TLS cert issuance

## 2026-03-20: File explorer migration to react-arborist

**What changed:**
- Replaced hand-rolled recursive `FileTreeNode` with `react-arborist` virtualized tree in new `FileExplorer.tsx`
- Added backend endpoints: `create-file`, `create-dir`, `rename`, `move`, `delete` in `files.ts`
- Added client API functions: `createFile`, `createDir`, `moveFile`, `renameFile`, `deleteFile`
- Custom node renderer preserves all existing visuals: file type icons, git status badges (M/A/D/U), folder change indicators, selection highlight, hover effects
- Context menu (right-click): New File, New Folder, Rename, Delete, Copy Path — works on any node, creates in parent directory for files
- Drag-and-drop file/folder move via react-arborist + backend `move` endpoint
- Inline rename via F2 or context menu + backend `rename` endpoint
- Keyboard navigation (arrow keys, Enter, F2) built into react-arborist
- Virtual scrolling for large trees via react-window (inside react-arborist)
- Fixed mobile layout: explorer container needs `flex flex-col` for FileExplorer to get measurable height
- Header New File/Folder buttons create inside last-focused folder instead of always root

**Why:**
- Old explorer couldn't create files in subdirectories, had no rename/move/delete, no keyboard nav, no virtualization
- react-arborist chosen over react-complex-tree and @headless-tree/react for best feature completeness with least integration work

**Key files:** `ui/src/components/FileExplorer.tsx` (new), `ui/src/components/Workspace.tsx`, `server/src/routes/files.ts`, `ui/src/hooks/useApi.ts`
**Verification:** Backend APIs tested via curl (create, rename, delete all return ok). Frontend verified in Playwright by Codex (files visible, click-to-open, folder expand/collapse, context menu). Mobile fix verified by user.
**Commit:** c754004, c43717d
**Next:** Switch delete to `trash` npm package for recycle-bin behavior; consider lazy-loading for very large trees
**Blockers:** None

## 2026-03-20: Claude Stop hook for session idle detection

**What changed:**
- Claude sessions now use the `Stop` hook (`~/.claude/settings.json`) to write `session_idle` entries directly to `doc/todo/progress.json` — eliminates all false positives from multmux regex heuristics
- Hook script at `~/.claude/hooks/on-stop.sh` reads JSON stdin (cwd, session_id), appends progress entry with file locking, skips projects without `doc/todo/`
- Session poller skips idle detection for Claude sessions, only retains polling heuristic for Codex (no hook mechanism available)
- Codex polling still uses 15s min processing duration + 2× debounce as best-effort filter

**Why:**
- multmux detects idle/processing via regex on tmux pane content — user typing at the prompt is indistinguishable from agent processing, causing persistent false "finished processing" notifications
- Claude's Stop hook is 100% reliable (agent reports its own state)

**Key files:** `~/.claude/hooks/on-stop.sh`, `~/.claude/settings.json`, `server/src/lib/session-poller.ts`
**Verification:** Hook tested with simulated Stop event, writes entry correctly, skips non-workflow projects
**Commit:** 8c6f505
**Next:** None
**Blockers:** Codex has no equivalent hook — polling heuristic is the only option

## 2026-03-19: Event-based UI updates via SSE refresh signals

**What changed:**
- Replaced blind polling (3-10s) with event-driven SSE "poke" signals for all 6 UI hooks
- Server: recursive `fs.watch` per project (macOS FSEvents, one fd each) routes file changes through a filename router → SSE refresh channels (filetree, workstreams, git)
- Server: session poller emits `refresh:sessions` on any change; `~/.workflow/projects.json` watched for project list changes
- Server: `emitRefresh(channel)` added to notify.ts for lightweight SSE-only signals (no osascript)
- UI: shared EventSource singleton (`useSSE.ts`) dispatches refresh signals to registered hooks; fires all callbacks on reconnect
- UI: all polling hooks wired to SSE channels with 30-60s fallback intervals (safety net for SSE disconnection; can be removed if SSE proves reliable on localhost)
- 200ms debounce on all fs.watch events to batch rapid changes (e.g., `git checkout`)

**Why:**
- 6 hooks were blind-polling every 3-10s regardless of changes — wasteful and adds latency vs event-driven
- macOS FSEvents is kernel-level push with zero scanning overhead, same approach as VS Code

**Key files:** `server/src/lib/project-watcher.ts`, `server/src/lib/notify.ts`, `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`
**Verification:** SSE refresh events fire correctly on file create/delete, session changes detected, type-check clean, build passes
**Commit:** 9fb473d
**Next:** None
**Blockers:** None

## 2026-03-19: Mobile touch scrolling for files, editor, and terminal

**What changed:**
- Terminal touch bridge: converts touch pans to synthetic WheelEvent on xterm's screen element, going through xterm's normal wheel pipeline (scrollback for shell, mouse escape sequences for tmux)
- `stopPropagation()` on terminal touch handlers prevents xterm v6's document-level gesture system (inherited from VS Code) from stealing touch events via `preventDefault()`
- Mobile content area changed from `display:block` to `flex flex-col` so editor/terminal panes get proper height via `flex:1` instead of collapsing to content height
- `100vh` → `100dvh` on `#root` and App root for correct iOS Safari viewport sizing (address bar offset)
- `useIsTouch()` hook using `(pointer: coarse)` media query to conditionally remove `user-select:none` on touch devices (covers iPad landscape, touch laptops)
- `touch-action: pan-y` on files pane and desktop sidebar explorer for native scroll
- `touchcancel` handler on terminal bridge for iOS Safari system interruptions

**Why:**
- Three independent root causes: (1) xterm v6 custom scrollbar has zero touch support and actively steals touch events, (2) mobile content area was not a flex container so panes had no height constraint, (3) `100vh` on iOS includes area behind address bar causing oversized containers

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/Workspace.tsx`, `ui/src/hooks/useIsMobile.ts`, `ui/src/index.css`, `ui/src/App.tsx`
**Verification:** `tsc --noEmit` clean, `vite build` succeeds, touch scrolling verified on mobile for all three surfaces
**Commit:** 822d69d..d0378f3
**Next:** None
**Blockers:** Tmux terminal scroll requires `set -g mouse on` in tmux config

## 2026-03-19: Notification system — session idle + browser notifications

**What changed:**
- Unified notification model: all notifications (workstream progress, session idle, non-workstream) flow through `progress.json` entries
- Added project-level `doc/todo/progress.json` for entries without a workstream
- Session poller (`session-poller.ts`): 5s `setTimeout` loop detects `processing→idle` transitions, writes `session_idle` entries, caches sessions for `/api/sessions`
- Notification bus (`notify.ts`): `emitNotification()` fans out to macOS osascript + SSE broadcast with sink isolation
- SSE endpoint (`/api/notifications/stream`): Hono `streamSSE`, 30s heartbeat
- Browser hook (`useBrowserNotifications.ts`): unconditional EventSource, visibility-gated `Notification` API, per-tab seen-id dedup
- Monitor: "Enable Browser Alerts" action in Notifications pane, `session_idle` card styling (green IDLE badge)
- Dismiss route handles project-level entries via `_` sentinel

**Why:**
- Agents finishing work produced no notification unless they wrote to progress.json — the main polling pain point
- osascript doesn't reach remote/Tailscale access — browser notifications close that gap

**Key files:** `server/src/lib/session-poller.ts`, `server/src/lib/notify.ts`, `server/src/lib/watcher.ts`, `server/src/routes/notifications.ts`, `ui/src/hooks/useBrowserNotifications.ts`
**Verification:** SSE stream connects, notification events flow through pipeline end-to-end, dismiss works for project-level entries, both server and UI type-check clean
**Next:** Design review from Codex
**Blockers:** None

## 2026-03-19: Workspace preview/edit draft and position alignment

**What changed:**
- Moved Workspace file editing onto a per-tab draft buffer instead of relying on CodeMirror-local state plus refetched file content
- Changed Markdown preview to render the active tab's draft, so `Preview` and `Edit` now stay aligned
- Replaced the fragile shared scroll-percentage sync with per-tab viewport source-line anchors, so switching between `Preview` and `Edit` aligns by document position instead of layout geometry
- Added preview click-to-edit handoff that jumps back into the editor near the clicked markdown block with an approximate corresponding source line
- Made unsaved file edits survive switching between open file tabs, and documented the new in-memory draft/viewport-anchor behavior in architecture/dev docs
- Added a small plan note under `doc/todo/sessionhist/` for the bugfix

**Why:**
- The previous flow let preview mode and remounted editors fall back to stale fetched content. That could display an older snapshot and, after `Cmd+S`, write that stale snapshot back to disk. It also reset reading position on every mode switch, and raw scroll-percentage syncing was too sensitive to layout differences like `scrollPastEnd()` in the editor. The fix is to make preview, editor, save, and view position all read the same current per-tab state, anchored on source lines instead of scroll percentages.

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, doc/main/architecture.md, doc/dev/guide.md, doc/todo/sessionhist/preview-edit-alignment-fix-plan.md, doc/PROGRESS.md
**Verification:** `npm run build` passed; `npm run lint` in `ui/` still fails on pre-existing React hooks lint errors in `ui/src/App.tsx`, `ui/src/components/Workspace.tsx`, and `ui/src/hooks/useApi.ts`
**Commit:** 52d8d68, 79c5071
**Next:** If the preview click jump needs higher fidelity later, add finer-grained inline/source-span mapping inside markdown blocks instead of the current block-level approximation
**Blockers:** None

## 2026-03-19: Changes click toggle, explorer reveal, and effort doc relocation

**What changed:**
- Changed `Changes` row behavior so one click opens a diff tab, and clicking the same row again while that diff tab is active opens the raw file
- Made Explorer follow the active real file tab and auto-expand parent folders so the current editor file is always revealed and selected
- Moved the supporting workspace explorer/session plan from `doc/dev/` into the correct v0 workstream effort folder and updated doc references

**Why:**
- Double-click semantics were avoidable complexity here. The cleaner interaction is a stateful single click that reuses the existing active diff as the pivot into the editable file. The plan document also needed to follow the repo's own `/write-doc` rules instead of leaking into `doc/dev/`.

**Key files:** ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/guide.md, doc/todo/v0/efforts/README.md, doc/todo/v0/efforts/workspace-explorer-session/plan.md, doc/PROGRESS.md
**Verification:** `npm --prefix ui run build` passed; `./ui/node_modules/.bin/tsc -p server/tsconfig.json --noEmit` passed
**Commit:** None
**Next:** If the source-control panel needs more depth later, add an explicit icon affordance for “open diff” versus “open file” rather than more click variants
**Blockers:** None

## 2026-03-19: Explorer self-heal, cached tree refresh, and right-pane shortcut

**What changed:**
- Reworked the file-tree route to build directory nodes concurrently, cache each project's tree in-process, and invalidate that cache on structural filesystem changes
- Added a client-side per-project file-tree cache plus focus-based refresh so switching back to a large repo can reuse the previous tree immediately instead of cold-loading every time
- Sanitized persisted Workspace split sizes so a broken zero-height explorer restores to a visible default instead of rendering blank
- Added `Cmd+Shift+B` to toggle the right-side session pane independently from the existing left-sidebar `Cmd+B`
- Documented the new tree-refresh behavior and shortcut in architecture/dev docs and added a small implementation plan note

**Why:**
- The explorer could end up visually empty even though the file tree data still existed, and larger repos paid the full tree-loading cost on every revisit. The workspace also needed a dedicated shortcut for hiding the session pane without collapsing the file sidebar.

**Key files:** server/src/routes/files.ts, ui/src/hooks/useApi.ts, ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/guide.md, doc/todo/v0/efforts/workspace-explorer-session/plan.md
**Verification:** `npm --prefix ui run build` passed; `./ui/node_modules/.bin/tsc -p server/tsconfig.json --noEmit` passed
**Commit:** None
**Next:** If explorer updates still feel slow on very large repos, the next step is directory-by-directory lazy loading instead of sending the whole tree payload
**Blockers:** None

## 2026-03-19: VS Code-like markdown preview styling

**What changed:**
- Switched the Workspace markdown preview to a dedicated `.markdown-preview` style surface instead of inline utility classes
- Matched inline code in the preview to VS Code light preview behavior with a red preformatted-text foreground
- Restored ordered-list numbers and unordered-list bullets in the preview after the global reset removed native marker styles

**Why:**
- The preview should read like VS Code's markdown preview in light mode, and list markers are basic readability affordances that cannot disappear in a document-first workspace

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/lib/solarizedLight.ts, ui/src/index.css
**Verification:** `npm --prefix ui run build` passed
**Commit:** None
**Next:** If more visual mismatches show up, compare the preview against VS Code's light-side markdown token and typography defaults before changing editor colors
**Blockers:** None

## 2026-03-19: Codex icon uses ChatGPT SVG asset

**What changed:**
- Replaced the `codex` provider's inline OpenAI path mark with a static `ChatGPT-Logo.svg` asset in `ui/public/`
- Simplified the shared provider icon component so both Claude and Codex now load their provider marks through static image assets

**Why:**
- The previous inline mark looked soft at small sizes, and the ChatGPT SVG should render more cleanly in the compact session list

**Key files:** ui/src/components/SessionIcons.tsx, ui/public/chatgpt-logo.svg
**Verification:** `npm run build` passed in `ui/`; `rg -n "openAiMarkPath|chatgpt-logo\\.svg|provider === 'codex'" ui/src/components/SessionIcons.tsx` confirmed the `codex` icon now uses the static ChatGPT SVG asset with no inline path left
**Commit:** None
**Next:** If this still feels soft, inspect the rendered CSS box and consider per-provider sizing instead of changing the source asset again
**Blockers:** None

## 2026-03-19: Claude session icon uses Claude symbol

**What changed:**
- Replaced the Claude session icon asset with a Claude-specific SVG in `ui/public/`
- Updated the shared provider icon component to load the new SVG instead of the old Anthropic company mark
- Added a small effort note under `doc/todo/v0/efforts/claude-code-icon/`

**Why:**
- The Workspace should identify Claude sessions with a Claude-specific mark, not the Anthropic corporate logo

**Key files:** ui/src/components/SessionIcons.tsx, ui/public/claude-code-symbol.svg, doc/todo/v0/efforts/claude-code-icon/plan.md
**Verification:** `npm run build` passed in `ui/`; `rg -n "anthropic-mark\\.png" .` only returned a historical `doc/PROGRESS.md` entry, with no live code references left
**Commit:** None
**Next:** None
**Blockers:** None

## 2026-03-19: Restore terminal mouse selection visibility

**What changed:**
- Re-enabled text selection on the Workspace terminal pane so the root `select-none` shell chrome no longer blocks mouse selection inside xterm
- Changed the xterm selection background from the terminal background color to a visible Solarized-blue tint so drag selection is obvious again
- Left the existing terminal clipboard bridge in place, but removed the extra global copy interception experiment after confirming the real bug was selection, not clipboard routing

**Why:**
- Terminal copy only works if users can first select text. The regression was that shell sessions looked non-selectable because the terminal pane inherited `user-select: none`, and even successful selections blended into the background.

**Key files:** ui/src/components/Terminal.tsx, ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/guide.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** 99094f6
**Next:** If terminal selection regresses again, inspect xterm mouse-selection events before changing clipboard handling
**Blockers:** None

## 2026-03-19: Project tab shortcuts, reordering, and Explorer copy-path

**What changed:**
- Added drag-reorder support for bottom project tabs and persisted the order through a new `POST /api/projects/reorder` endpoint
- Added `Cmd+1` through `Cmd+9` to jump to the visible project tabs for the current view
- Made Explorer selection own `Cmd+C`, so copying from the file tree now copies the selected project-relative path
- Extracted the browser clipboard helper into `ui/src/lib/clipboard.ts` so Workspace and Terminal share the same copy path

**Why:**
- The bottom project bar already replaced the old selector, but it still lacked the fast keyboard/mouse workflows expected from a real workspace shell. Explorer copy-path also removes a common context-switch to the terminal just to grab a file path.

**Key files:** ui/src/App.tsx, server/src/routes/projects.ts, ui/src/components/Workspace.tsx, ui/src/components/Terminal.tsx, ui/src/lib/clipboard.ts, doc/main/architecture.md, doc/dev/guide.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** 434b0ce, e7212f2
**Next:** If needed, add visible drag affordances or a keyboard-only project reordering path
**Blockers:** None

## 2026-03-19: Git diff tab resilience and status-line normalization

**What changed:**
- Changed Workspace diff state from one global payload to a per-path cache, so reselecting an already opened change tab preserves the fetched diff instead of resetting to a loading flash
- Normalized `git status --porcelain` lines by stripping trailing `\r` without trimming the whole output, which keeps changed-file parsing stable for CRLF line endings and avoids dropping legitimate blank-state behavior

**Why:**
- The old single diff buffer made revisiting a changed file feel stateless, and the server-side status parsing was brittle on repositories or environments that emit CRLF porcelain output.

**Key files:** ui/src/components/Workspace.tsx, server/src/routes/git.ts, doc/main/architecture.md, doc/dev/guide.md
**Verification:** `npm run build` passed in `ui/`; `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`
**Commit:** d51cf68, 0f6e165
**Next:** If needed, add a small regression check around `git status` parsing and diff-tab caching once the project has a lightweight UI/server test harness
**Blockers:** None

## 2026-03-19: Consolidate v0 todo efforts

**What changed:**
- Moved the small v0 plan/review notes from `doc/todo/` root into `doc/todo/v0/efforts/`
- Grouped each effort into its own subfolder so related `plan.md` and `review.md` files stay together
- Added a short `README.md` under `doc/todo/v0/efforts/` and linked the folder from `doc/todo/v0/impl-plan.md`

**Why:**
- The v0 workstream already had its main design and state under `doc/todo/v0/`, but several supporting effort notes were still scattered at the root. Keeping them under one folder makes the todo tree easier to scan and keeps v0 artifacts together

**Key files:** doc/todo/v0/efforts/README.md, doc/todo/v0/efforts/dev-tmux/plan.md, doc/todo/v0/efforts/dev-tmux/review.md, doc/todo/v0/efforts/cmd-w-close-focus/plan.md, doc/todo/v0/efforts/mobile-pane/plan.md, doc/todo/v0/efforts/session-shell-ui/plan.md, doc/todo/v0/efforts/editor-scroll-past-end/plan.md, doc/todo/v0/impl-plan.md
**Verification:** `find doc/todo/v0/efforts -maxdepth 2 -type f | sort` returned the expected effort files; `rg -n "doc/todo/(dev-tmux-plan|dev-tmux-review|editor-scroll-past-end/plan|cmd-w-close-focus-plan|mobile-pane-plan|session-shell-ui-plan)" doc ui server .` returned no matches
**Commit:** 76e0dc0
**Next:** Keep new v0-specific effort notes under `doc/todo/v0/efforts/<effort>/`
**Blockers:** None

## 2026-03-19: Terminal fit and spacing tuning

**What changed:**
- Replaced the default xterm fit pass with a local fit helper that measures the real viewport scrollbar width before computing terminal columns
- Matched the xterm root and viewport background to the Solarized terminal background so exposed gutter areas no longer show a black frame
- Tuned the attached terminal layout to a `2px` inner right gutter plus `2px` outer pane padding, which keeps the last column readable without the terminal feeling over-padded

**Why:**
- The first gutter fix stopped right-edge clipping, but it exposed xterm's black viewport background and still needed iterative spacing tweaks to balance readability against wasted horizontal space

**Key files:** ui/src/components/Terminal.tsx, ui/src/components/Workspace.tsx
**Verification:** `npm run build` passed in `ui/`
**Commit:** 05b4295
**Next:** If needed, re-check the terminal fit on overlay-scrollbar browsers where the measured scrollbar width may collapse to zero
**Blockers:** None

## 2026-03-19: tmux dev server launcher

**What changed:**
- Added `scripts/dev-tmux.sh` to start frontend and backend dev servers in one `tmux` session with two panes
- Added `npm run dev:tmux` at the repo root as the entrypoint
- Documented the new workflow plus `--detached`, `--reset`, and custom session-name usage in the dev guide

**Why:**
- The repo already had hot-reload commands for both services, but no stable terminal workflow to launch and manage them together in a reusable `tmux` session

**Key files:** scripts/dev-tmux.sh, package.json, doc/dev/guide.md, doc/todo/v0/efforts/dev-tmux/plan.md
**Verification:** `bash -n scripts/dev-tmux.sh` passed; `bash scripts/dev-tmux.sh --help` passed; detached smoke tests confirmed session create/reuse/reset; invalid names such as `bad:name` were rejected; `tmux show-window-options -t <session>:dev remain-on-exit` returned `on`; after a 4s wait both panes were running `node`, with backend serving on `http://localhost:3001` and Vite up on `:5173`
**Commit:** 474aafb
**Next:** Verify the script creates, reuses, and resets the `tmux` session correctly on a local machine
**Blockers:** None

## 2026-03-19: Terminal right-edge gutter

**What changed:**
- Added a small right-side gutter to the embedded xterm instance before running `fit()`
- Let xterm's own fit calculation subtract that gutter from the available width so the last visible column no longer sits under the terminal edge

**Why:**
- The terminal's rightmost character cell could be partially clipped at the pane boundary, which made the last column hard to read

**Key files:** ui/src/components/Terminal.tsx
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, tune the gutter by platform if a browser still renders a clipped last column with a different scrollbar model
**Blockers:** None

## 2026-03-19: Editor scroll past end

**What changed:**
- Enabled CodeMirror's built-in `scrollPastEnd()` extension for the file editor
- The editor can now keep scrolling after EOF until the last line reaches the top of the viewport, but not past it
- Added a short implementation note in `doc/todo/v0/efforts/editor-scroll-past-end/plan.md`

**Why:**
- With the viewport rotated vertically, pinning the last line to the bottom edge made editing near EOF uncomfortable. The editor needed the standard "scroll past end" behavior without custom spacer logic

**Key files:** ui/src/components/Editor.tsx, doc/todo/v0/efforts/editor-scroll-past-end/plan.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, manually sanity-check the feel on very short files and long wrapped Markdown documents in the browser
**Blockers:** None

## 2026-03-19: Editable text files + Markdown preview shortcut

**What changed:**
- Removed the old Workspace restriction that only allowed `.md` and `.json` files to enter edit mode
- Removed the matching backend save restriction so validated project files can be written regardless of extension
- Added `Cmd+Shift+V` as a Markdown preview toggle shortcut alongside the existing preview button
- Changed session-side `Cmd+W` from hard close to detach-only, and moved hard termination to an explicit `Kill` button on each session row
- Kept the `Changes` panel behavior as-is, so changed files still open into diff tabs rather than editable file tabs

**Why:**
- The previous split between editable and read-only files made docs and source files feel inconsistent in the same editor surface, and Markdown preview needed a keyboard path instead of only a mouse target

**Key files:** ui/src/components/Workspace.tsx, server/src/routes/files.ts, doc/main/architecture.md
**Verification:** `npm run build` passed in `ui/`; `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`
**Commit:** None
**Next:** If needed, add a clearer visual label for diff tabs versus editable file tabs so the read-only state is more obvious
**Blockers:** None

## 2026-03-19: Focus-aware Cmd+W close handling in Workspace

**What changed:**
- Moved Workspace `Cmd+W` behavior behind one focus-aware close action that prefers the focused editor tab or attached session
- Switched the Workspace shortcut listener to keydown capture so the app intercepts `Cmd+W` before the browser window close wins
- Added explicit `Cmd+W` handling inside CodeMirror and xterm, plus explicit editor/terminal focus reporting back to Workspace state
- Made empty-surface `Cmd+W` in Workspace a no-op so it no longer falls through to closing the browser window
- Added a progressive `Keyboard Lock` request for `KeyW` after Workspace interaction so supporting secure-context browsers can hand `Cmd+W` to the app instead of the browser tab

**Why:**
- The previous shortcut handling depended on coarse focus state and a normal bubbling listener, so `Cmd+W` could still close the whole window instead of the focused file or terminal session. Standard browser key listeners are also not enough on every runtime, so this needed a platform-level fallback where available

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/components/Terminal.tsx, doc/main/architecture.md, doc/todo/v0/efforts/cmd-w-close-focus/plan.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, add a small shortcut smoke test layer once the UI has an automated browser test harness
**Blockers:** None

## 2026-03-19: Web terminal clipboard bridge for tmux copy

**What changed:**
- Added a clipboard bridge in the browser terminal so `OSC 52` clipboard writes from tmux/terminal apps can land in the browser clipboard
- Added explicit terminal copy-shortcut handling for selected terminal text (`Cmd+C` on macOS, `Ctrl+Shift+C` elsewhere)
- Added a fallback copy path using `document.execCommand('copy')` when the async Clipboard API is unavailable

**Why:**
- In the local terminal, tmux copy workflows can update the system clipboard. In the web terminal, there was no bridge from terminal escape sequences or explicit copy shortcuts into the browser clipboard, so copied text stayed trapped inside the terminal session

**Key files:** ui/src/components/Terminal.tsx, doc/main/architecture.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, add explicit paste-shortcut overrides and a small non-intrusive clipboard failure hint in the terminal UI
**Blockers:** None

## 2026-03-19: Mobile single-pane Monitor and Workspace

**What changed:**
- Added a shared mobile pane switcher component plus a small viewport hook for UI-only breakpoint handling
- Monitor now keeps the desktop three-column layout on wide screens but collapses to one full-width pane at a time on mobile: `Sessions`, `Notifications`, or `Roadmap`
- Workspace now keeps the desktop sidebar/editor/terminal layout on wide screens but collapses to one full-width pane at a time on mobile: `Files`, `Editor`, or `Terminal`
- File selection now auto-switches the mobile Workspace to `Editor`, and session selection or new session creation auto-switches it to `Terminal`
- Added a short implementation note in `doc/todo/v0/efforts/mobile-pane/plan.md` and updated architecture docs to describe the mobile pane model

**Why:**
- The previous layout relied on multi-column density that does not survive phone widths. Mobile needed an explicit single-pane navigation model instead of squeezing desktop panels into a narrow viewport.

**Key files:** ui/src/components/Monitor.tsx, ui/src/components/Workspace.tsx, ui/src/components/PaneSwitch.tsx, ui/src/hooks/useIsMobile.ts, ui/src/App.tsx, doc/main/architecture.md, doc/todo/v0/efforts/mobile-pane/plan.md
**Verification:** `npm run build` passed in `ui/`; `npm run lint` in `ui/` now only fails on a pre-existing `react-hooks/set-state-in-effect` issue in `ui/src/hooks/useApi.ts`
**Commit:** None
**Next:** If needed, tighten touch affordances for editor tabs and session actions on mobile
**Blockers:** None

## 2026-03-19: Mobile terminal reconnect fix for LAN origins

**What changed:**
- Relaxed server origin validation for API/WebSocket access when `WORKFLOW_CORS_ORIGINS` is unset
- The server now accepts localhost, `.local`, and private-LAN HTTP(S) origins by default, which covers mobile devices hitting the Vite dev server over a local hostname or IP
- Explicitly added `moonkeys-mbp` to the built-in hostname allowlist for the local Tailscale/dev setup
- Updated the dev/config docs to reflect the new local/mobile behavior

**Why:**
- On mobile, terminal sessions were immediately showing `Disconnected` because the WebSocket upgrade was proxied from the Vite dev server with a non-`localhost` origin, and the backend was hard-coded to only allow `http://localhost:5173` and `http://localhost:5174`

**Key files:** server/src/index.ts, doc/dev/guide.md, doc/main/architecture.md
**Verification:** `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`; `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, make the allowed-origin fallback configurable by network scope instead of hostname heuristics
**Blockers:** None

## 2026-03-19: Bottom project tab bar + right-aligned editor tab state

**What changed:**
- Removed the header project `<select>` and replaced it with a bottom project tab bar shared across the app shell
- Kept `All Projects` available in Monitor and Roadmap, while Workspace still resolves to one concrete repo
- Made the left side of the bottom project bar horizontally scrollable for mobile and many-project desktop cases, and collapsed the add action to a fixed `+` button on the right
- Moved the editor tab dirty dot / close affordance to the right side so file names stay left-aligned and state stays visually grouped at the edge
- Changed the empty-editor workspace layout so closing the last file lets the right-side session pane expand across the full main area
- Added a short implementation plan note in `doc/dev/project-bottom-tabs-plan.md`

**Why:**
- The previous top-right selector felt like form UI instead of navigation. A bottom tab strip makes project switching behave like a real workspace switcher and matches the user's requested layout more closely.

**Key files:** ui/src/App.tsx, ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/project-bottom-tabs-plan.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, tighten the bottom tab bar for many-project overflow and add an active-project badge in Monitor/Roadmap headers
**Blockers:** None

## 2026-03-19: Workspace session filtering + refresh restore + split layout persistence

**What changed:**
- Workspace now requests `/api/sessions?project=<name>` so the Sessions sidebar only shows multmux sessions from the current repo plus shell sessions started for that project
- Restored workspace state per project across refresh: open tabs, active session attachment, sidebar visibility, panel widths, and left-column split heights
- Added a second draggable divider between Changes and Sessions, removed the old hard cap that kept the file tree from being resized far enough, and persisted both split positions
- Fixed Claude logo rendering by switching from an inline data URI to a real static asset in `ui/public/`
- Changed the embedded terminal theme background to the same panel tone as the right sidebar so attached tmux sessions no longer pop back to the editor-light background

**Why:**
- The previous behavior made the Workspace feel stateless and cross-project: sessions could appear outside the current repo, refresh lost the working layout, and the left sidebar could not be shaped the way the user wanted.

**Key files:** server/src/lib/multmux.ts, server/src/routes/sessions.ts, ui/src/hooks/useApi.ts, ui/src/components/Workspace.tsx, ui/src/components/Terminal.tsx, ui/src/components/SessionIcons.tsx, ui/public/anthropic-mark.png
**Verification:** `./node_modules/.bin/tsx -e "...getSessionsForProject(workflow)..."` returned the expected `workflow` sessions in `server/`; `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`; `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, make Monitor use project-scoped session fetches lazily instead of polling all projects every cycle
**Blockers:** None

## 2026-03-19: Session logos + direct shell sessions + Cmd-W hijack

**What changed:**
- Replaced placeholder Claude/Codex session icons with official Anthropic/OpenAI brand marks in the Workspace and Monitor session lists
- Added a third session type, `shell-N`, backed by a direct long-lived PTY instead of tmux/multmux
- Extended `/api/sessions` to return both multmux sessions and direct shell sessions, plus a new `/api/sessions/:handle/close` endpoint
- Updated the terminal WebSocket layer to attach either to tmux or to a persistent in-memory shell PTY with buffered scrollback
- Changed Workspace `Cmd+W` behavior to close the active in-app surface: editor tab, shell session, or Claude/Codex session, rather than the browser tab
- Session sidebar now filters to the current project and includes a one-click shell creation button

**Why:**
- The previous UI used placeholder logos, only supported agent sessions through tmux, and let the browser capture `Cmd+W`. This pass makes the session model closer to a local IDE: branded providers, lightweight ad-hoc shells, and app-level close semantics.

**Key files:** server/src/index.ts, server/src/lib/session-names.ts, server/src/lib/multmux.ts, server/src/lib/terminal.ts, server/src/routes/sessions.ts, ui/src/components/Workspace.tsx, ui/src/components/Monitor.tsx, ui/src/components/SessionIcons.tsx, ui/src/hooks/useApi.ts
**Verification:** `../ui/node_modules/.bin/tsc -p server/tsconfig.json --noEmit` passed in `server/`; `npm run build` passed in `ui/`
**Commit:** None
**Next:** Decide whether closing Claude/Codex sessions should be a hard kill or a graceful stop+exit flow
**Blockers:** None

## 2026-03-19: VS Code-like UI polish + git integration

**What changed:**
- Migrated server runtime from Bun to Node.js (tsx watch) with @hono/node-server + ws + node-pty 1.0
- Terminal theme: Solarized Dark → Solarized Light to match editor
- Multi-tab editor: open/close/switch files with tab bar, Cmd-W close, VS Code-style active tab styling
- Initial terminal size fix: client sends cols/rows in WebSocket URL, server spawns PTY at correct dimensions
- VS Code Solarized Light palette: solid #EEE8D5 sidebar, #FDF6E3 editor, #D3CBB7 borders/headers, panel shadows, darker text (#586E75 not #93A1A1)
- Resize handles: expand to 3px dark brown (#584B2E) on hover/drag
- Collapsible sidebar sections (Explorer, Changes, Sessions) with draggable dividers between them
- File type icons: colored SVG document icons by extension (TS blue, JS yellow, JSON gold, MD teal, etc.)
- Git integration: new `GET /api/git/:project/status` + `GET /api/git/:project/diff` endpoints; file tree shows M/U/A/D badges, folders with changes show yellow + dot; Source Control "Changes" section in sidebar
- Diff viewer: click changed file → opens diff tab with unified diff rendering (green additions, red deletions, blue hunks)
- Unsaved changes: Editor tracks dirty state via CodeMirror updateListener; dirty tabs show black dot instead of close button
- Disabled browser overscroll bounce and swipe-back gesture (overscroll-behavior: none)
- Header bar updated to same VS Code palette

**Why:**
- User is adapted to VS Code UX and wants the workflow tool to feel native alongside it. The Bun → Node.js migration fixed node-pty compatibility. Git integration closes the loop on seeing what agents changed without leaving the tool.

**Key files:** server/src/index.ts, server/src/routes/git.ts (new), ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/components/Terminal.tsx, ui/src/hooks/useApi.ts, ui/src/types.ts, ui/src/index.css, ui/src/App.tsx
**Verification:** `tsc --noEmit` clean on both server and UI, `vite build` succeeds
**Commit:** 3d74520
**Next:** E2E testing with real sessions, further VS Code UX refinements
**Blockers:** None

## 2026-03-19: Implement workflow system v0 — full stack

**What changed:**
- Backend: Hono server on Bun with project registry, workstream/progress scanning, file tree browsing, file read/write, multmux session integration, tmux terminal proxy via WebSocket, macOS desktop notifications, file watchers for real-time progress updates
- Frontend: Replaced all mock data with API hooks (polling). Added CodeMirror 6 markdown editor, xterm.js terminal component, workstream status management from Roadmap tab, progress dismiss from Monitor tab
- Removed unused legacy prototype components (AttentionQueue, DocWorkspace, RunConsole)
- Security hardening: input validation on session names, realpath-based path traversal protection, server-side write restriction to .md/.json, WebSocket origin check, configurable CORS, file locking on writes
- Created workstream.json + progress.json for the v0 workstream itself
- Seeded ~/.workflow/projects.json with the workflow repo

**Why:**
- Design doc was finalized. This is the first implementation pass turning the design into a working system. Priority was Monitor + notifications (biggest UX gap: manual polling), then Workspace (doc editor + terminal), then Roadmap.

**Key files:** server/src/*, ui/src/*, package.json, doc/todo/v0/workstream.json
**Verification:** `tsc -b --noEmit` clean, `vite build` succeeds, server starts and all API endpoints return correct data
**Commit:** 6987e05
**Next:** E2E testing with real multmux sessions, History sub-tab in Workspace sidebar, session-project mapping, session_idle desktop notifications
**Blockers:** None
