# Progress

## 2026-06-15: Workspace perf/correctness — Cmd+P freshness, Task Graph SSE channel, optimistic sessions

**What changed:**
- **Cmd+P file index** now background-refetches on *every* open (cheap `git ls-files`),
  instead of relying on a `stale` flag set by a `filetree` SSE between opens. Removed
  the `markStale`/`isCacheStale` mechanism (and its `filetree` wiring in
  `WorkspaceProvider`); `quickOpenIndex` dropped its in-flight `fetching` dedup so a
  rapid close/reopen can't early-return stale entries.
- **Task Graph** (and the Gantt / detail views via `useTaskData`) moved off the broad
  `filetree` SSE onto a new dedicated **`tasks`** channel. `project-watcher` emits
  `tasks` for `plan/tasks/**` writes; task-mutation routes emit `tasks` via
  `invalidateTasksCache`. Unrelated file writes no longer refetch the ~570KB / 400+
  task payload and rebuild the whole graph.
- **New sessions** show an optimistic `starting` placeholder row the instant the user
  clicks (`STARTING_SESSION_PREFIX`), reconciled by handle once the server list catches
  up (or a 60s TTL timer). `clickSession`/`openBeside`/`rename`/`kill` ignore placeholder
  names. The server emits a `sessions` SSE on every mutation (`invalidateSessionsCache`)
  so all clients repaint without waiting on the 30s poll or the debounce-prone watcher.

**Why:**
- All three were user-reported slowness after the multipane/tab refactor. Measured: the
  task endpoint was fine (~0.3s server) — the cost was client-side rebuilds triggered by
  `filetree` SSE storms; the Cmd+P staleness was a missed-signal in the stale-flag chain;
  the session lag was the per-session `yaco` CLI cold-start (worse for claude than codex)
  with no optimistic feedback.

**Key files:** `app/ui/src/workspace/{quickOpenIndex,WorkspaceSearch,WorkspaceProvider,useWorkspaceSessions}.tsx?`, `app/ui/src/hooks/useTaskGraph.ts`, `app/ui/src/tasks/hooks/useTaskData.ts`, `app/server/src/lib/project-watcher.ts`, `app/server/src/routes/{tasks,sessions}.ts`
**Verification:** app/ui 974 unit + app/server 606 unit pass; `tsc -b` + eslint clean; impacted Playwright e2e (file-search, task-graph, workspace-tasks-tab, session-search) pass; live SSE probe confirmed the watcher emits `tasks`/`filetree` on file writes. Independent claude + codex reviews; findings folded into the last commit.
**Commit:** c4ddbf9..HEAD
**Next:** None
**Blockers:** None

## 2026-06-15: Task Graph as a singleton working-area tab

**What changed:**
- The desktop Task Graph moved from a full-working-area overlay (driven by the
  flat `layout.showTasks` flag) to a first-class **singleton group tab**, a peer
  of editor/terminal tabs. `GroupTab` gains a payload-less `{ kind: 'tasks' }`
  variant + `TASKS_INSTANCE_ID`; `normalizeTab` enforces the singleton
  (`NormCtx.seenTasks`) and reserves the `'tasks'` id in `seenIds` so an impostor
  node claiming it is re-minted.
- Reducer (`useLayoutState.ts`): new `OPEN_TASKS_TAB`; a shared `focusKind(tab)`
  helper replaces the editor/terminal binary in all four focus-deriving branches
  (`SET_ACTIVE_GROUP_TAB`, `CLOSE_GROUP_TAB` successor, `MOVE_TAB`, `MOVE_GROUP`)
  so a tasks tab pushes neither MRU; `reconcileFocus` repoints to the editor when
  the tasks tab is gone; `activeTabKind` maps tasks → `''` (routing-neutral).
- Provider: `toggleTasks`/`closeTasks`/`mainShowsTasks` are **focus-based**
  (`focusedPane.kind === 'tasks'`), implementing absent→create / focused→close /
  unfocused→focus, revealing a hidden right sidebar on activate;
  `closeFocusedSurface` splits the tasks/editor arms so Cmd+W from an editor group
  can't close a tasks tab elsewhere.
- Renderer: deleted the overlay + `taskOverlay`/`workingAreaId` plumbing from
  `DesktopPanelTreeLayout.tsx`; `DragPayload.tabKind` widened to `GroupTabKind`;
  the tab bar shows `ListTodo` + "Tasks" (plain close ×). `WorkspaceScreen`'s
  `showingTasks` and the `Cmd+\` split now key off the focused tasks surface.
- Persistence: dropped `showTasks` parse/save and the overlay rehydrate path — the
  tasks tab persists structurally inside `panelLayout.desktop` like any tab.

**Why:**
- The task graph was already a registered panel rendering through `PanelHost`
  identically to editor/terminal; the overlay plumbing was the only thing keeping
  it special. Folding it into the tab model is a net deletion and gives tasks the
  full group layout (split / move / coexist) for free.

**Key files:** `app/ui/src/hooks/workspaceTypes.ts`, `hooks/useLayoutState.ts`,
`hooks/usePersistence.ts`, `workspace/panelLayoutModel.ts`,
`workspace/WorkspaceProvider.tsx`, `workspace/DesktopPanelTreeLayout.tsx`,
`workspace/GroupTabBar.tsx`, `workspace/WorkspaceScreen.tsx`,
`workspace/useWorkspaceKeyboard.ts`, `workspace/panels/TaskGraphPanel.tsx`.
**Verification:** `tsc -b`, `eslint`, `vitest run src/` (965), tasks e2e
(`task-graph` + `workspace-tasks-tab`, 26 incl. 2 new tab-cycle/coexist specs).
Reviewed by Claude code-reviewer + Codex; Codex's normalizer-id-reservation
finding was fixed (+3 singleton tests). Design + review:
`plan/all/20260615_task-graph-tab/`.
**Commit:** 095bcae
**Next:** None.
**Blockers:** None.

## 2026-06-14: Proportional center rescale on sidebar toggle (Cmd+B / Cmd+Shift+B)

**What changed:**
- `panelLayoutModel.ts`: `setDockVisible`/`setActivityVisible` and
  `toggleDock`/`toggleActivity` gained an optional `rootBasis` (live root-row
  width). A shared `withSidebarHidden` helper flips the sidebar's `hidden` and,
  when `rootBasis` is supplied, scales the center region's interior from its old
  rendered width to its new one — both read from `actualChildSizes`, then ratioed
  by the existing `scaleNodeAlongAxis`. Without `rootBasis` the bases are left
  untouched (legacy behavior preserved).
- `WorkspaceProvider.tsx`: the two forward visibility mirrors now pass
  `measureRootWidth()` (the committed root split's `clientWidth`) into the model
  setters, so every visibility path (Cmd+B/Cmd+Shift+B toggle and the programmatic
  reveals) rescales the center proportionally.
- Tests: `panelLayoutCommands.test.ts` covers grow-on-hide, shrink-on-show, the
  no-`rootBasis` fallback, and the right-sidebar path;
  `panel-tree-desktop.spec.ts` adds an e2e asserting both panes of a split working
  area widen proportionally on Cmd+B (not just the grow absorber).

**Why:**
- Dragging a divider inside the working area already redistributes width
  proportionally (`scaleNodeAlongAxis` via `resizeSplitChild`'s `containerBasis`),
  but toggling a sidebar let the center's grow pane absorb all the freed/consumed
  width while every fixed-basis pane kept its absolute size. The toggle now shares
  the delta the same way a drag does.


## 2026-06-14: Fix workspace white-screen — sidebar visibility-mirror update loop

**What changed:**
- The flat `showSidebar`/`showRightPanel` flags and the panel tree's `hidden`
  flags are kept in sync by two provider `useLayoutEffect`s (forward flag→tree,
  reverse tree→flag). Two fixes make that bidirectional sync provably convergent:
  - `usePersistence.ts` (`loadPersistedState`): derive the two flags from the
    canonical tree (`sidebarVisibility`) at load instead of trusting the blob, so
    the independently-persisted flag and tree can't contradict each other on mount.
  - `WorkspaceProvider.tsx` (reverse mirror): reconcile a side from the tree only
    when that flag held **steady since the last run** (a just-changed flag is owned
    by the forward mirror for that commit). The effect now also depends on the
    flags and records the post-reconcile value, so its tracking ref advances on
    flag-only commits (closes a stale-ref gap that left a flag stuck after the
    reverse mirror's own write followed by a later DnD).
- Added `persistedVisibilityConsistency.test.tsx` (load reconcile for new-group +
  migrated old blobs, no mount storm) and `runtimeVisibilityStorm.test.tsx`
  (batched tree-mutation + flag-flip convergence; consecutive-DnD round trip).

**Why:**
- A stale/migration-mismatched persisted blob loaded with the flag disagreeing
  with the tree. On mount the forward and reverse mirrors reached opposite
  conclusions one render out of phase, inverting sidebar visibility forever →
  React "Maximum update depth exceeded" → `<WorkspaceProvider>` unmounted →
  white screen. `localStorage.clear()` only worked by discarding the bad blob.
- Codex review surfaced two further gaps beyond the initial load-only fix: a
  runtime batched commit (`clickSession` opens a terminal tab + reveals the right
  column) re-created the storm, and the steady-flag guard's ref could go stale —
  both fixed and pinned by the new tests.

**Key files:** `app/ui/src/hooks/usePersistence.ts`,
`app/ui/src/workspace/WorkspaceProvider.tsx`,
`app/ui/src/hooks/__tests__/{persistedVisibilityConsistency,runtimeVisibilityStorm}.test.tsx`
**Verification:** `npx tsc -b` clean, `eslint` clean, `vitest run src` = 960 passed
(both new regression tests verified to fail without their respective fix).
**Commit:** (this commit)
**Next:** Optional, out of scope here — a flag-only reveal of an *absent* sidebar
leaves a benign (non-storm, reload-healed) flag/tree mismatch; a single-source-of-
truth for sidebar visibility would retire the mirror pair entirely.
**Blockers:** None

## 2026-06-14: Markdown preview renders YAML frontmatter as a metadata table

**What changed:**
- The markdown preview (`app/ui/src/workspace/markdown.ts`) now detects a
  leading GitHub-style `---` frontmatter fence and renders it as a bordered
  key/value table (`.markdown-frontmatter`) instead of letting `marked` treat
  the closing `---` as a setext heading underline (which turned the whole YAML
  block into one giant `<h1>`).
- Added `extractFrontmatter()` + a dependency-free indentation-based `parseYaml`
  handling scalar maps, nested maps (sub-tables), block lists, and inline
  `[a, b]` flow lists; unknown shapes degrade to plain text. The frontmatter is
  emitted as its own `.markdown-block` and the body is lexed with the
  line-counter offset past the fence so Editor↔Preview scroll-sync anchors stay
  aligned.
- Added `.markdown-frontmatter` CSS (Solarized vars: full grid border, bold
  theme-colored key column) and a `markdown.test.ts` vitest spec (11 cases).

**Why:**
- Frontmatter-carrying docs (e.g. skill `SKILL.md` files) rendered their YAML
  header as an oversized heading, which looked wrong and unlike GitHub's preview.

**Key files:** `app/ui/src/workspace/markdown.ts`, `app/ui/src/index.css`, `app/ui/src/workspace/markdown.test.ts`, `doc/main/app/ui/workspace/editor-and-preview.md`
**Verification:** `npx tsc -b` clean, `eslint` clean, `vitest run src/workspace/markdown.test.ts` → 11 passed
**Commit:** (this commit)
**Next:** None
**Blockers:** None

## 2026-06-14: `yaco align` — internalize the status.txt protocol behind 4 verbs

**What changed:**
- Replaced the read-only `yaco align poll` verb with a 4-verb module —
  `init` / `wait` / `handoff` / `status` — that owns the **whole** alignment
  handoff protocol (read + write). The single-line `status.txt` grammar and the
  turn/vote state machine now live in one module; illegal transitions are
  unrepresentable through the CLI (callers never hand-write `status.txt`).
- **Vote inference, no `--vote`:** `wait` snapshots a recursive,
  mtime-independent content hash of `final/` into `discussion/.align/turn.json`;
  `handoff` re-hashes — any edit ⇒ `CHANGES` (reset the other role, re-review),
  no edit ⇒ `APPROVE` (mutual APPROVE ⇒ `DONE`). Collapses the old fragile
  substantive/trivial judgment. Re-running `wait` keeps the baseline (crash-resume).
- `wait` stays process-owning, preserving the poll-era exit-code contract
  (0 YOUR_TURN/DONE, 1 `align.timeout`, 2 `align.error`); interval fixed ~1s,
  `--timeout` default 3600s. `init`/`handoff`/`status` are ordinary
  `{ok,data}/{ok,error}` result commands.
- Addressing: explicit `<dir>` or cwd walk-up to the nearest bundle; raw
  `status.txt` path rejected. 2-party CODEX/CLAUDE rules are hardcoded behind a
  pure `transition(state, role, vote)` function, so a future N-party `align.json`
  manifest needs no rewrite (deferred as YAGNI).
- `/align` SOP collapsed to a `wait → work → handoff` loop (status grammar /
  state-machine / vote / SEQ prose deleted); `/double-design` Step 3 monitors via
  `yaco align status`; `doc/main/cli/align.md` rewritten to the 4-verb interface.
- Deleted `poll.ts` + its two tests; added `protocol`/`store`/`verbs`/`wait`.

**Why:**
- `status.txt` was a shared mutable file whose grammar + state machine were
  prose (restated three places), with only the read side adaptered. Agents
  hand-wrote the status line and hand-applied vote/reset rules — fragile,
  thrice-specified, unvalidated. One deep module makes the protocol the seam.
- Result-path verb errors map onto the existing `ErrCode` enum
  (`USAGE`/`NOT_FOUND`/`CONFLICT`/`INVALID`, condition in the message) rather
  than the exploration's granular dotted codes — those were a hypothetical seam
  (no caller branches on them) and the codebase routes domain errors through
  `ErrCode`. Only the process-owning `wait` keeps `align.timeout`/`align.error`.

**Key files:** `cli/src/commands/align/{protocol,store,verbs,wait,index}.ts`,
`cli/test/unit/commands/align/{protocol,store,align-cli}.test.ts`,
`agent-config/global/skills/{align,double-design}/SKILL.md`,
`doc/main/cli/{align,README,command-surface,doctor}.md`,
`plan/all/yaco-align-cli/`.
**Verification:** `cd cli && bun run test` (align 47/47; the one unrelated
failure is the pre-existing project-move mtime test). `tsc -b` clean for align
files. End-to-end run of the real binary: full `init → DONE` two-agent flow,
vote inference, reset-on-CHANGES, blocking-then-flip wait, and every rejection
path (out-of-turn, no-active-turn, raw path, uninitialized).
**Commit:** 51cc055 (cli module) · 04a38d6 (skills + docs)
**Next:** optional — relocate `align` under `agent` per the `surface-hygiene`
proposal; N-party `align.json` manifest if a third agent ever ships.
**Blockers:** None.

## 2026-06-14: Structured open-questions + final-doc coherence bar for /align and /double-design

**What changed:**
- `/align`: added a **Final Doc Quality Bar** — `final/*` must read as a single-author, top-down artifact with no alignment seams ("Aligned Decisions", "Codex said", resolved-trails); deliberation stays in `discussion/`. Enforced as an approval gate (reviewer returns `CHANGES` on violation), so coherence rides the existing `status.txt` state machine with no extra phase.
- `/align`: added an **Open Question packet** schema — question / impact / options + recommendation-default, plus both-side positions only when Codex and Claude diverge. Placement scales: ≤2 short inline, ≥3 or large → `final/open_questions.md`.
- `/double-design`: references the above `/align` rules instead of restating them; its Doc Structure now shows the optional `final/open_questions.md`.
- Considered then dropped a "closing coherence pass" phase in favor of the approval gate (no extra round, no `B.4` vote exception).

**Why:**
- `final/*` designs read less coherently than `initial/*` ones because the doc inherited the debate's structure and accreted as round-by-round patchwork.
- Open Questions shipped as bare one-line questions, undecidable by the master user they escalate to.
- Approval gate over a dedicated polish phase keeps the change minimal and avoids gold-plating / wasted rounds.

**Key files:** `agent-config/global/skills/align/SKILL.md`, `agent-config/global/skills/double-design/SKILL.md`
**Verification:** Two independent Codex reviews via `yaco agent` — first pass found 5 issues, all applied (B.4-legal coherence transition, seam-ban vs Open-Question Positions carve-out, single-source-of-truth de-dup, placement default, outline rigidity); second pass confirmed granularity matched the surrounding terse style with both regression fixes intact. SOTA surface (`doc/main`, `doc/dev`) checked and unchanged — SKILL.md is the source of truth and CLI/state-machine behavior is untouched.
**Commit:** 66674a5 (skills); this commit (docs)
**Next:** Optionally exercise the new conventions on a real `/double-design` run.
**Blockers:** None.

## 2026-06-14: Clear UI lint warnings

**What changed:**
- Removed the remaining React hook dependency warnings in the UI lint run.
- Made markdown preview DOM application sensitive to `filePath`/project/worktree changes, so relative image URLs are rebuilt when the rendered HTML string is unchanged but its file context changes.

**Why:**
- The lint baseline should be warning-free, and the markdown dependency fix closes a real stale-relative-asset edge case rather than only satisfying the hook rule.

**Key files:** `app/ui/src/components/fileExplorerNode.tsx`, `app/ui/src/hooks/{useProjectWorktrees,useWorkspaceState}.ts`, `app/ui/src/workspace/WorkspaceEditorArea.tsx`
**Verification:** `cd app/ui && npm run lint`; `cd app/ui && npm exec vitest -- src --run`; `cd app/ui && npm run build`; `git diff --check`.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-14: Hide mobile dock grips

**What changed:**
- Hid framed-panel dock grips in the mobile projection so Browse section headers no longer imply touch drag reordering.
- Updated the PanelFrame regression test and mobile context-menu docs to reflect that dock grips remain desktop-only.

**Why:**
- Mobile Browse section order is fixed by mobile dock metadata, while the old shared header grip only exposed desktop DnD/reset behavior and was misleading on touch layouts.

**Key files:** `app/ui/src/workspace/PanelFrame.tsx`, `app/ui/src/workspace/__tests__/PanelHost.test.tsx`, `doc/main/app/ui/mobile.md`
**Verification:** `cd app/ui && npm exec vitest -- src/workspace/__tests__/PanelHost.test.tsx --run`; `cd app/ui && npm exec vitest -- src --run`; `cd app/ui && npm run build`; `cd app/ui && npm run lint` (0 errors / existing 16 hook warnings); code secret scan on touched TSX files; `git diff --check`.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-14: Mobile terminal highlight and editor tab row

**What changed:**
- Scoped the mobile Sessions row active highlight to the currently visible active terminal session while preserving desktop's "all bound terminal tabs are shown" semantics.
- Moved mobile editor mic and view actions into the same projected tab row as mobile editor tabs; tabs scroll horizontally on the left and actions stay fixed on the right.
- Removed the duplicate mobile editor body action row so the editor body owns only breadcrumbs and content.
- Added regression coverage for mobile terminal row highlight semantics and the one-row mobile editor tab/actions chrome.

**Why:**
- Mobile Terminal renders one active terminal body, so marking every previously bound terminal session as blue made hidden sessions look visible. Mobile Editor also had two stacked control rows, causing the action icons to wrap/overlap with tabs.

**Key files:** `app/ui/src/workspace/{MobilePanelProjection,WorkspaceEditorColumn,EditorActions}.tsx`, `app/ui/src/workspace/panels/{SessionsPanel,EditorPanel}.tsx`, `app/ui/src/workspace/__tests__/MobilePanelProjection.test.tsx`, `app/ui/src/workspace/panels/__tests__/{SessionsPanel,EditorPanel}.test.tsx`, `doc/main/app/ui/{mobile,workspace/sessions-and-terminal}.md`, `plan/all/20260612_panel-dnd/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run src` (68 files / 922 tests passed, existing jsdom canvas warning); `cd app/ui && npm run build`; `cd app/ui && npm run lint` (existing 16 hook dependency warnings only); `git diff --check`.
**Commit:** this commit
**Next:** Optional real-device mobile smoke test.
**Blockers:** None.

## 2026-06-14: Group split icons and icon-only preview controls

**What changed:**
- Replaced the group tab bar's single click-to-menu Split button with two direct icon buttons: split right and split down.
- Kept the full Split Up/Down/Left/Right menu on right-click / long-press for the split icons, tab-bar empty area, and tab title context routes.
- Converted markdown/html Edit/Split/Preview controls to icon-only buttons. The middle split icon now reflects the current preview split direction and toggles direction when split mode is already active.
- Updated accessible labels and unit/e2e coverage for direct split right, direct split down, retained split menus, and markdown preview-mode controls.

**Why:**
- The group-level split affordance and the editor preview split-direction toggle were visually conflated. Direct group split icons make the common right/down actions immediate, while keeping less common split directions in context menus; moving preview direction switching into the editor Split icon keeps it scoped to md/html preview controls.

**Key files:** `app/ui/src/workspace/{GroupTabBar,EditorActions}.tsx`, `app/ui/src/workspace/__tests__/{GroupTabBar,panelDndDropCenter}.test.tsx`, `app/ui/tests/e2e/{mi-qa-editor-split,mi-qa-terminal-split,panel-dnd-routing,workspace-persistence}.spec.ts`, docs under `doc/main/app/{frontend/components,ui/workspace/*}.md`, `plan/all/20260614_group-split-icons/implementation_summary.md`
**Verification:** `cd app/ui && npm exec vitest -- src/workspace/__tests__/GroupTabBar.test.tsx --run`; `cd app/ui && npm exec vitest -- src/workspace/__tests__/panelDndDropCenter.test.tsx --run`; `cd app/ui && npm run build`; `cd app/ui && npm run lint` (existing hook dependency warnings only); focused Playwright for editor split, html preview, kind-routing toggle, and markdown preview-mode cycling.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-14: Unified compact context menus for group tabs and dock grips

**What changed:**
- Removed the framed-panel kebab menu. The rightmost dock grip remains the DnD handle and exposes only `Reset layout` from its right-click / long-press context menu.
- Restored tab-title context menus: file actions (`Save`, `Close`, `Close Without Saving`) render above a divider, then group Split actions and the kind-affinity toggle.
- Unified context-menu styling through the shared `Menu` component: compact spacing with readable `text-ui-md`, and explicit `normal-case font-normal tracking-normal` so menus do not inherit section-header uppercase/bold styles.
- Moved Sessions `Open beside` into the session-row context menu and removed the row hover button; the kill affordance is icon-only.
- Added regression coverage for tab context menus, grip reset menus, iOS native-menu suppression markers, and updated e2e flows to use grip/session context menus.

**Why:**
- Dock movement is now covered by DnD, so the header menu only needed a reset recovery path. Tab right-click still needed file-specific commands, and iOS long-press should trigger app menus without surfacing the system callout.

**Key files:** `app/ui/src/components/Menu.tsx`, `app/ui/src/workspace/{GroupTabBar,PanelFrame,PanelGroup,WorkspaceSessionList}.tsx`, removed `app/ui/src/workspace/PanelMenu.tsx`, tests under `app/ui/src/workspace/**/__tests__` and `app/ui/tests/e2e/*`, docs `doc/main/app/{frontend/components,ui/mobile,ui/workspace/{overview,editor-and-preview,sessions-and-terminal,user-flows}}.md`, `plan/all/20260612_panel-dnd/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run src`; `cd app/ui && npm run build`; `cd app/ui && npm run lint` (existing hook dependency warnings only); focused Playwright suites for flexible ops, editor split, terminal split, and multi-instance terminals; `git diff --check`.
**Commit:** this commit
**Next:** Optional real-device iOS smoke test for tab/grip/session long-press menus.
**Blockers:** None.

## 2026-06-14: Panel DnD sizing, edge routing, and mobile active-instance fixes

**What changed:**
- Refined panel drag-and-drop edge behavior: far-edge strips now render only for absent sidebars, preserving sidebar-internal dock reorder at the screen edge; bottom insertion lines clamp inside the sidebar; a right-sidebar group created from a tab/group drop now appears above the dock stack.
- Made split resizing propagate live container size so same-axis nested splits scale proportionally instead of pinning internal dividers in absolute pixels.
- Tightened `separateKinds` fallback routing: when no matching-kind group exists, a new terminal group is created on the center edge nearest the `sessions` dock and a new editor group on the opposite edge, anchoring to the relevant edge group when multiple center groups exist.
- Updated mobile projection to render the active editor/terminal instance across the full desktop tree, including right-sidebar groups, so Browse session/file clicks switch panes and show the newly activated instance.
- Normalized several dense sidebar/search/badge text tokens from extra-small to readable UI token sizes.

**Why:**
- User testing found dock drops near a visible sidebar edge could trigger root-edge placement and destabilize the sidebar, right-sidebar groups landed in an unintuitive position, kind-affinity new-group placement was too hardcoded, and mobile panes could switch without showing the activated file/session.

**Key files:** `app/ui/src/workspace/{DesktopPanelTreeLayout,MobilePanelProjection,WorkspaceProvider}.tsx`, `app/ui/src/workspace/{panelLayoutModel,usePanelResize,context}.ts`, `app/ui/src/hooks/useLayoutState.ts`, `app/ui/tests/e2e/helpers/dnd.ts`, `app/ui/src/workspace/__tests__/*`, `app/ui/src/hooks/__tests__/openRouting.test.ts`, `doc/main/app/{README,frontend/state,ui/mobile,ui/workspace/{overview,state-machine}}.md`, `plan/all/20260612_panel-dnd/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run src`; `cd app/ui && npx playwright test tests/e2e/panel-dnd-routing.spec.ts`; `cd app/ui && npm run build`; `cd app/ui && npm run lint` (existing hook dependency warnings only); `git diff --check`.
**Commit:** this commit
**Next:** Optional broader Playwright coverage for mobile active-instance projection.
**Blockers:** None.

## 2026-06-13: Panel drag-and-drop + kind-affinity open routing (region model)

**What changed:**
- **Enforced region model.** The desktop tree is canonicalized into three regions — a **left** sidebar (dock leaves only), the **center** working-area grid (groups only), and a **right** sidebar (docks + ≤1 group). `normalizeRegions` is the last pass of the single `withDesktop` funnel every tree edit passes through, repairing any loaded/edited tree to the `left? · center · right?` row (center = sole visible grow child; docks evicted from center; groups relocated out of the left; 2nd+ right group merged into the first). `regionsOf`/`centerOf` read it in O(1); `closeGroup`/`ensureCenterGroup` keep the center backstopped with ≥1 group.
- **VSCode-style drag-and-drop.** Drag a tab, a whole group, or a dock panel. A tab dropped on a group body's **center** merges, on an **edge band** splits a new group toward that edge, on a **tab strip** inserts at the pointer index; a group drops `beside` (new split) or `merge`s into another; a dock reorders within a sidebar or, at a far screen edge, reveals/extends a sidebar. Two reducer actions (`MOVE_TAB`/`MOVE_GROUP`) wrap pure `panelLayoutModel` transforms (`moveTabBetweenGroups`/`moveGroupBeside`/`mergeGroups`) — the moved tab keeps its `instanceId`, so its terminal binding + per-path buffer travel. `dndGeometry.legalZones` is the visual gate (region constraints decide which `DropOverlay` zone lights up); the normalize funnel is the authoritative second gate. The dragged identity rides a module-level `WorkspaceDragContext` (HTML5 `dataTransfer` is unreadable mid-drag) tagged `application/yaco-pane` so foreign/list drags stay distinct.
- **Kind-affinity open routing (opt-in).** A **Separate editors and terminals** toggle (group tab-bar menu) sets `panelState.separateKinds`. With it on, the reducer-owned `OPEN_ROUTED_*` opens call `resolveOpenTarget(kind, state)`: an open lands in the focused group when its active-tab kind matches (or it is empty), else the most-recent OTHER group of that kind (kind-MRU), else a fresh center split (`splitCenterGroup`). Off (default), every open targets the resolved focus group. Kind is derived from the live active tab, never stored.

**Why:**
- A flexible panel tree needed VSCode's spatial editing (drag to split/merge/move) and the kind-affinity workflow ("editors here, terminals there") on top of the group model. The enforced region model is the substrate that makes both safe — the same invariant gates the drop overlays and repairs any resulting tree. Builds on the group model in `plan/all/20260612_panel-vscode-tabs/design.md`.

**Key files:** `app/ui/src/workspace/{dndGeometry,WorkspaceDragContext,DropOverlay,InsertionMarker,DesktopPanelTreeLayout,GroupTabBar,PanelGroup,panelLayoutModel,context}.{ts,tsx}`, `app/ui/src/hooks/{useLayoutState,useWorkspaceState,usePersistence,workspaceTypes}.ts`, `app/ui/src/components/Menu.tsx`; tests under `app/ui/src/**/__tests__/*` + `app/ui/tests/e2e/{panel-dnd-routing.spec.ts,helpers/dnd.ts}`; docs `doc/main/app/{ui/workspace/{overview,state-machine},frontend/{state,hooks},data-model/persistence}.md`.
**Verification:** Feature shipped with unit (dnd geometry, move/merge mutations, open-routing, routing-wire) + e2e (`panel-dnd-routing` driving real affordances) coverage. This entry is the docs sync — no code changed.
**Commit:** Milestone on `task/panel-dnd` + this docs commit.
**Next:** None outstanding.
**Blockers:** None.

## 2026-06-12: VSCode tab groups — flat tab strips, Tasks overlay, loader migration

**What changed:**
- **Working area is a grid of groups.** Replaced the editor-only `MAIN_TABS`/home-editor model with a grid of **groups** (`tabs` nodes). Each group holds an ordered, mixed strip of tabs: one editor tab per open file/diff (`GroupTab {instanceId, kind:'editor', tabId, preview?, pinned?}`), one tab per terminal (`{instanceId, kind:'terminal'}`). The tree is authoritative for group order, each group's `activeTab` (`''` for an empty group — a first-class persisted node), and editor-tab payload.
- **FLAT tabs.** Every file is its own editor tab; the per-editor `editorViews`/`openTabs` list is gone. Shared per-path buffers are unchanged (GC keep-set = `allEditorTabPaths`), so two tabs on one path mirror edits. The aux maps (`terminalBindings`/`editorMru`/`terminalMru`/`focusedPane`) stay keyed by `instanceId`; a new persisted `activeGroupId` (resolver: `activeGroupId` → focused tab's group → first group) names the open target. A NULLABLE selection API (`activeEditorTab`/`Id`/`Path`, `editorTabByInstance`, `editorTabsInGroup`, `terminalTabsInGroup`) derives over the active group.
- **Split / close / reorder.** Splitting spawns an **empty** adjacent group (`splitGroup` via right-click the tab bar's empty area or the dismiss-safe Split button), which becomes the open target — it never clones a file or PTY. `closeGroupTab`/`closeGroup`, within-group `reorderGroupTab`. A session click routes through the flat `resolveSessionClick` (focus | create) + the atomic `OPEN_BOUND_TERMINAL_TAB` (bound-on-create; the old rebind path is gone). Keyboard: `Cmd+\` / `Cmd+K Cmd+\` split the active group; `Cmd+W` closes the focused tab or an empty non-last group; session cycling routes through `clickSession`.
- **Tasks is a full-working-area overlay** (`showTasks`, default closed, `Meta+Shift+T`) over the editor groups — not a dock leaf. The four dock panels (projects/files/changes/sessions) stay singleton leaves. Mobile projects the active group's active editor + terminal.
- **Persistence.** `PersistedState` drops `editorViews`, adds `activeGroupId`; a pure, idempotent `migrateTreeToGroups` in the loader expands an old editor's `openTabs` into N per-file tabs (old-editor-id → new active-tab `instanceId` map re-points `editorMru`; terminal ids + dirty buffers preserved; the old `tasks` tab dropped). Self-describing, no version bump.

**Why:**
- The shipped multi-instance model encoded the opposite structure (editor-only `panels: PanelId[]`, terminals-as-leaves, the `'editor'` home special-case, a per-editor `openTabs[]`). The group model makes the working area a uniform VSCode-style grid where a file IS a tab and a terminal IS a tab in one freely-orderable strip, closing the four prior bugs by construction. See `plan/all/20260612_panel-vscode-tabs/design.md`.

**Key files:** `app/ui/src/workspace/{panelLayoutModel,PanelGroup,GroupTabBar,DesktopPanelTreeLayout,WorkspaceProvider,useWorkspaceKeyboard}.{ts,tsx}`, `app/ui/src/workspace/panels/{EditorPanel,TerminalPanel}.tsx`, `app/ui/src/hooks/{workspaceTypes,useLayoutState,usePersistence}.ts`; tests under `app/ui/src/**/__tests__/*` + `app/ui/tests/e2e/*`; docs `doc/main/app/{frontend/{state,hooks,components},data-model/{persistence,types},ui/{keyboard,app-shell,mobile,workspace/*},README}.md`, `doc/dev/app/workflow.md`. This entry is the docs sync — no code changed.
**Verification:** Feature shipped with unit + e2e coverage (e2e migrated to the group model + new tab-group flows).
**Commit:** `f3029b7..8be73ea` (12 commits on `task/vscode-tabs`) + this docs commit.
**Next:** None outstanding.
**Blockers:** None.

## 2026-06-12: Disable native iOS long-press menus on app-owned menu targets

**What changed:**
- Added shared `nativeContextMenuDisabledProps` and attached it to `useContextMenu().bind()` targets, rendered `Menu` surfaces, and the mobile `TerminalKeyBar`.
- Added scoped CSS for `[data-yaco-native-context-menu='disabled']` that disables iOS touch callouts and selection menus while restoring normal selection for nested text inputs/contenteditable elements.
- Updated mobile docs to reflect the current 350ms long-press threshold and the native-menu suppression contract.

**Why:**
- App-owned right-click/long-press actions should show YACO's custom menus or repeat terminal keys without Safari's native long-press menu competing on mobile.

**Key files:** `app/ui/src/components/{nativeContextMenu.ts,Menu.tsx,useContextMenu.ts,TerminalKeyBar.tsx}`, `app/ui/src/index.css`, `doc/main/app/ui/mobile.md`
**Verification:** `cd app/ui && npm run lint`; `cd app/ui && npm run build`.
**Commit:** this commit
**Next:** Real-device iOS smoke test for file tree, project/session rows, editor tabs, and terminal key repeat.
**Blockers:** None.

## 2026-06-11: Multi-instance panels — N editor + N terminal panes with per-instance state

**What changed:**
- **N editors + N terminals.** Relaxed the panel tree's `single-occurrence` rule for an `editor`/`terminal` whitelist (`MULTI_INSTANCE_PANELS` in `panelLayoutModel.ts`). The home editor keeps the constant id `'editor'` (a `main` tabs entry); secondary editors (`editor:2…`) and all terminals (`terminal`/`terminal:2…`) are leaves. Added id-addressed structural ops (`newInstanceId`/`splitBeside`/`closeLeaf`/`moveLeaf`) and the routing primitives (`editorInstancesInOrder`/`terminalInstancesInOrder`, `resolveActiveEditor`/`resolveActiveTerminal`).
- **One reducer owns the hot state.** `useLayoutState.ts` now hosts `instanceReducer` (desktop tree + `editorViews` + `terminalBindings` + `editorMru` + `terminalMru` + `focusedPane`). Every structural transition seeds ids + GCs the maps/MRU against the tree atomically — the tree is authoritative, a read for a missing id defaults (`EMPTY_VIEW`/unbound). The hook derives the single-value globals (`openTabs`/`activeTab`/`previewTab`/`activeSession`) over the active instance for compat.
- **File buffers stay global by path.** `useFileState` keeps `files`/`dirtyTabs`/`conflictTabs` keyed by path (shared document model — two editors on one file stay in sync) and adds a shared-buffer GC: keep iff referenced by an open view **or** dirty, so close/reset never silently loses unsaved work.
- **Focus / active-instance routing.** Type-global commands act on the active instance (MRU head → first in order). `PanelHost` publishes each pane's `instanceId` + `data-instance-id`; the renderer marks the focused pane bright (`data-focused`) and the active-but-unfocused editor/terminal dim (`data-active`, suppressed when one-of-type). `jumpRequest` carries `instanceId`. Mobile projects the active instance.
- **Instance-aware panels + chrome.** `EditorPanel`/`TerminalPanel` read their `instanceId` slice; Split/Move/Close chrome; `clickSession` (smart-focus-else-replace) + `openBeside` (1-per-session); per-session miss-count reconcile closes panes for dead sessions; rename rebinds all bound terminals; `visibleSessions` set drives unread (both tiled terminals mark read).
- **Desktop global voice control.** New `GlobalVoiceControl` (mic + target indicator + dropdown) portaled from `WorkspaceScreen` into an App-owned top-bar slot; voice target carries a frozen `instanceId`. Per-pane mic kept on mobile.
- **Keyboard chords.** `Cmd+\` (split focused pane, geometry axis), `Cmd+K Cmd+\` (orthogonal), `Cmd+Enter` (open file to side), instance-aware `Cmd+W`; session/tab cycling acts on the active instance.
- **Persistence.** `PersistedState` drops the old global `openTabs/activeTab/previewTab/activeSession` for `editorViews`/`terminalBindings`/`editorMru`/`terminalMru` + the tree (which carries instance ids). One-time migration of the old flat blob + load-normalize (reconstitute `main`, GC maps, dedup one-per-session).

**Why:**
- "Watch two agents" and "compare two files" were a toggle dance. The editor/terminal hot state was global singletons; making it per-instance (in selection maps keyed by `instanceId`, GC'd by an authoritative tree) is the minimal model that supports N panes without a dual source of truth. Keeping buffers global by path means a shared document model with no per-instance buffer reconciliation. See `plan/all/20260611_panel-multi-instance/design.md`.

**Key files:** `app/ui/src/workspace/{panelLayoutModel,panelInstance,context,WorkspaceProvider,WorkspaceScreen,useWorkspaceKeyboard,useWorkspaceSessions,useWorkspaceVoice,PanelHost,DesktopPanelTreeLayout,MobilePanelProjection}.{ts,tsx}`, `app/ui/src/workspace/panels/{EditorPanel,TerminalPanel,SessionsPanel}.tsx`, `app/ui/src/hooks/{useLayoutState,useFileState,usePersistence,useSessionUnreadState,workspaceTypes,voiceStateMachine}.ts`, `app/ui/src/components/GlobalVoiceControl.tsx`, `app/ui/src/App.tsx`; tests under `app/ui/src/**/__tests__/*` + `app/ui/tests/e2e/multi-instance-*.spec.ts`; docs `doc/main/app/{frontend/{state,hooks},data-model/{persistence,types},ui/{app-shell,keyboard,mobile,workspace/*},README}.md`, `doc/dev/app/workflow.md`.
**Verification:** Feature shipped with unit coverage (`instanceReducer`, `panelLayoutModelMulti`, `panelInstance`, `sharedBufferGc`, `layoutMigration`) and e2e (`multi-instance-{editors,terminals,persistence,mobile}`, `close-surface`, `shared-state`, `voice-target`); characterization specs migrated to the new persisted shape. This entry is the docs sync — no code changed.
**Commit:** `4e6a1a7..639e760` (17 commits on `task/panel-mi`) + this docs commit.
**Next:** Group-focus shortcuts (`Cmd+1/2/3`) were deferred (binding clash with session shortcuts).
**Blockers:** None.

## 2026-06-11: Task graph slash shortcut no longer steals voice compose input

**What changed:**
- Task graph's `/` search shortcut now ignores all text-entry targets (`input`, `textarea`, `select`, and `contentEditable`) instead of only ignoring `input`.
- Added a focused toolbar regression test proving `/` still focuses Search tasks from the page, but does not prevent default or move focus while a textarea is active.

**Why:**
- When the task graph was open, pressing `/` inside the voice compose tray textarea was intercepted by the task search shortcut, so the slash was not entered and focus jumped to Search tasks.

**Key files:** `app/ui/src/tasks/TaskGraphToolbar.tsx`, `app/ui/src/tasks/__tests__/TaskGraphToolbar.test.tsx`
**Verification:** `cd app/ui && npx vitest run src/tasks/__tests__/TaskGraphToolbar.test.tsx`; `npm run lint`; `npm run build`.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-11: Colocated repos — `plan/` as a private repo, first-class in the app

**What changed:**
- **General colocated-repo mechanism.** A depth-1 child that is its own git repo but kept out of the host repo (motivating case: `plan/`) is now first-class in the app — searchable, changes/diffs shown, tree undimmed — without entering host git. The app never hardcodes `plan`; `app/server/src/lib/colocatedRepos.ts` (`getColocatedRepos`) detects the set by signal: `.git` exists (dir or worktree file), **not in host index** (one `git ls-files -z`), **not matched by the root working-tree `.gitignore`** (reuses `gitignore.ts`, so detection ≡ dimming). Policy from `yaco.toml [colocated] repos` = `auto`|`off`|comma allow-list; realpath-keyed short-TTL cache.
- **Multi-repo read-only git surfaces.** `/status` (`git.ts`) aggregates host + each colocated repo with a `<repo>/` prefix, deterministic order, one `seen` set; snapshots re-keyed by `<effectivePath>\0<repoPrefix>` (fixes the prior by-projectName worktree-sharing bug) with a partial-failure state table. `/files` search-index (`files.ts`) merges per-repo `git ls-files` (the v1 blocker — host `--exclude-standard` can't see an `info/exclude`d nested repo). `resolveFileRepo` routes `/diff` (`deny`) and `/baseline` (`preserve`) to the owning repo, handling deleted colocated files and never running git outside the project.
- **Explicit `[paths] plan` root.** `yaco-paths.ts` gains `plan` (default `plan`) + `backlog`; `tasks/active/archive/backlog` are plan-relative internally but `readYacoProjectPaths()` returns repo-relative effective paths (default layout byte-identical, callers unchanged). `parseScopedToml` re-exported from the barrel.
- **`yaco plan init`** (new `plan` CLI area). In-place `git init`, `/<plan>/` in the git-resolved `info/exclude` (never committed → public repo clean + app doesn't dim it), default `<plan>/.gitignore` (never overwritten), idempotent, `--remote` adds origin but **never pushes**. Refuses if the root `.gitignore` matches plan or if run from inside the plan repo.

**Why:**
- `plan/` shouldn't ship in the open-sourced repo, but physically moving it out is undesirable. Splitting the two conflated meanings of "git-ignored by the host" — real-git exclusion (`info/exclude`) vs YACO surfacing (mirror read-only git per repo) — keeps it colocated, private, and first-class. A general signal (not hardcoding `plan`) is IDE-like and makes the "plan tracked in the host repo just works" case fall out for free. Pushing the separate plan repo is a personal preference, so the tool only ever adds a remote.

**Security/robustness pass (Codex review):** reject `[paths]` segments starting with `-` + pass paths after `--` to git (no git-option injection, e.g. `plan = "--bare"`); canonicalize plan roots (`./plan` → `/plan/` in `info/exclude`, not `/./plan/`) and require a depth-1 plan root in `yaco plan init`; `/diff` (deny policy) skips the `--no-index` content read for a path that realpaths outside the project tree (a symlinked-in external file/dir never leaks); drop reserved `auto`/`off` tokens in allow-list position. Codex final verdict: APPROVE (0 blockers/majors).

**Key files:** `app/server/src/lib/colocatedRepos.ts` (new), `app/server/src/routes/{git,files}.ts`, `cli/src/lib/core/paths/{yaco-paths,index}.ts`, `cli/src/commands/plan/{index,init}.ts` (new), `cli/src/main.ts`; tests under `app/server/src/{lib,routes}/__tests__/` + `cli/test/unit/{core/paths,commands/plan}/`; docs `doc/main/app/backend/{routes,libs}.md`, `doc/main/cli/{paths,plan,README,command-surface}.md`.
**Verification:** app/server `vitest run src/` → 526 passed (35 files); `cli bun run test` → 945 passed, 1 pre-existing unrelated failure (`project/move.test.ts` jsonl mtime, also red on `main`). Each phase independently code-reviewed + committed; final Codex review pass (2 rounds) → APPROVE.
**Commit:** `3ef3e7c`..`e59901e` on branch `task/colocated-repo`, merged to `main`.
**Next:** optional `colocated-tree-badge` (backlog); the one-time OSS migration (`plan-repo-migration` milestone — history scrub + separate private repos) is human-driven and out of scope here.

## 2026-06-11: Notification & attention redesign (v2) — two facets, server-projected attention, fail-closed crash contract

**What changed:**
- **Two facets.** Split the old notification system into **Facet A** (live status dots, client-derived from the session snapshot — now including a `crashed` dot/chip) and **Facet B** (attention: bell, badges, interrupts). Facet B is **server-projected and SSE-pushed** so a hidden/backgrounded tab still gets interrupted (the client polling path is suppressed while `document.hidden`, but an `attention` SSE push still arrives).
- **CLI fail-closed crash contract.** Agent status union gains `crashed` (+`exitCode`, +`statusEnteredAt`). The wrapper EXIT trap captures `ec=$?` and, on a non-zero agent exit that isn't an intentional kill, tombstones the session as `crashed` via `yaco agent mark-crashed` — or an inline `crash_fallback` shell rewrite (same JSON shape / same generation) when the binary can't run. A generation-scoped `.killing` sentinel (carrying `createdAt`) distinguishes an intentional kill; `list --reconcile` GC and `start` reclaim both skip a `crashed` tombstone; only `yaco agent kill` clears it. `YACO_BIN` is an absolute path reaching the wrapper via tmux `-e`.
- **Durable generation identity.** `setStatus` stamps `statusEnteredAt` on every session status transition; `yaco task set` stamps `stateEnteredAt` on every state change including rollup-flipped parents. The attention generation id is `<kind>:<proj>::<subject>:<enteredAt>`, stable across restart / reload / second device. `appendEvent` is idempotent by id, so re-seeing an edge never re-notifies.
- **Server Facet B.** New `attention-engine.ts` (change-driven edge detection over session/task fs-watches + boot reconciliation + `attention` SSE push), `attention-projection.ts` (pure, server-owned projector: ACT open-from-live, REVIEW unread vs. a monotonic ack watermark, owner routing OWNED/DELEGATED, dedup/supersede, badge precedence), `attention-runtime.ts` (fs readers + cold-mount snapshot), and `routes/attention.ts` (`GET /feed`, `POST /ack`, `POST /clear` — server-stamped, monotonic). The 60s session-reconciler is reduced to GC + safety.
- **Removed the capped-50 inbox.** Deleted `notifications-store.ts`, `notify.ts:dispatch()`, the inbox REST endpoints, and the per-item `notification` / `notifications:changed` SSE events; kept `GET /api/notifications/stream` as the SSE transport and added the `attention` event. Client: deleted `useSessionUnreadState` + `useNotifications`; added `useAttention` (hidden-tab-safe `attention` subscription, OS notification while hidden, active-viewing guard with window focus, ack/clear, permission requested only on a user gesture). Bell shows Needs-you / Ready / Recent; collapsed-parent rollup badge is separate from the self-only status dot; owned-idle leaf shows a "↩ your turn" chip.

**Why:**
- The old system had two competing unread systems and a capped, recurrence-prone inbox; "clear" didn't durably stick, and a hidden tab missed interrupts. A crash could be GC'd before anyone saw it. The redesign makes ACT open-ness derived from live status (no stored/dismissed flag), REVIEW a monotonic-max watermark, crash a fail-closed durable tombstone, and interrupts reach hidden tabs — pulling the user back only for things that need them and making "clear" mean something. Facet B moved server-side (vs. v1 client-only) to get hidden-tab push, a global task snapshot, and stable cross-device generations in one place.

**Key files:** cli: `scripts/agent-wrapper.sh`, `src/commands/agent/{mark-crashed,kill,status,start}.ts`, `src/lib/core/agent/{model,projection,kill-sentinel}.ts`, `src/commands/task/set.ts`, `src/lib/core/task/model.ts`; app/server: `lib/{attention-engine,attention-projection,attention-runtime,notify,eventsLog,ui-state,project-watcher,session-reconciler,agent}.ts`, `routes/{attention,notifications,ui-state}.ts`, `index.ts`; app/ui: `hooks/useAttention.ts` (+ deleted `useSessionUnreadState`/`useNotifications`), `hooks/useSSE.ts`, `components/{NotificationBell,NotificationPanel,BadgeCount}.tsx`, `lib/attentionColors.ts`, `App.tsx`, `workspace/WorkspaceSessionList.tsx`, `tasks/TaskGraphNode.tsx`, `types.ts`. Design: `plan/all/20260611_notif-redesign-v2/eng-design_claude.md`.
**Verification:** Per-task unit + integration suites added (crash contract, status-edge identity, attention engine/projection/routes, ui-state watermarks, `useAttention` incl. hidden-tab, attention e2e). Not re-run in this docs pass.
**Commit:** d9e76e4..e08490d (code); this commit (docs).
**Next:** Deferred OQs — `waiting` signal (OQ2) and a recent-interaction active-viewing signal (OQ5), both with cheap upgrade paths.
**Blockers:** None.

## 2026-06-11: Voice — revert streaming segmentation to a single-take unified compose tray

**What changed:**
- **Single take, no segmentation.** Replaced the mid-recording VAD chunker (`voiceVad.ts` + `VadCoalescer` + the `segments[]`/`pendingCount`/finalization-gate machinery in `voiceStateMachine.ts`) with `voiceCapture.ts`: one continuous take via the native `MediaRecorder`, ended by the user (Stop / F5 / the 300s cap), transcribed once → formatted once → appended to the compose draft. Multiple takes append in sequence; the reducer is now `idle → requesting_permission → recording → transcribing → composing/error`.
- **Dropped the neural VAD.** Removed `@ricky0123/vad-web` + `onnxruntime-web` and their self-hosted assets (~13 MB, 11 MB of it the uncompressed onnxruntime wasm — the ~10s first-load) — the `viteStaticCopy` block + `__VAD_ASSET_BASE__` define in `vite.config.ts` and the `.wasm`/`.onnx` MIME entries in the server. Recording now starts instantly. Capture sits behind a `startCaptureSession()` seam so a silence auto-stop (an `AnalyserNode` RMS watcher calling the same `stop()`) can be added later without touching the state machine/hook/tray.
- **Unified compose tray.** `ComposeTray` is now one surface for type / paste / record → Insert, shared by desktop headers (`VoiceControl` → `onOpen`) and the mobile key bar (`TerminalKeyBar`'s inline paste textarea replaced by a compose launcher → `onOpenCompose`). The draft lives in the tray; the hook emits `appendText:{text,key}`.
- **IME-safe send + sticky close.** Send is **⌘/Ctrl+Enter** (plain Enter is a newline, so Chinese-IME candidate Enter can't mis-send). The tray no longer dismisses on an outside click — X / Esc only (`DialogShell` gained `dismissOnOverlayClick`), with the existing clipboard backup on every close.
- **Cached-audio Retry.** The take's blob is cached; `retry()` re-sends it (the old `retry` was a no-op `dismiss` that discarded the audio). `/format` network failures fall back to appending the raw transcript so words are never lost.

**Why:**
- The streaming chunker was bug-prone (a chunk that never returned stalled or failed the whole run) and felt worse than not segmenting. VAD's only real job here is end-of-speech detection, which doesn't justify shipping a 13 MB neural runtime; manual Stop/F5 is simpler and more robust. Merging voice with the mobile paste bar makes one universal compose surface (voice / keyboard / paste) on desktop and mobile, and the IME-safe send + no-outside-click close fix frequent accidental sends/dismissals.

**Key files:** `app/ui/src/hooks/{voiceCapture.ts (new, replaces voiceVad.ts),voiceStateMachine.ts,useVoice.ts}`, `app/ui/src/components/{ComposeTray.tsx,VoiceControl.tsx,DialogShell.tsx,TerminalKeyBar.tsx,Terminal.tsx}`, `app/ui/src/workspace/{useWorkspaceVoice.ts,WorkspaceScreen.tsx,useWorkspaceKeyboard.ts,WorkspaceEditorColumn.tsx,context.ts,panels/TerminalPanel.tsx}`, `app/ui/{vite.config.ts,package.json}`, `app/server/src/index.ts`; tests `app/ui/src/hooks/__tests__/{voiceStateMachine,voiceCapture,useVoice}.test.*` + `tests/e2e/voice-compose-backup.spec.ts`; docs `doc/main/app/{README,frontend/hooks,frontend/components,backend/routes,backend/server}.md`.
**Verification:** `app/ui` lint clean (0 errors, 9 pre-existing warnings); `vitest run src/` → 519 passed (incl. 20 voice unit tests); `npm run build` clean (no dangling `__VAD_ASSET_BASE__`/vad-web/onnx refs); `app/server` tests → 504 passed. The dev-only `voice-compose-backup` e2e parses + lists 3 tests but was not executed here (a main-checkout dev server occupies the `E2E_REUSE` ports; isolated mode self-skips by design) — run under `E2E_REUSE=1` against a worktree dev server for manual QA.
**Commit:** pending.
**Next:** Optional silence auto-stop (energy-based, behind the existing `startCaptureSession`/`onAutoStop` seam) if reaching for Stop proves tedious.
**Blockers:** None.

## 2026-06-11: Mobile keyboard viewport shrink scoped to the terminal

**What changed:**
- `useKeyboardViewport` no longer overrides `#root` height for every focused input. New `isTerminalContext()` (focused element inside `[data-terminal-surface]`) gates `apply()`: it sets `--kb-viewport` only when the terminal owns the keyboard, otherwise clears the override.
- `Terminal.tsx` root tagged with `data-terminal-surface`, covering both keyboard triggers in the terminal — the xterm helper textarea and the key-bar paste textarea.

**Why:**
- The hook ran globally, forcing `#root` to a JS-measured `visualViewport.height` on every page. On non-terminal pages this fought native keyboard handling (Android `interactive-widget=resizes-content` reshapes `dvh`; iOS scrolls the focused field into view), and the mismatch left a blank band above the keyboard. Only xterm genuinely needs the manual shrink — its fixed canvas + offscreen helper textarea are never scrolled into view, and iOS PWA delays its viewport update. The 40% estimate was already terminal-scoped; this scopes the real-value shrink too.

**Key files:** `app/ui/src/hooks/useKeyboardViewport.ts`, `app/ui/src/components/Terminal.tsx`, `doc/main/app/ui/mobile.md`, `doc/main/app/frontend/hooks.md`
**Verification:** `cd app/ui && npx tsc --noEmit` clean; `npm run lint` (0 errors, 9 pre-existing hook warnings); `npx vitest run src/components/__tests__/Terminal.focus.test.tsx` → 31 passed. On-device keyboard behavior not exercisable in CI — needs phone verification (terminal: content/key-bar flush above keyboard; editor/browse/tasks/search: blank band gone).
**Commit:** b83b99a (code) + this commit (docs)
**Next:** None.
**Blockers:** None.

## 2026-06-11: Sessions search polish and pattern matching

**What changed:**
- Sessions search now renders as a fixed control above an independently scrollable live/history list, matching the Explorer full-text search layout instead of relying on a sticky first row.
- Live/History and desktop theme toggles keep their original flat visual styling while using clearer outer borders.
- Session search keeps plain substring AND semantics, and adds wildcard terms (`*`, `?`) plus whole-query regex forms (`/pattern/flags`, `re:pattern`) with invalid regexes failing closed.
- Session-search unit and Playwright coverage now assert wildcard/regex behavior and that the search control stays outside the scrolling list.

**Why:**
- The sticky search-row approach left edge cases where list content could peek between the section header and search control. Separating controls from the results list is simpler and matches the existing file-search architecture.

**Key files:** `app/ui/src/workspace/{useWorkspaceSessionSection.tsx,panels/SessionsPanel.tsx,SessionSearchBox.tsx,sessionSearch.ts}`, `app/ui/src/index.css`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`, `doc/main/app/frontend/components.md`
**Verification:** `cd app/ui && npx tsc -b`; `npx vitest run src/workspace/__tests__/useWorkspaceSessionSection.test.tsx src/workspace/panels/__tests__/SessionsPanel.test.tsx src/workspace/__tests__/sessionSearch.test.ts`; `npx playwright test tests/e2e/session-search.spec.ts`; `npm run lint` (0 errors, 9 existing hook warnings).
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-10: Editor diff gutter handles symlinks (baseline reads target's HEAD blob)

**What changed:**
- `GET /api/git/:project/baseline` resolves symlinks via a new `resolveBaseline()` helper and runs `git show HEAD:./<basename>` from the target's own directory, instead of `git show HEAD:<filePath>` from the project root. Paths absent on disk fall back to the literal lookup.

**Why:**
- The gutter diffs the live editor buffer against this baseline. For a symlink, `git show HEAD:<symlink>` returns the link *text* (target path string) while `/files/content` serves the realpath'd target's content, so every line read as changed and the whole file showed a blue (modified) bar. Reading the target's HEAD blob aligns both sides. Targets outside any repo correctly fall to `exists:false` (shown as a new file).

**Key files:** `app/server/src/routes/git.ts`, `app/server/src/routes/__tests__/{git-diff,git-baseline-symlink}.test.ts`, `doc/main/app/backend/routes.md`, `doc/main/app/ui/workspace/editor-and-preview.md`
**Verification:** `cd app/server && npx vitest run src/routes/__tests__/git-diff.test.ts src/routes/__tests__/git-baseline-symlink.test.ts` → 16 passed (incl. a real-temp-repo case: symlink→target content, plain file, target outside any repo→`exists:false`). Codex review: APPROVE, no blockers.
**Commit:** ccbba04
**Next:** None.
**Blockers:** None.

## 2026-06-09: Flexible-layout T1a — data-resource adapters (git + sessions)

**What changed:**
- New `app/ui/src/workspace/resources.ts`: explicit `WorkspaceGitResource` / `WorkspaceSessionsResource` interfaces + `WorkspaceData`, and the single-poller composition hooks `useWorkspaceGitResource` (wraps `useGitStatus`), `useWorkspaceSessionsResource` (wraps `useSessions` + `useWorkspaceSessions`, derives `liveSessionHandles`), and `useWorkspaceData`.
- Characterization test `__tests__/resources.test.ts`: pins one git poller + one sessions poller + exactly one sessions manager per render (call-through spy on `useWorkspaceSessions` + single pinned-sessions load), and a compile-time `Equal<>` guard that fails `tsc` if either public interface stops being an explicit field map.
- Doc note added to `doc/main/app/frontend/state.md` (Workspace Data Resources).

**Why:**
- The flexible-layout Data Context must expose only the genuinely-shared cold resources (`git`, `sessions`) behind stable, explicit types — no `ReturnType<typeof hook>` leaking a hook's return shape into the context surface — while preserving the single-owner-per-poller invariant the whole refactor depends on. Not yet wired into `WorkspaceScreen`; consumed by the provider in a later phase.

**Key files:** `app/ui/src/workspace/resources.ts`, `app/ui/src/workspace/__tests__/resources.test.ts`, `doc/main/app/frontend/state.md`
**Verification:** `cd app/ui && npx vitest run src` → 26 files / 321 passed; duplicate-poller guard 5/5; `npx tsc -b` clean; eslint clean. Both test guards verified non-vacuous (double-mount → fail; type drift → tsc error).
**Commit:** 183db46 (code) + docs (this change). Worktree `task/fl-data-resources`; not pushed/merged.
**Next:** wire `useWorkspaceData` into the Data Context during phase 1 (workspace-contexts).

## 2026-06-09: Phase-0 e2e baseline repair + per-worktree isolation

**What changed:**
- New shared helper `app/ui/tests/e2e/helpers/workspace.ts`: corrected `yaco-workspace:` (+ `:wt:`) localStorage key, `openWorkspace`/`provisionWorkspace`/`getWorkspaceState`/`createTestFile`/`writeFileViaAPI`/`waitForSSERefresh`, geometry probes, and per-run namespacing (`runTag`/`uniqueFileName` + `createFixtureProject`/`createWorktreeFixture`/`createBinaryFixture` register temp git projects under unique names and self-dispose).
- `workspace-persistence.spec.ts`: repaired stale `workflow-workspace:`/`workflow-ui-state` keys and a non-existent `<header>` wait (the suite never reached an assertion before); each localStorage read now pairs with a DOM/geometry assertion (sidebar ≈220px hidden/visible, projects section ≈projectSize, section renders collapsed). Pinned-session test rewritten to the real `/api/ui-state` contract (pins moved off workspace localStorage). Every test self-provisions its project(s).
- `worktree.spec.ts`: replaced the phantom `worktree-qa` fixture (never registered) with a per-run git fixture (auth-v2 dirty+ahead, perf-cache clean, ui-cleanup no worktree); context-switch test now asserts a worktree-only file (`wip.txt`) appears/disappears.
- `binary-preview.spec.ts`: per-run fixture (text/PDF/PNG); image test opens the PNG and asserts the `<img alt="Image preview">` editor surface.
- `e2ePorts.ts` + `playwright.config.ts`: worktree runs get an isolated `YACO_HOME` (`<tmpdir>/yaco-e2e-home/<slug>`) so parallel runs never clobber the shared registry/ui-state; main checkout unchanged.

**Why:**
- The named characterization net (design Phase 0 gate) was hollow — stale rebrand keys + a missing `<header>` element meant zero assertions ran, and worktree/binary specs depended on projects absent from `~/.yaco`. The refactor needs a real regression net first. Per-worktree `YACO_HOME` + self-provisioning lets the orchestrator run ~10 phase tasks in parallel worktrees without registry collisions.

**Key files:** `app/ui/tests/e2e/{helpers/workspace.ts,workspace-persistence.spec.ts,worktree.spec.ts,binary-preview.spec.ts}`, `app/ui/{e2ePorts.ts,playwright.config.ts}`, `doc/dev/app/workflow.md`
**Verification:** `cd app/ui && npx playwright test workspace-persistence worktree binary-preview` → 22 passed (main checkout). Verified in an isolated git worktree (empty `YACO_HOME`) under 4 parallel workers → 22 passed, twice; `~/.yaco` left untouched; eslint clean.
**Commit:** a67d6ea (baseline repair) + c9de611 (isolation + review fixes) + docs (this change)
**Next:** Phase 1 (workspace-contexts) — the tripwire spec is now meaningful.
**Blockers:** None.

## 2026-06-09: Collapsible parent sessions in the live session list

**What changed:**
- `sessionLineage.ts` — `SessionLineageRow` gains `hasChildren`; new pure `filterCollapsedRows(rows, collapsed)` drops a collapsed parent's descendants per render bucket (single depth-threshold sweep over the contiguous, depth-first subtree, keeping the collapsed parent visible).
- `WorkspaceSessionList.tsx` (`SessionItem`) — a parent's provider icon doubles as the collapse/expand toggle: wrapped in a button with `aria-expanded`, overlaid by a small Solarized-blue triangle badge (▾ expanded / ▸ collapsed, white caret + halo ring). Leaf rows render the plain icon, so the pin/icon/status columns never shift between parents and leaves. `INDENT_STEP` stays 14.
- `useWorkspaceSessionSection.tsx` — `collapsedSessions` set loaded from / persisted to `localStorage['yaco-sessions:<project>']` (pruned to live session names, with an empty-list guard so a transient empty refresh doesn't clobber it); `groupSessionLineage` still buckets the full lineage, then each tier passes through `filterCollapsedRows` before render.
- Tests: `hasChildren` flagging + `filterCollapsedRows` cases in `sessionLineage.test.ts`; click-to-collapse/expand in `useWorkspaceSessionSection.test.tsx`.

**Why:**
- Brings the task-graph's collapse/expand affordance to the session list so a parent (orchestrator) session can fold away its spawned children. Putting the toggle *on the icon* (rather than an inline chevron column) keeps every row's left cluster aligned — a collapsed parent no longer looks indented — and avoids the wasted empty column an always-present chevron slot would add to every leaf row.

**Key files:** `app/ui/src/workspace/{sessionLineage.ts,WorkspaceSessionList.tsx,useWorkspaceSessionSection.tsx}` + their `__tests__`, `doc/main/app/ui/workspace/sessions-and-terminal.md`, `doc/main/app/frontend/components.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/` → all pass (incl. new collapse cases); `npx tsc -b` → 0 errors; `eslint` → clean. Verified live via Playwright: collapse hides the subtree, the badge flips ▾/▸, state persists across reload, and the pin/icon/status columns stay aligned in both states.
**Commit:** aa67f7f (feat) + docs (this change)
**Next:** None — feature complete. The badge accent is a single token (`--sol-blue`) if a different color is wanted later.
**Blockers:** None.

## 2026-06-09: UI blocked dot, reason badge, subtree-max ordering (session-blocked-state 5/6)

**What changed:**
- `app/ui/src/types.ts` — added `'blocked'` to `SessionStatus`, a `BlockReason = 'permission' | 'question' | 'trust'` union, and `AgentSession.blockReason?` (present only when `status === 'blocked'`).
- `WorkspaceSessionList.tsx` — `STATUS_DOT_CLASS.blocked` is an orange `animate-pulse` dot (deliberately distinct from processing's cyan glow — reads as *needs-you*, not activity). A small orange reason badge next to the name maps `permission → "needs approval"`, `question → "has a question"`, `trust → "needs trust review"` (also on `title`/`aria-label`; the status dot's `aria-label` becomes `"blocked: <reason>"`).
- `sessionLineage.ts` — `groupSessionLineage` now buckets each root-anchored subtree by a **subtree-max priority** (`blocked > processing > idle`) instead of by the root's status alone: any blocked/processing member promotes the whole (still-contiguous) subtree to the active bucket, and a subtree rooted at a `blocked` session sorts to the top of that bucket. Pinned roots still take precedence.
- `useWorkspaceSessions.ts` — display order is now `pinned → blocked → processing → idle`.
- `App.tsx` + new `lib/sessionCounts.ts` — extracted the per-project active/total count into a pure `computeProjectSessionCounts` helper; `blocked` now counts toward `active` alongside `processing`/`starting`.
- Tests: updated the lineage processing-child-under-idle case (now promotes to active) and added blocked-descendant-promotes, blocked-root-sorts-to-top, and standalone-blocked-counts-active cases; new `lib/__tests__/sessionCounts.test.ts` directly asserts blocked counts as active (AC3).

**Why:**
- Closes the session-blocked-state feature end-to-end: a CLI hook-driven `blocked` status now surfaces in the UI as a distinct dot + reason so a session waiting on the user (permission/question/trust) is visible at a glance instead of looking idle. Subtree-max bucketing is the minimal change that prevents a blocked child under an idle parent from being buried at the bottom of the list.

**Key files:** `app/ui/src/types.ts`, `app/ui/src/workspace/{WorkspaceSessionList,sessionLineage,useWorkspaceSessions}.tsx?`, `app/ui/src/App.tsx`, `app/ui/src/lib/sessionCounts.ts`, `app/ui/src/workspace/__tests__/sessionLineage.test.ts`, `app/ui/src/lib/__tests__/sessionCounts.test.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`, `doc/main/app/data-model/types.md`, `doc/main/app/frontend/components.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/sessionLineage.test.ts` → 16 pass; `npx vitest run src/lib/__tests__/sessionCounts.test.ts` → 4 pass; `npx tsc --noEmit` → 0 errors; `npm run lint` → 0 errors (pre-existing warnings only).
**Commit:** pending (orchestrator commits centrally).
**Next:** session-blocked-state task graph complete (all 6 tasks landed end-to-end: CLI status model + hook state machine + send/status + trust gate, app-server, UI).
**Blockers:** None.

## 2026-06-09: Startup trust gating — Codex hooks-review → blocked(trust) (session-blocked-state 6/6)

**What changed:**
- `yaco agent start` now gates Codex's two hooks-review interstitials (`Hooks need review … Trust all and continue`, `Press t to trust all`) behind a fail-closed predicate `codexHooksAllYacoOwned(sessionPath)`, declared on the interstitial as `guard` + `blockReason: "trust"`. The trust-FOLDER interstitial stays unguarded (pure auto-Enter).
- `StartupInterstitial` gained optional `guard?: (sessionPath) => boolean` and `blockReason?: BlockReason`. `handleStartupInterstitial` now returns `"none" | "handled" | "blocked"`; on guard-fail it writes `setStatus(state, "blocked", "trust")`, sends no keys, marks the interstitial handled, and `waitForReady` bails early (so a `blocked(trust)` session doesn't spin to the 30s timeout). The existing `starting`-only `syncStateAfterStart` guard keeps `blocked(trust)` intact; Codex's widened `SessionStart` hook clears it → idle once the user trusts manually.
- The predicate enumerates all four effective Codex hook sources — global+project `hooks.json` (JSON) and inline `[hooks]` in global+project `config.toml` (`Bun.TOML.parse`; malformed → block) — and requires, per source: an event-key allowlist (`CODEX_HOOK_EVENTS`, plus a validated `[hooks.state]` trusted-hash subtree for TOML), the correct per-source shape (json array-of-groups vs toml `{hooks:handler[]}` object), and every enabled handler being `type:"command"` with the exact canonical `<yaco-binary> agent hook-event <Event>` command (whole-string anchored, not the substring `isYacoOwnedGroup` helper). Returns false on any foreign handler, unknown event key, wrong shape, non-command type, unparseable/unreadable source, or unexpected shape.
- Added `test/trust-gate.test.ts` and **registered it in `package.json` `test:unit`** (it was previously unregistered, so `bun run test` silently skipped it). Made the two Codex interstitial tests in `lifecycle-guards.test.ts` hermetic (`withCleanCodexHome`) so the gate isn't poisoned by the real `~/.codex` or a cross-test `hookBinary()` cache.

**Why:**
- The two hooks-review screens previously auto-trusted whatever was in the effective hooks config — a foreign hook injected into any source would be silently dismissed. The gate is a security predicate: it auto-dismisses only when YACO can account for the *entire* effective hook set as its own canonical command, and otherwise pauses the session for a human (`blocked(trust)`). Fails closed on every uncertainty (foreign/unknown/wrong-shape/unparseable).

**Key files:** `cli/src/lib/core/agent/lifecycle.ts` (`codexHooksAllYacoOwned` + helpers), `cli/src/commands/agent/start.ts` (guard path, early bail), `cli/src/lib/core/agent/providers/{types,codex}.ts`, `cli/test/{trust-gate,lifecycle-guards}.test.ts`, `cli/package.json`, `doc/main/cli/{lifecycle,providers}.md`
**Verification:** `cd cli && bun test test/trust-gate.test.ts` → 28 pass; `cd cli && bun run test` (full) → 868 pass, 0 fail.
**Commit:** pending (orchestrator commits centrally).
**Next:** session-blocked-state task graph complete (6/6).
**Blockers:** None.

## 2026-06-09: Hook state machine — blocked transitions (session-blocked-state 2/6)

**What changed:**
- `applyHookEvent` rewritten to write all status via `setStatus` and drive the new `blocked` status. Added `QUESTION_TOOLS = {AskUserQuestion, request_user_input}` (Claude + Codex question tools) and a 6th `toolName` parameter threaded from the hook payload's snake_case `tool_name`.
- Transitions: `PreToolUse(q-tool)` → `blocked(question)`, non-q-tool → processing; `PostToolUse`/`PostToolUseFailure(q-tool)` → processing (answer received, cancelled, or failed — covers the failure edge so a cancelled question never strands); `PermissionRequest` and `Notification(permission_prompt)` → `blocked(permission)`; `Notification(idle_prompt)` → idle, other → no-op.
- Widened the `SessionStart` guard: clears `starting`/`idle`/`blocked(trust)` → idle, but never clobbers a mid-session-active state (`processing` or `blocked(permission|question)`). `blocked` is cleared implicitly by the next processing/idle event (last-event-wins; no explicit unblock).
- `commands/agent/hook-event.ts` reads `tool_name` from stdin via the extended `HookInput` type.

**Why:**
- A question previously read as `processing` (busy) and a permission prompt as `idle`, so "agent needs you" was invisible. `blocked(reason)` makes the waiting-on-user state explicit and distinct from idle.

**Key files:** `cli/src/lib/core/agent/hook-event.ts`, `cli/src/commands/agent/hook-event.ts`, `cli/test/{hook-event,hook-update}.test.ts`, `doc/main/cli/state-contract.md`
**Verification:** `cd cli && bun test test/hook-event.test.ts test/hook-update.test.ts` → 50 pass, 0 fail.
**Commit:** pending (orchestrator commits centrally).
**Next:** remaining session-blocked-state tasks (send/status flip, app-server reconciler, UI blocked dot, trust gate).
**Blockers:** None.

## 2026-06-09: Startup interstitial replay guard

**What changed:**
- `waitForReady()` now treats startup interstitial auto-answers as one-shot per start and lets provider adapters suppress stale matches when a later prompt appears after the matched dialog text in captured output.
- Codex and Claude startup trust/review interstitials use provider prompt glyphs only for that stale-scrollback suppression; Codex placeholder wording is not part of the match.
- Added regression coverage for the stale Codex `Hooks need review` text followed by a live `› /` composer, plus a positive test that an active hook-review menu still receives `Down` + `Enter`.
- Aligned the Claude history slash-command contract so history rows keep `/command args`, matching live summary labels.

**Why:**
- Codex hook-review text can remain in tmux scrollback after the real prompt is active. The old wide screen-capture match could send `Down` + `Enter` into a slash-command menu.
- Slash-command summaries should preserve the command name for both history and live labels so the source of the request stays visible.

**Key files:** `cli/src/commands/agent/start.ts`, `cli/src/lib/core/agent/providers/{claude,codex,history,types}.ts`, `cli/test/{lifecycle-guards,history}.test.ts`, `doc/main/cli/{architecture,providers}.md`
**Verification:** `cd cli && bun run test:unit` passed (813 tests); `yaco agent start claude ... --wait` review of commit `02ec0db` reported no required code fixes and no file changes.
**Commit:** `02ec0db` (code); docs update follows.
**Next:** If a real Codex trust-folder or `Press t` overlay screen is observed with provider prompt glyphs below the matched phrase, make that adapter pattern engulf the whole active screen like the hook-review matcher.
**Blockers:** None.

## 2026-06-09: Codex start rename is async title sync

**What changed:**
- Codex provider title sync now uses one path for every start: after bootstrap readiness, YACO enqueues `/rename <handle>` through `sendKeysWhenInputEmpty` and never waits for provider-title settle.
- Removed `postStartInputTiming`, Codex prompt detection, and the start-path `waitForPostInputSettle` screen-capture wait. `waitForReady()` remains for bootstrap readiness and trust/hooks-review prompts, not for rename sequencing.
- Kept internal slash-command delivery on tmux bracketed paste + immediate `Enter`; raw literal `send-keys` was tested and rejected because Codex treated the submit key as a newline in the composer.

**Why:**
- The Codex thread title is best-effort metadata; YACO's authoritative identity is the tmux session/state/task handle. A single async input-empty gated `/rename` path keeps empty starts, prompt starts, and later provider-title sync behavior simple while avoiding the too-early start-time paste path that Codex can treat as a queued follow-up input.

**Key files:** `cli/src/commands/agent/start.ts`, `cli/src/lib/core/agent/providers/{codex.ts,types.ts}`, `cli/src/lib/core/agent/tmux.ts`, `cli/test/providers.test.ts`, `doc/main/cli/{architecture.md,lifecycle.md,providers.md}`
**Verification:** `cd cli && bun test test/providers.test.ts test/start.test.ts test/tmux.test.ts test/lifecycle-guards.test.ts` passed (120 tests); `cd cli && bun build src/main.ts --target=bun --outfile /tmp/yaco-cli-build-check` passed; `tools/install.sh --cli-only` passed with doctor 12/12. `cd cli && bun run test:unit` still fails on the pre-existing `claude history list > collapses a leading slash command to its args` expectation (`payment flow` vs `/design payment flow`). Subagent code review of the earlier settle-guard version passed; this follow-up simplification removes that branch entirely.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

## 2026-06-08: Attached-session Codex OSC color responder

**What changed:**
- Added `app/server/src/lib/terminal-osc.ts`, a pure OSC 10/11/12 color-query responder that consumes Codex color probes from PTY output, supports split chunks and ST/BEL terminators, and returns normal output separately from OSC responses.
- The terminal WebSocket now passes the resolved xterm foreground/background/cursor colors in the URL. app/server answers Codex color probes directly at the PTY bridge instead of relying on browser xterm `onData` timing.
- CLI detached-startup color handling is intentionally left on the existing provider-runtime path; this change only adds the attached-session responder.

**Why:**
- Mid-session Codex focus/requery events could time out or receive a different color than startup, causing the input box background to fade back toward the surrounding editor background. The server bridge is the stable place to answer attached-session queries because it already owns the tmux attach PTY stream.

**Key files:** `app/server/src/lib/terminal-osc.ts`, `app/server/src/index.ts`, `app/ui/src/components/Terminal.tsx`, `app/ui/src/lib/providerUi.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/server && npx vitest run src/lib/__tests__/terminal-osc.test.ts src/lib/__tests__/terminal.test.ts` passed (29 tests); `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (30 tests); `cd app/ui && npx eslint src/components/Terminal.tsx src/components/__tests__/Terminal.focus.test.tsx src/lib/providerUi.ts` passed. `cd app/server && npx tsc --noEmit` still fails on pre-existing unrelated type errors in server/cli workspace imports, node-pty typing, OpenAI response casts, WhatsApp, routes/files, and worktree tests.
**Commit:** pending.
**Next:** None.
**Blockers:** None.

## 2026-06-08: Codex prompt frame ignores background rows

**What changed:**
- Browser-side Codex prompt frame detection no longer uses xterm background-color continuity to decide where the overlay ends.
- Prompt frames now use only structural text boundaries (`›` prompt starts, reply/interruption/shell marker rows, viewport-tail status rows, and slash/shell suggestion tables), so Codex's OSC 11-driven prompt/user-message background can remain enabled without moving the overlay's bottom rule.
- No-boundary prompts trim trailing blank viewport rows back to the last nonblank prompt row, preserving multi-line prompt content while avoiding frames that balloon to the viewport bottom.
- Added regression coverage for background-painted trailing blanks before `• Working`, bg/no-bg frame invariance, and no-boundary blank trimming.

**Why:**
- Codex paints its own padding rows when terminal background reports are available. The overlay lines should identify the prompt by characters/structure, not by whether adjacent rows share the same background.

**Key files:** `app/ui/src/lib/codexInputPromptFrame.ts`, `app/ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed (29 tests); `cd app/ui && npm run lint` passed with 0 errors and 10 existing hook-dependency warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Markdown-first inline suggestions (reworked, default-off)

**What changed:**
- Reworked the editor inline-suggestion feature from a generic code-completion engine into a small **markdown continuation engine**. Server now builds a heading-path + current-block + byte-budgeted local-context prose prompt (chat-style exact-insert, not code FIM), runs a postprocess rejection set, and guards non-markdown/secret/fenced inputs (`complete()` returns empty without calling the model). Added a per-model completion LRU with TTL + model-in-key.
- UI is markdown-only (`.md`/`.markdown`), **default OFF**, single-line ghost only (multi-line `BlockGhostWidget` removed). Guards: non-markdown, fenced-code, mid-word, read-only/diff, secret-glob, min-context (with a fresh list/heading-marker exemption). Debounce raised to a named `SUGGESTION_DEBOUNCE_MS` (1000ms). `Tab` accepts full; `Mod-→` accepts next word (local re-anchor, no server call); `Alt-\` manual trigger; `Esc` dismisses; typing clears. Every cancellation path drops pending/in-flight work. Tab-bar toggle relabeled "inline suggestions".
- Added content-free local metrics at `localStorage["yaco-inline-suggestions:<project>:<worktree>"]` (`shown`, `accepted_full`, `accepted_word`, `dismissed_escape`, `dismissed_typing`, `disabled_after_shown`, `error`) with accept-rate derivation. No document/prompt/suggestion text or absolute paths stored.

**Why:**
- The old feature shipped on-by-default as a code-FIM engine emitting multi-line ghost paragraphs after a 1.5s pause into markdown docs — it annoyed before it helped, so the user kept disabling it. Disuse was explained by a fixable mismatch (code prompt + paragraph ghosts + on-by-default), not by "inline suggestion is worthless for prose," so the infrastructure was reworked rather than deleted. Default-off respects the user's revealed preference and keeps the privacy story clean (nothing leaves the machine until opt-in). The local metrics exist to drive an objective **delete gate** after ~2 weeks / ~200 shown: keep ≥~25% accept rate, tune ~10–25%, delete <~10% (or delete immediately on any secret-glob/ineligible-file leak). The removal task is pre-scoped so "delete" stays a clean operation. Files/route/env are intentionally NOT renamed in v1 to reduce churn on a possibly-deleted feature.

**Key files:** `app/server/src/lib/autocomplete.ts`, `app/server/src/routes/autocomplete.ts`, `app/ui/src/lib/editor/inlineAutocomplete.ts`, `app/ui/src/components/Editor.tsx`, `app/ui/src/hooks/workspaceTypes.ts`, `app/ui/src/workspace/WorkspaceEditorColumn.tsx`, `doc/main/app/README.md`, `doc/main/app/ui/workspace/editor-and-preview.md`, `doc/main/app/backend/{routes,libs}.md`
**Design doc:** `plan/all/markdown-inline-suggestions/final/design.md`
**Commits:** `8404c9c` (server), `53d1874` (codemirror), `6fc4746` (telemetry)
**Next:** Dogfood opted-in, then evaluate the delete gate.

## 2026-06-08: Dashed guide lines for nested sessions

**What changed:**
- The live session list now draws a dashed vertical guide line per ancestor level in the indent gutter of nested (`parentSession`) rows, so parent→child relationships read at a glance like the task-graph tree connectors.
- Each `SessionItem` row is `position: relative` and renders `depth` absolutely-positioned `aria-hidden` / `pointer-events-none` dashed spans (`var(--sol-text-dim)` @ 0.6 opacity, centred in each indent step). Indent geometry pulled into named constants (`INDENT_BASE`, `INDENT_STEP`, `GUIDE_OFFSET`).

**Why:**
- Indentation alone made parent/child sessions hard to distinguish; a visible dashed connector (color/opacity tuned with the user — `--sol-border` @ 0.5 was too faint, solid was too heavy) matches the existing task-graph aesthetic.

**Key files:** `app/ui/src/workspace/WorkspaceSessionList.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npm run lint` passed (0 errors, pre-existing hook-dep warnings only); confirmed live via hot reload.
**Commit:** `b25083a`
**Next:** None.
**Blockers:** None.

## 2026-06-08: Unify nav-chrome icon buttons and hovers

**What changed:**
- Collapsed all section-header icon buttons (Explorer/Changes/Projects/Sessions, incl. session spawn buttons) into one `.section-header-icon-btn` definition: box/icon size as CSS vars, hover lift to `base2`, selected state via `aria-pressed` lifting to `base3`. Removed the per-button `.spawn-btn` and the explorer icon-wrapper components.
- Added hover feedback to the session live/history toggle (`.session-tab-seg`, `data-active`-driven) and to the top-bar notification/channels icons (`.chrome-icon-btn`, lifts to `base3` since the top bar sits on `base2`); the theme toggle's inactive half brightens on hover.
- Removed the desktop bottom margin bar (it only duplicated project name + clock).
- Anchored the notifications dropdown to its icon (`absolute right-0`) so it opens leftward like the channels dropdown instead of pinning to the viewport edge.

**Why:**
- The header icons had inconsistent box sizes, icon sizes, and hover styles; centralizing makes them tweakable from one place. The bottom bar was redundant chrome, and the two dropdowns opened in opposite directions.

**Key files:** `app/ui/src/index.css`, `app/ui/src/workspace/WorkspaceScreen.tsx`, `app/ui/src/workspace/SectionHeader.tsx`, `app/ui/src/workspace/useWorkspaceSessionSection.tsx`, `app/ui/src/components/{FileExplorer,fileExplorerIcons,NotificationBell,NotificationPanel,WeChatLoginDialog}.tsx`, `app/ui/src/App.tsx`
**Verification:** `cd app/ui && npm run lint` passed (0 errors, 10 pre-existing hook-dep warnings); verified live via hot reload.
**Commit:** `2a9477e..fe2c529`
**Next:** None.
**Blockers:** None.

## 2026-06-08: Codex command suggestions stay outside prompt frames

**What changed:**
- Codex prompt frame detection now treats active slash-command and dollar-triggered plugin/skill suggestion tables as prompt-menu boundaries.
- `/` suggestions count only when the first prompt row starts with `/`; `$` suggestions count from the prompt's last nonblank row only when `$` is at text start or follows whitespace and the next rows have the `Name  [Plugin|Skill] ...` table shape.
- Line-start `$` output/shell markers remain a separate reply boundary, so indented prompt input like `  $` is not confused with output.

**Why:**
- Codex command suggestion rows are rendered below the input composer and should not be enclosed by the browser-side prompt frame.

**Key files:** `app/ui/src/lib/codexInputPromptFrame.ts`, `app/ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk-size warnings; `git diff --check -- app/ui/src/lib/codexInputPromptFrame.ts app/ui/src/components/__tests__/Terminal.focus.test.tsx` passed.
**Commit:** `6dbcac5`
**Next:** None.
**Blockers:** None.

## 2026-06-08: Codex prompt frame logic split out

**What changed:**
- Moved Codex-specific input prompt frame detection from `Terminal.tsx` into `ui/src/lib/codexInputPromptFrame.ts`.
- `Terminal.tsx` now owns xterm lifecycle and overlay rendering, while the provider-specific module owns prompt start, background, reply-boundary, and status-boundary rules.

**Why:**
- The boundary logic is Codex-specific and should not clutter the generic terminal component.

**Key files:** `app/ui/src/lib/codexInputPromptFrame.ts`, `app/ui/src/components/Terminal.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed; `cd app/ui && npm run build` passed with existing eval/chunk-size warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Search panels consolidated into header toggles

**What changed:**
- Removed the standalone left-sidebar Search section; the Explorer header now has a search button that switches the Explorer body between file tree and cross-file text search.
- Search mode exposes three header actions: quick file search, full text search, and back to Explorer.
- Added a shared `PanelSearchBox` so cross-file search and Sessions search use the same compact input styling.
- Quick file search keeps `Cmd+P` as the desktop shortcut, gives mobile a header entry point, preserves `.gitignore` button keyboard toggling, and keeps keyboard-selected results scrolled into view.
- Sessions search is now hidden by default behind a header search button; closing it clears the query so hidden search never filters rows.

**Why:**
- Cross-file search is rarely used, so it no longer consumes a permanent sidebar section. Search controls now read as one product surface across Explorer and Sessions.

**Key files:** `app/ui/src/index.css`, `app/ui/src/workspace/{WorkspaceScreen.tsx,WorkspaceLayout.tsx,WorkspaceSearch.tsx,WorkspaceTextSearch.tsx,PanelSearchBox.tsx,SessionSearchBox.tsx,useWorkspaceKeyboard.ts,useWorkspaceSessionSection.tsx,useWorkspaceSidebarResize.ts}`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/{README.md,frontend/components.md,ui/workspace/overview.md,ui/workspace/sessions-and-terminal.md,data-model/persistence.md}`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/useWorkspaceSidebarResize.test.ts src/workspace/__tests__/useWorkspaceSessionSection.test.tsx src/workspace/__tests__/sessionSearch.test.ts` passed; `cd app/ui && npx playwright test tests/e2e/session-search.spec.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings; Playwright smoke on `https://desktop.tailnet-example.ts.net/` verified `Meta+P` opens quick search, search results render, and no runtime error fires.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Codex prompt frame follows prompt background

**What changed:**
- Codex prompt frame detection now follows the non-default xterm background used by the rendered prompt block.
- Explicit user-authored newlines, including blank lines and unindented paragraph starts, remain inside the frame while assistant output after the prompt stays outside.
- Prompt start detection now requires a line-start `›`, so quoted prompt glyphs inside agent replies are ignored.
- The no-background fallback now extends until a structural Codex boundary: a line-start `•` reply row, a line-start `■` interruption row, or a viewport-tail Codex status line (`tab to queue message` or dot-separated status text).
- Added terminal regression tests for multi-paragraph Codex prompts with internal blank lines, with and without prompt background attributes.

**Why:**
- The old text-only continuation scan stopped at blank or non-indented rows, so multi-paragraph user prompts drew the lower rule too high.

**Key files:** `app/ui/src/components/Terminal.tsx`, `app/ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk-size warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Session rename draft survives status moves

**What changed:**
- Live session rows now render as one keyed sibling list across pinned, processing, and idle visual tiers.
- Inline rename state is preserved when a `starting` session refreshes to `idle` and moves tiers.
- Added a jsdom regression test that starts rename, edits the draft, rerenders the session as idle, and asserts the draft remains.

**Why:**
- React remounted rows when the same keyed session moved between separate bucket arrays, so an in-progress rename closed and lost the user's typed draft.

**Key files:** `app/ui/src/workspace/useWorkspaceSessionSection.tsx`, `app/ui/src/workspace/__tests__/useWorkspaceSessionSection.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/useWorkspaceSessionSection.test.tsx src/workspace/__tests__/useWorkspaceSessions.test.ts src/workspace/__tests__/sessionLineage.test.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings; `git diff --check -- app/ui/src/workspace/useWorkspaceSessionSection.tsx app/ui/src/workspace/__tests__/useWorkspaceSessionSection.test.tsx doc/main/app/ui/workspace/sessions-and-terminal.md doc/PROGRESS.md` passed.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Session search snippets in place

**What changed:**
- Summary/worktree/title/branch/id match snippets now replace the existing inline field instead of rendering a second labeled row.
- Extra labeled snippets are reserved for fields that are not otherwise shown inline, such as provider, status, project, parent, or live-session handle.
- The E2E search spec now asserts summary and branch matches do not duplicate as `summary:` / `branch:` rows.

**Why:**
- Showing `SUMMARY:` below a row duplicated the already-visible summary and made the result explanation inconsistent. In-place replacement keeps the row compact while still surfacing clipped match context.

**Key files:** `app/ui/src/workspace/{WorkspaceSessionList.tsx,WorkspaceHistoryList.tsx,sessionSearch.ts}`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/sessionSearch.test.ts` passed; `cd app/ui && npx playwright test tests/e2e/session-search.spec.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Session search substring matching restored

**What changed:**
- Session search matching was reverted from `fzf` to case-insensitive substring matching with AND semantics across query terms.
- Match highlighting and snippets were kept, now driven by exact substring positions instead of fuzzy positions.
- Snippet selection now prefers the strongest matching snippet field, so branch/live/summary evidence is more likely to explain the actual match.

**Why:**
- Fuzzy matching over long session summaries produced too many unrelated results. Substring matching is more predictable for filtering sessions while still showing why a row matched.

**Key files:** `app/ui/src/workspace/{sessionSearch.ts,WorkspaceSessionList.tsx,WorkspaceHistoryList.tsx}`, `app/ui/src/workspace/__tests__/sessionSearch.test.ts`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/sessionSearch.test.ts` passed; `cd app/ui && npx playwright test tests/e2e/session-search.spec.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Session search match evidence

**What changed:**
- Session search now maps `fzf` positions back to searchable fields and highlights matched characters in live-session and history rows.
- Rows render a labeled snippet when the match lands in a non-primary field such as summary, branch, provider/status, worktree, or live handle.
- Long summary matches now show the matched context even if the normal inline summary is clipped.

**Why:**
- Fuzzy matching can make it unclear why a session survived filtering. Highlighting and snippets expose the exact field/characters that matched without changing the matching looseness.

**Key files:** `app/ui/src/workspace/{sessionSearch.ts,SearchHighlightedText.tsx,WorkspaceSessionList.tsx,WorkspaceHistoryList.tsx,useWorkspaceSessionSection.tsx}`, `app/ui/src/workspace/__tests__/sessionSearch.test.ts`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/sessionSearch.test.ts` passed; `cd app/ui && npx playwright test tests/e2e/session-search.spec.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings.
**Commit:** this commit
**Next:** Revisit fuzzy-match strictness if real usage shows too many unrelated hits.
**Blockers:** None.

## 2026-06-08: Session search fuzzy matching

**What changed:**
- Session panel search now uses `fzf` extended matching, so skipped-letter queries and small typos can match live sessions and history rows.
- The filter preserves existing live/history ordering with `sort:false`, so pinned/processing/idle grouping, lineage rendering, and history recency order are not score-sorted.
- History search excludes timestamps and message counts from the fuzzy text to avoid noisy handle-like matches.

**Why:**
- Users may search sessions with abbreviations or typos, but the session list's existing order carries product meaning and should remain stable.

**Key files:** `app/ui/src/workspace/sessionSearch.ts`, `app/ui/src/workspace/__tests__/sessionSearch.test.ts`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/sessionSearch.test.ts` passed; `cd app/ui && npx playwright test tests/e2e/session-search.spec.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Session panel search

**What changed:**
- Added a local search box to the Workspace Sessions panel, shared by Live and History tabs.
- Live sessions filter by session metadata after the API response is loaded, then reuse the existing lineage/tier grouping over the filtered visible set.
- Session history filters by loaded history row metadata without changing the server/CLI history contract.
- Added focused Vitest coverage for filter semantics and a Playwright E2E covering live/history search and no-match empty states.

**Why:**
- Long live-session lists and history lists were hard to scan. Client-side filtering keeps the feature simple because both lists are already loaded in the UI.

**Key files:** `app/ui/src/workspace/{SessionSearchBox.tsx,sessionSearch.ts,useWorkspaceSessionSection.tsx,WorkspaceHistoryList.tsx}`, `app/ui/src/workspace/__tests__/sessionSearch.test.ts`, `app/ui/tests/e2e/session-search.spec.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace/__tests__/sessionSearch.test.ts` passed; `cd app/ui && npx playwright test tests/e2e/session-search.spec.ts` passed; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Workspace section refresh controls

**What changed:**
- Explorer, Changes, and Sessions section headers now expose a manual refresh action at the far right of each header action group.
- The shared section refresh button spins while its refresh Promise is pending and disables duplicate clicks until the request settles.
- Explorer refresh re-fetches the expanded file tree, Changes refresh re-fetches git status or the active compare, and Sessions refresh re-fetches live sessions or history depending on the active tab.

**Why:**
- SSE/watch events can be missed or delayed, leaving a section out of sync. Users now have a targeted resync control without refreshing the whole page, and the spinner confirms the click was accepted.

**Key files:** `app/ui/src/workspace/SectionHeader.tsx`, `app/ui/src/workspace/WorkspaceScreen.tsx`, `app/ui/src/workspace/useWorkspaceSessionSection.tsx`, `app/ui/src/hooks/useApi.ts`, `doc/main/app/ui/workspace/{explorer-and-changes.md,sessions-and-terminal.md}`
**Verification:** `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings; Playwright smoke check verified button ordering, API requests, and request-bound spinner state.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Codex prompt frame multiline height

**What changed:**
- Codex terminal prompt frames now size to explicit multiline user prompts, not only xterm soft-wrapped rows.
- Frame scanning treats consecutive non-empty continuation rows as part of the prompt for both current and historical messages, and treats blank rows as a hard stop so post-message whitespace is not counted.
- Terminal component tests cover active multiline input, historical multiline prompts, and blank-row termination.

**Why:**
- The first prompt-frame implementation used fixed one-line/soft-wrap assumptions. Real Codex history renders multiline user messages as continuation rows and may leave blank rows after the user message; counting those blanks made the horizontal rules too tall.

**Key files:** `app/ui/src/components/Terminal.tsx`, `app/ui/src/lib/providerUi.ts`, `app/ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` → 14 pass; `cd app/ui && npm run lint` passed with 10 existing hook-dependency warnings; `cd app/ui && npm run build` passed with existing eval/chunk warnings.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Session summaries from the first meaningful prompt

**What changed:**
- Claude and Codex summary labels are now the first *meaningful* user message instead of the literal first record. A shared `collapseUserMessage` / `firstMeaningfulMessage` pass in `history.ts` drops `<system-reminder>` and command-stdout noise, restores slash commands to their original `/name args` input, and skips `/rename`·`/clear`·`/compact` and handle echoes.
- Codex `codexSummarize` now prefers `threads.first_user_message` over the `title` column (Codex auto-renames the title to the YACO handle on every start, so the title was a name echo that the UI sanitizer dropped to blank). The rollout fallback returns the first real message.
- History list hides the default git branch (`main`/`master`) from the row meta; `sanitizeSummary` also strips `<local-command-stdout>` as defense-in-depth.

**Why:**
- The first JSONL/thread record is almost always non-content (a rename reminder, a slash-command wrapper, or the handle-echo title), so summaries frequently rendered blank in the session list. Measured live: 4/18 sessions blank → 0 after the fix.

**Key files:** `cli/src/lib/core/agent/providers/history.ts`, `cli/test/summary.test.ts`, `app/ui/src/workspace/sanitizeSummary.ts`, `app/ui/src/workspace/WorkspaceHistoryList.tsx`, `doc/main/cli/providers.md`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd cli && bun test` (820 pass, summary suite extended to 16); `app/ui` lint clean; rebuilt CLI via `tools/install.sh --cli-only` and bounced the `tsx watch` server — live `/api/sessions` confirms previously-blank sessions now carry real labels.
**Commit:** b20a370 (code) + this docs commit
**Next:** None.
**Blockers:** None — note that the server caches summaries in-process, so a CLI rebuild alone won't refresh existing labels; the server must restart.

## 2026-06-08: Codex terminal input prompt frame

**What changed:**
- Codex terminal panes now render a browser-side cyan frame around visible `›` input prompt rows, including historical user prompts in the current xterm viewport.
- The frame is configured from provider UI metadata (`inputPromptFrame`) and updates after cursor, write, scroll, and resize events through a coalesced `requestAnimationFrame` pass. It scans only the current viewport and does not write to tmux or replace OSC color-query handling.
- Terminal component tests now mock xterm buffer rows and cover current prompt framing, historical prompt framing, and non-Codex suppression.

**Why:**
- Codex input background tint can be visually unstable across redraws. The overlay gives a stable input-row boundary while keeping provider output and OSC compatibility unchanged.

**Key files:** `app/ui/src/components/Terminal.tsx`, `app/ui/src/lib/providerUi.ts`, `app/ui/src/components/__tests__/Terminal.focus.test.tsx`, `doc/main/app/ui/workspace/sessions-and-terminal.md`, `doc/main/app/frontend/components.md`

**Verification:** `cd app/ui && npx vitest run src/components/__tests__/Terminal.focus.test.tsx` → 11 pass; `cd app/ui && npm run build` passed.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-08: Rename input guard for agent sessions

**What changed:**
- `yaco agent rename` no longer rejects `processing` sessions. The state-file/tmux handle rename happens immediately; task `agents` and child `parentSession` rewrites still run after the authoritative rename.
- Provider-native title sync (`/rename <handle>`) now checks the rendered TUI input prompt instead of agent status. Empty prompts send immediately; Codex placeholders are detected by dim ANSI style instead of brittle placeholder text; occupied prompts queue a detached `_send-when-input-empty` helper that waits until the input clears, preventing hidden `/rename` text from merging with a user's draft.
- Codex post-start `/rename` uses the same input-empty sender. Immediate sends still wait for settle; queued sends let startup return without disturbing user input.
- The web session hook no longer stores processing renames in localStorage waiting for idle; it calls the rename API immediately and delegates safety to the CLI.

**Why:**
- Claude/Codex can accept `/rename` while processing, so status was the wrong safety gate. The real race was input composition: if the user had already started typing, YACO could paste `/rename` into that draft and submit `user text /rename name`.

**Key files:** `cli/src/lib/core/agent/{tmux.ts,providers/{idle,types,claude,codex}.ts}`, `cli/src/commands/agent/{start,rename,index}.ts`, `app/ui/src/workspace/{useWorkspaceSessions.ts,useWorkspaceSessionSection.tsx,WorkspaceSessionList.tsx}`, `doc/main/app/ui/workspace/sessions-and-terminal.md`, `doc/main/cli/{architecture,lifecycle,providers,state-contract}.md`.

**Verification:** `cd cli && bun run test:unit` → 801 pass / 0 fail; `cd cli && bun build src/main.ts --compile --outfile /tmp/yaco-rename-guard-build` passed; `cd app/ui && npx vitest run src/workspace/__tests__/useWorkspaceSessions.test.ts` → 6 pass; `cd app/ui && npm run lint` passed with 10 pre-existing hook-dependency warnings; `cd app/ui && npm run build` passed.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-07: yaco CLI read surface + text-first output

**What changed:**
- **Missing read primitives added.** `yaco task get <id>` returns a single task as a labeled `{text}` block (or `{id, task, tasksPath, tasksFile}` JSON, `id` included since the stored record carries no key; `NOT_FOUND` on a miss) — replacing the `list --json | filter` round-trip an agent needed to inspect one task. `yaco task list --state <s>` filters by task state, validated against `STATES` (invalid → `USAGE`) and composing with `--workset`, as a pure read (no roll-up). `yaco project current` resolves the cwd to its owning registered project via longest-prefix match (`findProjectForCwd`), `NOT_FOUND` when the cwd is unregistered.
- **`{text}` is now the single ordinary-result envelope.** Result-bearing handlers branch once through `dual` (`cli/src/lib/core/render.ts`): `--json` emits the structured record, text mode emits a rendered `{text}` block. `{help}` is usage-only. `main.ts`'s `render()` writes both verbatim and now treats any ordinary command that reaches text mode without a `{text}`/`{help}` envelope as an `INTERNAL` error — the old silent compact-JSON fallback is gone. Streaming/process-owning commands (`agent output-follow`, `align poll`, `doctor`) are the explicit allowlist; they own stdout directly. `agent status` gained a text detail block (JSON runtime-state fields pinned, unchanged); `agent wait` / `start --wait` / `send --wait` print the final `text` raw, dropping the `| jq -r .data.text` ceremony.
- **Worktree convention shared, not duplicated.** `worktreePath(repoRoot, slug)` / `worktreeBranch(slug)` are hoisted to `cli/src/lib/core/worktree/convention.ts`, re-exported from the barrel, and published as `@yaco/cli/core/worktree` (`cli/package.json#exports`). `app/server/src/lib/worktree.ts` imports them and drops its two hardcoded `.worktrees/<slug>` / `task/<slug>` templates; a scheme change can no longer break the app's worktree-status reader silently. The app's git-status aggregation and `{active, dirty, branch, ahead, behind}` shape are unchanged; `app/ui` untouched.
- **`/yaco*` skills flipped to text-first.** Read/inspect examples drop `--json`; `--json` is reserved for programmatic consumption of a structured record and the `{ok}` success/failure discriminator.

**Why:**
- The `yaco` CLI is consumed by AI agents, not just humans and the web app. Two gaps made it agent-hostile: no single-record reads (forcing whole-collection `--json` + client-side filter), and a text mode that fell through to a compact JSON dump for ~60% of result-bearing commands. This pass adds the read primitives, makes text the readable default, and shares the one real app↔CLI convention gap.

**Docs:** Added [doc/main/cli/command-surface.md](main/cli/command-surface.md) as the canonical Command Surface Matrix + output convention; updated `doc/main/cli/{README,task,worktree,paths}.md` and `cli/CLAUDE.md`. Area consolidation (9 → 6: `env`, `install` folding) is split out as a deferred `surface-hygiene` follow-up.

**Key files:** `cli/src/lib/core/render.ts`, `cli/src/lib/core/worktree/convention.ts`, `cli/src/commands/{task/get,project/current}.ts`, `cli/src/lib/core/project/find-cwd.ts`, `cli/src/main.ts`, `cli/package.json`, `app/server/src/lib/worktree.ts`, `agent-config/global/skills/{yaco,yaco-agent,yaco-task}/SKILL.md`, `doc/main/cli/**`, `cli/CLAUDE.md`.
**Design:** [plan/all/yaco-read-surface/design_claude.md](../plan/all/yaco-read-surface/design_claude.md).
**Verification:** `cd cli && bun run test` → 793 pass / 0 fail; `cd app/server && npm test` → 424 pass / 0 fail; `tsc --noEmit` clean on all touched files (the 4 remaining errors are pre-existing in `agent/session-id.*`). Codex design-conformance re-review closed two follow-ups: `project add/remove/move` + `agent list` were still returning `{help}` for results (now `{text}`, so `{help}` is truly usage-only), and `worktree merge`/`cleanup` still re-spelled the slug templates (now routed through `worktreePath`/`worktreeBranch` so `convention.ts` is the sole source).
**Commit:** 7237c8d..3fcabcc
**Blockers:** None.

## 2026-06-06: agent reads/mutation split — pure `list`/`status`, `--reconcile` owns GC

**What changed:**
- **`yaco agent list` (default) and `yaco agent status <handle>` are now pure reads.** They resolve a session's display status read-only (state file + capture-refined status for stale entries + in-memory pid/sessionId backfill) and filter confirmed-dead sessions out of the view, but never call `deleteState`/`writeState`. A read-shaped command no longer has a destructive side effect — a `list` on the wrong tmux socket can never GC a live session's state file (the pid-guard already prevented data loss; this removes the mutation entirely from the read path).
- **`yaco agent list --reconcile` is the single mutation point.** Only it performs the side effects that previously lived in `reconcile()`: GC confirmed-dead tombstones (`deleteState`, still gated on `confirmedDead`), persist stale-status / backfill corrections (`writeState`), and `cleanupOrphanBreadcrumbs()`. `status --reconcile` mirrors it for a single handle.
- **`reconcile()` split** into a pure `resolveSession` (+ shared `resolveDetail` core) and a thin mutating `reconcileSession` wrapper. `backfillStateMetadata` is now pure (mutates in memory, reports `changed`); only `reconcileSession` writes. `whoami` and all polling callers use the pure resolver.
- **App server stops implying its own session logic.** The 60s `session-reconciler` loop (`fetchAllSessionsFromCli`) now calls `yaco agent list --reconcile --all --json` — the intended background mutation point. Display reads (`/api/sessions` direct state-file reads, `queryAgentStatus`'s `list --path`) use the pure path. The app owns no GC/liveness/correction; that is the CLI's job via `--reconcile`.

**Why:**
- Closes the previous entry's "Next": making `list` fully read-only and moving dead-tombstone GC to a dedicated reconcile pass. Reads and mutation are now contract-separated so no display/polling caller can mutate state; the one background loop that *should* reconcile does so explicitly.

**Contract decision:** added `status --reconcile` (default `status` stays pure) for symmetry with `list` and to cover single-session corrections; documented in the help text and state-contract doc.

**Key files:** `cli/src/commands/agent/{status,index,whoami}.ts`, `cli/test/lifecycle-guards.test.ts`, `app/server/src/lib/agent.ts`, `app/server/src/routes/sessions.ts`, `doc/main/cli/state-contract.md`
**Verification:** `bun --cwd cli test` → 761 pass, 0 fail (added pure-read + pid-guarded-GC unit tests). CLI compiles (`bun build src/main.ts --compile`). `app/server` session-reconciler/agent/session-summary vitest suites → 35 pass; no new typecheck errors in the changed files.
**Commit:** c6becdb..HEAD
**Next:** Out of scope here but on the backlog: pin a fixed tmux socket (or add a `@yaco` session marker) so create + has-session always agree on one server.
**Blockers:** None.

## 2026-06-07: agent state-transition fixes — SessionStart hook + socket-safe GC

**What changed:**
- **SessionStart hook now fires.** The hook installer set `matcher: "yaco-agent-hook"` on lifecycle hook groups. Claude Code compiles any matcher with a non-word char as a regex and tests it against the SessionStart *source* (`startup|resume|clear|compact`), so the label matched nothing and the hook silently never ran — sessions lingered in `starting` until the slower screen-scrape fallback caught up (and `processing`→`idle` worked only because `UserPromptSubmit`/`Stop` ignore the matcher). Lifecycle hook groups now carry **no** matcher (absent = match all); yaco ownership is keyed off the hook command (`agent hook-event <Event>`). The legacy marker is still recognized so old installs migrate in place.
- **`yaco agent list` GC is socket-safe.** GC deleted state files for any session where `tmux has-session` returned not-found. tmux is socket-scoped and yaco pins no socket, so a `list` whose `$TMUX` pointed at the wrong server (the app server's 60s `session-reconciler` launched from a Warp shell) saw every live session as dead and wiped **all** state files — emptying the CLI list and the web view while 31 agents were still running. Added `isProcessAlive()` (`process.kill(pid,0)`, socket-independent) and `confirmedDead()`; deletion now requires tmux-gone **and** PID-dead. Wired into `reconcile()` and `list()`.
- Sandboxed `YACO_HOME` in the `agent-sync` / `lifecycle-guards` integration suites so real-agent tests no longer write into the live `~/.yaco/sessions` the web app reads.

**Why:**
- Both bugs presented as "agent status is wrong/delayed" for Claude and Codex. The matcher bug is a Claude-hook-semantics pitfall (a label is not a source filter); the GC bug is a latent destructive side effect of a read-shaped command that only became active once the app polled `list` every 60s and a second tmux socket (Warp) appeared. Process liveness is the authoritative, socket-independent signal.

**Key files:** `cli/src/lib/core/agent/lifecycle.ts`, `cli/src/commands/agent/status.ts`, `cli/src/lib/core/agent/tmux.ts`, `cli/test/{hooks-install,unit/agent/gc-liveness,unit/commands/install,integration/agent-lifecycle,integration/agent-sync,integration/lifecycle-guards}.ts`, `doc/main/cli/{install,state-contract}.md`
**Verification:** `bun --cwd cli test` → 755 pass, 0 fail; 6 real-session lifecycle integration tests pass (Claude `start→idle→processing→idle` in ~3s). Reproduced the GC bug and confirmed the fix: a `list` on the wrong (Warp) socket left state files 31→31 (was → 0). Restored the 31 live sessions' state files from tmux; `yaco agent list` and the web now show them.
**Commit:** a986cf0..c015b9a
**Next:** Consider making `list` fully read-only (move dead-tombstone GC to a dedicated background reconcile) and/or pinning a fixed tmux socket so create + has-session always agree.
**Blockers:** None.

## 2026-06-07: yaco skills + provider-log agent completion wait

**What changed:**
- Added a provider-neutral completion-wait path over the existing `ProviderOutput.classifyLine`/`followOutput` parser: `yaco agent wait <handle>` (explicit `--from-start` | `--cursor`+`--offset`), plus `start --wait` and `send --wait`. Success is the four-field `AgentCompletionResult` (`handle`, `provider`, `outcome: final|question`, `text`).
- `send --wait` resolves origin from real provider-log presence on disk (`ProviderOutput.logExists`), not session-id state; dead-session drain flushes a complete-but-unterminated trailing record before concluding `NOT_FOUND reason=ENDED_NO_FINAL`. Added `ErrCode.TIMEOUT` (exit 1). `--wait`/`--timeout-ms` are YACO-side flags, never forwarded past `--`.
- `yaco agent capture` is snapshot-only; `capture --wait` now errors and points to `yaco agent wait`. `reconcile()` stays the list/status authority.
- Skill set became `/yaco` (new router), `/yaco-task` (renamed from `update-tasks`), `/yaco-agent` (renamed from `tmusk`); no compatibility aliases. `/orchestrate`, `/double-design`, `/design`, `/update-doc` and SOTA docs moved completion language to provider-log waits; `/double-design` align mode keeps `status.txt`+nudge; `update-tasks.py` script provenance and history docs left intact. `doc/main/app/security.md` now names the `yaco task` store lock (`saveTaskStore`) as the task-write serializer.

**Why:**
- Completion waits should return the model's structured final message, sourced from provider logs (consistent with app/server streaming), not tmux pane text. The skills become operation manuals for the locked `yaco` CLI/core contract.

**Key files:** `cli/src/commands/agent/{wait,index,capture,send,status,output}.ts`, `cli/src/lib/core/agent/providers/{output,types}.ts`, `cli/src/lib/core/errors.ts`, `cli/test/**`, `agent-config/global/skills/{yaco,yaco-task,yaco-agent,orchestrate,double-design,design,update-doc}/`, `doc/main/cli/{architecture,lifecycle,providers,task}.md`, `doc/main/{agent-config/architecture,app/security}.md`, `doc/dev/agent-config/workflow.md`, `plan/all/yaco-skills-completion/implementation_summary.md`
**Verification:** `bun --cwd cli test` → 738 pass, 0 fail. Three Codex review rounds on the wait path (EOF-no-newline final flush, `send --wait` stale-cursor fallback, post-`--` flag leakage), each with regression tests. Acceptance `rg` for retired skill names / `capture --wait` across live skills + SOTA docs is empty.
**Commit:** aebb1bb..HEAD
**Next:** `acw-claude-pending-origin-hardening` (backlog) — harden `resolveSendWaitOrigin` for pending Claude sessions with a pre-existing UUID-named log.
**Blockers:** None.

## 2026-06-06: yaco CLI surface contract drift cleanup

**What changed:**
- `yaco agent status <name> --json` now exits non-zero with a `NOT_FOUND` error envelope when the session is absent or dead, instead of `{ok:true,data:{error:"not found"}}`. Text mode throws `NOT_FOUND` too.
- `yaco agent list --all --path <p>` now exits non-zero with `USAGE` — `--all` and `--path` are mutually exclusive rather than silently letting `--path` win.
- `yaco project add <name> <abs-path> --json` returns `{project, projectsFile}`; `yaco project remove <name> --json` returns `{removed:true, project, projectsFile}`.
- Design/doc alignment in `plan/all/yaco-cli-surface/final/design.md`: `AgentSessionRow` documented as the actual flat v1 row (`name`, `provider`, `status`, `project`, `projectPath`, `sessionPath`, `sessionId`, `pid`, optional lineage) rather than a `RuntimeSessionState & …` spread; `POST /api/tasks/:project/:taskId/agents` marked future/conditional (not v1); app project POST/DELETE documented as preferring the shared registry core helpers (no requirement to shell out to `yaco project`).

**Why:**
- Close low-risk drift between the locked `yaco-cli-surface` design and the shipped implementation without reopening the workstream. The four surfaces now match the documented envelope/exit contracts, and the design reflects what v1 actually ships.

**Key files:** `cli/src/commands/agent/{status,index}.ts`, `cli/src/commands/project/{add,remove}.ts`, `cli/test/agent-json-surfaces.test.ts`, `cli/test/unit/commands/project/registry.test.ts`, `plan/all/yaco-cli-surface/final/design.md`, `doc/main/cli/{state-contract,paths}.md`
**Verification:** `cd cli && bun test test/agent-json-surfaces.test.ts test/unit/commands/project/registry.test.ts` → 33 pass; full `bun run test` → 706 pass; direct CLI smoke confirmed all four envelopes/exit codes; `yaco task validate --id yaco-cli-surface --json` → ok.
**Blockers:** None.

## 2026-06-07: yaco project list/add/remove shared registry surface

**What changed:**
- Added `yaco project list/add/remove` on top of the shared project registry core. `list --json` returns `{projects, projectsFile}`; `add` validates URL-safe names, absolute existing directories, duplicate names, and duplicate canonical paths; `remove` deletes by name and returns `NOT_FOUND` when missing.
- `addProject()` now stores canonical paths (`resolve()` plus `realpath` when available), rejects bare `.`/`..`, rejects leading/trailing whitespace instead of trimming, and defensively rejects non-string name/path inputs with `INVALID`.
- Move-only flags (`--prefix`, `--dry-run`, `--force`) are rejected by list/add/remove and do not mutate state.
- App project POST/DELETE delegate to shared `addProject`/`removeProject`; reorder stays app-owned and writes through the shared registry writer.
- Added `plan/all/yaco-cli-surface/final/design.md` and `implementation_summary.md` for the workstream.

**Why:**
- Project registry behavior should not diverge between app and CLI. Keeping validation and duplicate rules in `@yaco/cli/core/paths` gives humans, agents, and app routes the same contract without extracting a separate SDK package.

**Key files:** `cli/src/commands/project/{index,add,list,remove}.ts`, `cli/src/lib/core/paths/{project-registry,index}.ts`, `app/server/src/lib/projects.ts`, `app/server/src/routes/projects.ts`, `cli/test/unit/commands/project/registry.test.ts`, `app/server/src/lib/__tests__/projects.test.ts`, `doc/main/cli/paths.md`, `doc/main/app/backend/libs.md`, `plan/all/yaco-cli-surface/`
**Verification:** `cd cli && bun test test/unit/commands/project/registry.test.ts test/unit/commands/project/move.test.ts test/unit/core/paths/project-registry.test.ts` → 46 pass; `cd app/server && npm test -- --run src/lib/__tests__/projects.test.ts` → 15 pass; direct CLI smoke covered list envelope, add success, canonical duplicate `CONFLICT`, missing remove `NOT_FOUND`, and remove success.
**Commit:** branch `task/yaco-cli-surface`
**Next:** `ycs-verification` bundle-wide validation.
**Blockers:** None.

## 2026-06-06: yaco agent list/status split + shared session projection

**What changed:**
- Split the overloaded `yaco agent status` collection mode into a dedicated `yaco agent list [--all] [--path <p>] [--json]`. `yaco agent status <name>` is now single-session only and **requires** a handle — no-arg `status` exits non-zero (`USAGE`).
- `yaco agent list` returns an array of `AgentSessionRow`: session fields keyed as `name`, plus the resolved `project`/`projectPath` (longest-prefix match against the project registry; basename fallback for unregistered paths). Text mode renders a `name  status  project` table.
- New pure `toSessionRow` projection in `cli/src/lib/core/agent/projection.ts`, exported via the new `@yaco/cli/core/agent` barrel. `reconcile` stays CLI-only (not exported). The app server's hot state-file reads (`readSessionsFromStateFiles`/`readAllSessionsFromStateFiles`) now use the shared projection so app and CLI agree on the row shape without pulling reconcile into the hot path.
- App adopters switched off the retired collection mode: `fetchAllSessionsFromCli` → `yaco agent list --all --json`, `queryAgentStatus` → `yaco agent list --path <cwd> --json`.

**Why:**
- `list` is the conventional verb for multi-session output; overloading `status` for both single inspection and collection was ambiguous and blocked adding a project column. Sharing one pure projection removes app/CLI drift in how a state file becomes a display row, while keeping liveness/GC (`reconcile`) out of the app's hot read path.

**Key files:** `cli/src/lib/core/agent/{projection,index}.ts` (new), `cli/src/commands/agent/{status,index}.ts`, `cli/package.json`, `app/server/src/lib/agent.ts`, `app/server/src/routes/sessions.ts`, `cli/test/unit/core/agent/projection.test.ts` (new), `cli/test/agent-json-surfaces.test.ts`, `cli/test/integration/tmux-path-scope.integration.ts`, `app/server/src/lib/__tests__/agent.test.ts`, `doc/main/cli/{state-contract,architecture}.md`, `doc/main/app/backend/libs.md`, `doc/dev/cli/workflow.md`
**Verification:** `cd cli && bun run test:unit` → 697 pass; CLI typecheck clean (only 4 pre-existing unrelated errors). App server: workspace symlink resolves `@yaco/cli` to the main repo's cli (lacks the not-yet-merged export), so app tests were proven via a throwaway vitest alias pointing at the worktree cli → all 420 app/server tests pass (config removed after). `ycs-verification` re-runs post-merge.
**Commit:** (pending)
**Next:** sibling tasks `ycs-project-commands` + `ycs-verification` in the same `yaco-cli-surface` worktree.
**Blockers:** None — app-test resolution is a worktree/workspace constraint, resolved by merge.

## 2026-06-06: Task workspace — width-gated Gantt, zoom removed

**What changed:**
- Gantt availability is now gated on viewport width (`useIsWideViewport`, ≥768px) instead of platform — a landscape phone qualifies, a portrait one does not. Both `TaskGraphScreen` (`isGantt`) and the toolbar's layout switch use it.
- Removed the zoom controls entirely (the `−`/`%`/`+`/fit toolbar buttons and the `+`/`-`/`0` keyboard shortcuts). `useViewport.scale` is now a fixed `1` identity; the SVG renderers keep their (no-op) `scale` path. Stacked fits the width; Gantt scrolls horizontally — zoom added nothing.
- Removing the toolbar zoom group also moves the mobile Filter button to the left edge, fixing the filter popover overflowing the right side of the screen on narrow phones.

**Why:**
- Zoom was meaningless for the new Stacked-list + Gantt-chart modes and crowded the mobile toolbar. Platform-based gating wrongly blocked Gantt on wide landscape phones; width is the correct signal.

**Key files:** `app/ui/src/hooks/useIsMobile.ts`, `app/ui/src/tasks/{TaskGraphScreen.tsx,TaskGraphToolbar.tsx,useViewport.ts,useTaskGraphKeyboard.ts}`, `app/ui/tests/e2e/task-graph.spec.ts`, `doc/main/app/frontend/{components.md,hooks.md}`
**Verification:** `cd app/ui && npm run build`, `npm run lint` (0 errors), `npx playwright test tests/e2e/task-graph.spec.ts` (19 passed); browser-checked Gantt switch present at 850px / hidden at 400px, no zoom buttons, Filter popover within viewport.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-06: Session rename link integrity (`astl-session-rename-link-integrity`)

**What changed:**
- `yaco agent rename` now re-points handle references after the authoritative session-state/tmux rename, best-effort: `rewriteChildParentSessions(old, new)` rewrites live child sessions' `parentSession`, and `rewriteTaskAgentHandle(tasksPath, old, new)` rewrites task `agents` links under the tasks-file lock (order-preserving, deduped, per-source-file patch). The task store is resolved from the renamed session's `sessionPath` via new `resolveTasksPathForSessionPath()`, which walks up to the nearest project root (first ancestor with `yaco.toml` or `plan/tasks`, so worktree/subdir paths resolve) and honors `yaco.toml [paths].tasks`.
- `rename()` became async and returns `{ childSessions, tasks, warnings }`; a skipped/failed rewrite never aborts the session rename — the cause is collected in `data.warnings` (surfaced in the `--json` envelope by the agent dispatcher). No durable alias table; `.renamed-*` breadcrumbs stay cleanup/stale-env support only.
- Fixed an adjacent Codex start race: `start()` fired the post-start `/rename <handle>` without waiting, so a follow-up rename could race the in-flight slash command. Added `waitForPostInputSettle()` — after submitting post-start inputs it waits for the TUI to drain to a stable idle prompt before returning (only runs for providers with post-start inputs, i.e. Codex). Updated the live integration assertion to the version-robust `renamed to <handle>` (Codex v0.137.0 emits "Session renamed to", older "Thread renamed to") and the repair tests' state-schema check to allow the optional lineage fields (`spawnedBy`/`parentSession`).

**Why:**
- `session-rename-link-integrity` task of the agent-session-task-links bundle: task `agents` and child `parentSession` store handles, so rename must rewrite them or links/lineage break. Review round 1 surfaced the Codex post-start rename race (second rename lost) and the stale exact-key state-schema assertions; both fixed. See `plan/all/agent-session-task-links/final/design.md`.

**Key files:** `cli/src/commands/agent/{rename.ts,index.ts,start.ts}`, `cli/src/lib/core/agent/session-state.ts`, `cli/src/lib/core/task/{link.ts,store.ts,index.ts}`, `cli/test/unit/commands/agent/rename-link-integrity.test.ts`, `cli/test/unit/core/task/rewrite-agent-handle.test.ts`, `cli/test/unit/core/agent/rewrite-child-parent-sessions.test.ts`, `cli/test/integration/agent-sync.integration.ts`, `doc/main/cli/{lifecycle.md,task.md,state-contract.md}`
**Verification:** `bun run test:unit` → 669 pass / 0 fail; targeted `bun test rename-link-integrity + rewrite-agent-handle + rewrite-child-parent-sessions + rename + start` → 57 pass; `bun test ./test/integration/agent-sync.integration.ts` (live tmux+claude+codex) → 6 pass (incl. Codex live rename + repair schema checks); `bun test ./test/integration/task/task-cli.integration.ts` → 26 pass; `bunx tsc --noEmit` → only the 4 pre-existing baseline errors (none in touched files).
**Commit:** branch `task/agent-session-task-links` (code commit owned by orchestrator)
**Next:** None — closes the rename-link-integrity task of the ASTL bundle.
**Blockers:** None.

## 2026-06-06: Workspace task↔session links — terminal jump + active-session highlight (`astl-workspace-session-task-links`)

**What changed:**
- `TaskDetailPanel` now renders an **Agents** section listing every linked session handle. A live handle (one in `liveSessionHandles`) shows a pulsing green dot and an **Open Terminal** action; the currently attached handle gets an **Attached** badge and a **Show Terminal** action (re-reveals the surface when it was hidden while the handle stayed active); a non-live handle stays visible but muted and is never auto-removed. The action calls `onOpenTerminal(handle)`.
- New pure `computeLinkedTaskIds(tasks, activeSession)` (`taskGraphSelection.ts`): the set of visible tasks whose `agents` include the active session. Threaded `TaskGraphScreen` → `TaskGraphCanvas`/`TaskGanttCanvas` → `TaskGraphRows` → `TaskGraphNode` as `linkedTaskIds`/`isLinkedToActiveSession`, rendered as a distinct **solid-green ring** — independent of selection/search/dependency highlight, adds **no graph edge**, and overrides dim so a linked node stays full-opacity under an unrelated selection. A dead handle never highlights (it can't be the active session).
- `activeSession`, `liveSessionHandles`, and `onOpenTerminal` thread `TaskScreen` ← `WorkspaceEditorColumn` / `WorkspaceScreen` for both the desktop tasks tab and the mobile tasks pane. `WorkspaceScreen` derives `liveSessionHandles` from the project session list and `handleOpenSessionTerminal` reuses the attach flow (set active session + reveal terminal surface: right panel on desktop, terminal pane on mobile), gated on liveness.
- The metadata rail already displays linked handles all-or-nothing when width allows (no title-truncation regression) — left unchanged.

**Why:**
- `workspace-session-task-links` task of the agent-session-task-links bundle: the locked single task workspace must jump from a task to a live terminal and highlight tasks linked to the active terminal, without adding graph edges or mixing with dependency/selection/search highlight state. Review round 1 (Medium) widened the terminal action to active handles so a hidden-but-attached surface can be reopened. See `plan/all/agent-session-task-links/final/design.md`.

**Key files:** `app/ui/src/tasks/{taskGraphSelection.ts,TaskGraphNode.tsx,TaskGraphRows.tsx,TaskGraphCanvas.tsx,TaskGanttCanvas.tsx,TaskGraphScreen.tsx,TaskScreen.tsx,TaskDetailPanel.tsx,taskGraphModel.test.ts}`, `app/ui/src/workspace/{WorkspaceEditorColumn.tsx,WorkspaceScreen.tsx}`, `doc/main/app/frontend/components.md`
**Verification:** `cd app/ui && npx vitest run src/tasks src/workspace` → 7 files / 96 pass (incl. new `computeLinkedTaskIds` cases); `npx tsc --noEmit` exit 0; `npm run lint` exit 0 (13 pre-existing warnings, none in touched files); `npm run build` green.
**Commit:** branch `task/agent-session-task-links` (code commit owned by orchestrator)
**Next:** None — closes the workspace UI task of the ASTL bundle.
**Blockers:** None.

## 2026-06-06: Task↔agent link delta mutation + orchestrate writer migration (`astl-task-agent-link-mutation`)

**What changed:**
- New `cli/src/lib/core/task/link.ts`: `mutateTaskAgentLink({tasksPath, taskId, sessionHandle, op})` — the locked attach/detach delta on `task.agents`, plus the pure `applyAgentLink(current, handle, op)`. Attach appends only if missing, detach removes only if present (both idempotent), and the last detach deletes the `agents` key. Liveness is not required. Exported through the `core/task` barrel.
- New CLI surface `yaco task attach|detach <id> <session-handle>` (`cli/src/commands/task/link.ts`, wired in `commands/task/index.ts`). Returns `{taskId, agents, op, tasksPath}`.
- `cli/src/commands/task/set.ts` now rejects any payload carrying `agent` **or** `agents` (`INVALID`) — closing the last non-delta writer so a stale full-array `set` can't clobber concurrently-attached handles.
- The link write patches only the target task's raw record in its own source file (resolve via store, write via `loadTasks`/`saveTasks`) instead of re-saving the normalized store, so load-time `workset` defaulting / sibling `agent`→`agents` upgrades never leak to disk on unrelated fields or file-mates.
- `agent-config/global/skills/orchestrate/SKILL.md`: dispatch sets `state:running` via `yaco task set`, then links the worker with `yaco task attach <id> w-<id>`; the legacy `{"agent":"w-..."}` payload is gone.

**Why:**
- `task-agent-link-mutation-and-writer-migration` task of the agent-session-task-links bundle. A delta + lock is required because a full-array overwrite loses concurrent links; review round 1 added the `set` agents rejection (High 1) and the patch-only-`agents` write to stop synthesized `workset` reaching disk (High 2). No app-server route in v1 — the UI only displays links. See `plan/all/agent-session-task-links/final/design.md`.

**Key files:** `cli/src/lib/core/task/{link.ts,index.ts}`, `cli/src/commands/task/{link.ts,index.ts,set.ts}`, `cli/test/unit/core/task/link.test.ts`, `cli/test/integration/task/task-cli.integration.ts`, `agent-config/global/skills/orchestrate/SKILL.md`, `doc/main/cli/task.md`
**Verification:** `bun --cwd cli test test/unit/core/task test/integration/task` → 651 pass, 0 fail; `bun test test/unit` (from `cli/`) → 390 pass, 0 fail. Confirmed `app/server` task route forwards no `agents` field, so the `set` rejection breaks nothing.
**Commit:** branch `task/agent-session-task-links` (code commit owned by orchestrator)
**Next:** `session-rename-link-integrity` — rewrite task `agents` references on `yaco agent rename`.
**Blockers:** `agent-config/global/skills/update-tasks/SKILL.md:152` still shows a legacy `{"state":"running","agent":...}` `task set` example (out of this task's scope) that would now be rejected — fix in a follow-up so the example stops teaching a rejected payload.

## 2026-06-06: Session list parent/child lineage rendering (`session-lineage-ui`)

**What changed:**
- UI `AgentSession` type gains optional `spawnedBy`/`parentSession` (`app/ui/src/types.ts`); the `/api/sessions` surface already forwarded them.
- New pure, tested `app/ui/src/workspace/sessionLineage.ts`: `buildSessionLineage(sessions)` flattens an ordered list into depth-annotated `{ session, depth }` rows (parent immediately followed by visible descendants, input order preserved, roots = no/absent/self parent, cycle-guarded). `groupSessionLineage(sessions, isPinned)` builds lineage over the **full** visible list then buckets each root-anchored subtree into the existing pinned/processing/idle tiers by its root.
- `useWorkspaceSessionSection.tsx` renders from `groupSessionLineage(orderedSessions, …)` instead of per-tier filtering, so a parent and its differently-statused/pinned descendants stay contiguous and indented; pin state is derived per row. `SessionItem` gains a `depth` prop → `paddingLeft = 8 + depth*14`.
- Existing affordances unchanged: click-attach, rename, kill, pin/drag-reorder, unread badge, provider/status dots, shortcut index, dividers.

**Why:**
- `session-lineage-ui` task of the agent-session-task-links bundle: surface live agent spawn lineage in the session list as indentation, derived only from `parentSession` (no persisted `childSessions`, no new tree store). Building lineage over the full list (not per tier) was the review fix — per-bucket lineage orphaned a child whose status/pin differed from its visible parent. See `plan/all/agent-session-task-links/final/design.md`.

**Key files:** `app/ui/src/types.ts`, `app/ui/src/workspace/{sessionLineage.ts,useWorkspaceSessionSection.tsx,WorkspaceSessionList.tsx}`, `app/ui/src/workspace/__tests__/sessionLineage.test.ts`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/ui && npx vitest run src/workspace` (5 files, 31 pass incl. 13 lineage cases); `npx tsc --noEmit` exit 0; `npm run lint` exit 0 (pre-existing warnings only); `cd app/server && npm test` (412 pass).
**Commit:** branch `task/agent-session-task-links` (code commit owned by orchestrator)
**Next:** `session-rename-link-integrity` — rewrite task `agents` + live child `parentSession` on `yaco agent rename` (orphaning on parent rename is deferred there, not the UI).
**Blockers:** None.

## 2026-06-06: Session lineage capture at agent start (`spawnedBy` / `parentSession`)

**What changed:**
- Extended the persisted `SessionState` with `spawnedBy?: "user:web" | "user:terminal" | "agent"` and optional `parentSession` (`cli/src/lib/core/agent/model.ts`). Optional so legacy state files load unchanged; new starts always write `spawnedBy`.
- `start()` derives lineage once before the first state write via `deriveSessionLineage()` (`cli/src/commands/agent/start.ts`): `YACO_AGENT_HANDLE` → `agent` + `parentSession`; `YACO_AGENT_SPAWNED_BY=user:web` → `user:web`; else `user:terminal`. A malformed inherited handle is ignored (falls through), not fatal.
- Wrapper (`cli/scripts/agent-wrapper.sh`) exports `YACO_AGENT_HANDLE="$sn"` for the provider process and `unset`s the one-shot `YACO_AGENT_SPAWNED_BY` web marker so it can't leak into child sessions.
- Stale renamed-parent handles are normalized through the `.renamed-*` breadcrumb chain via new `resolveRenamedHandle()` (cycle-safe, live-file-wins). Fixed `renameState()` to be chain-safe: incoming breadcrumbs are re-pointed to the new handle *before* any cleanup, so `a→b→c` leaves both `.renamed-a` and `.renamed-b` pointing at `c` (previously the incoming crumb was deleted first, breaking the chain).
- App server (`app/server/src/lib/agent.ts`): `AgentSessionState`/`AgentSession` carry the lineage fields; `toAgentSession` passes them through best-effort (validates `spawnedBy`, drops unknown values, omits when absent); `startAgentSession` spawns the CLI with `YACO_AGENT_SPAWNED_BY=user:web`. The `/api/sessions` list surface forwards them unchanged.

**Why:**
- `session-lineage-start` task of the agent-session-task-links bundle: agent sessions need an explicit spawn source and parent link so the session list can render parent/child nesting and the workspace can reason about who launched whom. Explicit-first (`YACO_AGENT_HANDLE`) over ambient inference; breadcrumbs only normalize a stale env handle, they are not the durable model. See `plan/all/agent-session-task-links/final/design.md`.

**Key files:** `cli/src/lib/core/agent/{model,session-state}.ts`, `cli/src/commands/agent/start.ts`, `cli/scripts/agent-wrapper.sh`, `app/server/src/lib/agent.ts`, `cli/test/unit/{core/agent/resolve-renamed-handle,commands/agent/lineage}.test.ts`, `cli/test/agent-wrapper.test.ts`, `app/server/src/lib/__tests__/agent.test.ts`, `doc/main/cli/{state-contract,architecture,lifecycle}.md`, `doc/main/app/data-model/types.md`
**Verification:** `bun --cwd cli test test/unit/core/agent test/unit/commands/agent test/agent-wrapper.test.ts` (28 pass, 0 fail); `cd app/server && npm test` (412 pass); `bunx tsc --noEmit` no new errors in touched files (pre-existing `session-id.ts` errors only).
**Commit:** branch `task/agent-session-task-links` (code commit owned by orchestrator)
**Next:** `session-rename-link-integrity` — rewrite task `agents` + live child `parentSession` on rename; `session-lineage-ui` — render parent/child cascade in the session list.
**Blockers:** None.

## 2026-06-06: Task agents link schema (`agent` → `agents[]`)

**What changed:**
- Canonical task field `agent?: string | null` replaced by `agents?: string[]` (YACO session-handle links) across CLI core (`cli/src/lib/core/task/{model,store,validation}.ts`) and the two UI task normalizers (`app/ui/src/tasks/{taskGraphModel.ts,model/taskModel.ts}`).
- Load-time normalization upgrades legacy `agent` → `agents`: trims, drops empties, dedupes order-preserving, and lets an explicit `agents` array — even empty — win over a stale scalar `agent`; save omits `agent`.
- Validation now rejects an incoming `agent` payload outright and validates each `agents` handle against `AGENT_HANDLE_RE` `/^[a-zA-Z0-9_-]+$/` on the raw string (leading/trailing whitespace rejected, not silently trimmed).
- Mechanical UI ripple so the rename stays coherent (rail/tooltip/detail read `agents`); full multi-handle display/jump/highlight UX stays for the `workspace-session-task-links` task.

**Why:**
- First task of the agent-session-task-links bundle: a task needs durable links to every session handle that worked on it, not a single scalar. `agents[]` is deduped/order-preserving and avoids the role/status/timestamp sync bugs a relation object would carry. See `plan/all/agent-session-task-links/final/design.md`.

**Key files:** `cli/src/lib/core/task/{model,store,validation}.ts`, `cli/test/unit/core/task/{validation,store}.test.ts`, `app/ui/src/tasks/{taskGraphModel.ts,taskGraphModel.test.ts,model/taskModel.ts,metadataRail.ts,TaskGraphTooltip.tsx,TaskDetailPanel.tsx}`, `doc/main/cli/task.md`, `doc/main/app/frontend/components.md`
**Verification:** `bun --cwd cli test test/unit/core/task` (640 pass, 0 fail), `npx vitest run src/tasks/taskGraphModel.test.ts` (30 passed), `cd app/ui && npm run lint` (exit 0).
**Commit:** branch `task/agent-session-task-links` (code commit owned by orchestrator)
**Next:** `task-agent-link-mutation-and-writer-migration` — locked attach/detach delta mutation + migrate `orchestrate/SKILL.md` off legacy `agent` writes (which now fail validation).
**Blockers:** None.

## 2026-06-06: Pseudo-Gantt task workspace mode

**What changed:**
- Added a second task workspace layout, **Pseudo-Gantt**, beside Stacked (replaces the dropped DAG mode). Toolbar toggle, persisted, desktop-only.
- `ganttSchedule.ts` — pure CPM schedule over the filter-visible leaf set: duration map `xs/s/m/l/xl=1/2/3/5/8` (missing→`m`, `assumed`), effective-predecessor graph with on-`E` cycle detection, forward/backward passes for integer-exact `slack`/`critical`, group summaries.
- `computeGanttLayout` returns `GanttLayout extends GraphLayout` (bars + ruler + `leftWidth`/`timeWidth`); `TaskGanttCanvas` renders a two-pane sticky spreadsheet (frozen left column + sticky ruler + horizontally-scrollable time pane), one `scale()` per pane.
- Extracted `TaskGraphRows` so the Gantt left column reuses the **exact** stacked row renderer — identical cards, indent guides, and Backlog/Archive section dividers.
- Resizable pane divider (app `VResizeHandle` style) in a margined gutter; width persists via `ganttLeftWidth`, clamped to the depth-derived auto floor so cards never clip.
- Bars: state colors, assumed-estimate hatch, critical-path outline, distinct summary bars, effective-cycle bars red; selection emphasizes upstream/downstream + critical chain.

**Why:**
- Gantt answers what DAG was meant to (what unlocks what, critical path, parallelism) but adds scale via estimate-weighted bars on a synthetic optimistic-unit axis. Sharing the stacked renderer keeps the two modes' left columns pixel-identical and avoids a second row-layout code path.

**Key files:** `app/ui/src/tasks/{ganttSchedule.ts,taskGraphModel.ts,TaskGraphRows.tsx,TaskGanttCanvas.tsx,TaskGanttRuler.tsx,TaskGanttBar.tsx,TaskGraphCanvas.tsx,TaskGraphScreen.tsx,useTaskGraphInteraction.ts}`, `doc/main/app/frontend/components.md`
**Verification:** `cd app/ui && npm run build`, `npm run lint` (0 errors), `npx vitest run src/tasks` (59 passed), and the `task-graph.spec.ts` Playwright suite (20 passed, incl. mode switch/persist, frozen column+ruler, zoom no-drift, assumed hatch, only-real-`depends` edges, shared section dividers, divider resize+persist) all pass.
**Commit:** d99887d..ba72cd4
**Next:** None.
**Blockers:** None.

## 2026-06-06: Task graph workset reads, ranking, and section dividers

**What changed:**
- `yaco task list` now accepts `--workset active|backlog|archive|all`; the default remains active for orchestrator-style reads, while app/server uses `--workset all`.
- `GET /api/tasks/:project` now consumes the canonical CLI envelope (`yaco task list --workset all --json`) instead of reading `plan/tasks/**` directly, keeping task-store ownership inside the CLI.
- The stacked task graph ranks same-level nodes by workset (`active -> backlog -> archive`), removes per-row workset badges from the metadata rail, and renders subtle `Backlog` / `Archive` section dividers for visible non-active root groups.
- Docs and tests now cover the CLI workset selector, server CLI boundary, metadata rail behavior, and workset ordering.

**Why:**
- The UI could not show backlog/archive tasks through the correct boundary because the CLI list surface only exposed active tasks. Direct server reads were the wrong ownership split, and per-row workset badges were noisy once backlog/archive are grouped visually.

**Key files:** `cli/src/commands/task/{index.ts,list.ts}`, `app/server/src/routes/tasks.ts`, `app/ui/src/tasks/{taskGraphModel.ts,TaskGraphCanvas.tsx,metadataRail.ts}`, `doc/main/{cli/task.md,app/backend/routes.md,app/frontend/components.md}`
**Verification:** `cd cli && bun test ./test/integration/task/task-cli.integration.ts` passed; `cd app/server && npx vitest run src/routes/__tests__/tasks-cli.test.ts src/routes/__tests__/tasks-worktree.test.ts` passed; `cd app/ui && npx vitest run src/tasks/taskGraphModel.test.ts`, `npm run lint`, `npm run build`, and targeted Playwright workset tests passed; live `/api/tasks/yaco` returns active, backlog, and archive tasks.
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-06: Task detail overlay and click-to-toggle behavior

**What changed:**
- `TaskScreen` now separates graph selection (`selectedTaskId`) from detail overlay state (`openTaskId`). Selecting a task no longer automatically opens details.
- Desktop `TaskDetailPanel` is an absolute right-side overlay with a draggable left edge, so it no longer shares flex width with or compresses `TaskGraphScreen`.
- Task clicks are now a toggle sequence: first click selects, clicking the selected task opens details, clicking the same open task closes details, and double-click opens directly. Search/keyboard navigation still selects and scrolls without opening details.
- E2E coverage now asserts select/open/close toggle behavior, overlay resizing, and search selection without auto-opening; the worktree metadata test opens details via double-click.

**Why:**
- User-reported responsive bug: the old sidebar shared width with the graph and could leave the task pane stuck halfway on narrow widths. Opening details on first click also made simple selection too heavy.

**Key files:** `app/ui/src/tasks/{TaskScreen.tsx, TaskGraphScreen.tsx, TaskDetailPanel.tsx, TaskGraphCanvas.tsx, TaskGraphNode.tsx, useTaskGraphInteraction.ts}`, `app/ui/tests/e2e/{task-graph.spec.ts,worktree.spec.ts}`, `doc/main/app/frontend/components.md`
**Verification:** `cd app/ui && npm run lint` passed (0 errors / existing warnings); `cd app/ui && npm run build` passed; targeted Playwright `task-graph.spec.ts -g "node click selects|detail panel overlays|search highlights"` passed (3/3).
**Commit:** this commit
**Next:** None.
**Blockers:** None.

## 2026-06-06: Task workspace — direct/transitive selection tiers + tighter margins

**What changed:**
- **Selection emphasis tiers** (`taskGraphSelection.ts`, `TaskGraphNode.tsx`, `TaskGraphEdges.tsx`): selecting a leaf task used to highlight its entire transitive ancestor/descendant closure at one flat strength, so a deep selection lit up a cluttered web of equally-bold arcs. The highlight model now also carries `directTaskIds` / `directEdgeIds` (one hop from the selection). Rendering tiers them: selected + direct neighbours stay full (node opacity 1, edge 0.95, width 2.2); transitive ancestors/descendants recede (node 0.55, edge 0.28, width 1); unrelated fades further (node 0.22, edge 0.06). Direction colors (upstream orange / downstream cyan) are unchanged; the opacity does the depth distinction. Group selection keeps its existing one-hop-boundary behavior.
- **Tighter horizontal margins** (`taskGraphModel.ts`): `GRAPH_PADDING` 16→12, `DEPENDS_GUTTER` 36→32, `ARC_OFFSET` 22→18. Left margin now 12px, right ~44px (gutter + base padding).

**Why:** user-reported — selecting a task showed all ancestors/descendants with no distinction between first-order and higher-order relationships, and the right-side dependency arcs overlapped into a messy tangle; also the panel still had more side margin than needed.

**Verification (browser-measured at 1500px):** selecting a root showed exactly its 4 direct dependents at full opacity, the 2 distance-2 tasks at 0.55, and 21 unrelated at 0.22; edges split 4 direct (0.95/2.2) · 9 transitive (0.28/1) · inactive (0.06). Left margin 12px, arcs not clipped. `tsc -b` ✓, `npm run lint` ✓ (0 errors), `npm run build` ✓, `vitest` → 13 passed.

**Key files:** `app/ui/src/tasks/{taskGraphSelection.ts, TaskGraphNode.tsx, TaskGraphEdges.tsx, taskGraphModel.ts}`

## 2026-06-06: Task workspace — tighter horizontal margins

**What changed (`app/ui/src/tasks/taskGraphModel.ts`):** reduced the stacked-layout outer padding and right gutter so cards use more of the panel width. `GRAPH_PADDING` 40→16 (left/right base padding), `DEPENDS_GUTTER` 56→36 (right-side arc gutter), `ARC_OFFSET` 24→22. Net: left margin 40→16px; right margin 96→~52px (36px functional arc gutter + 16px base padding symmetric with the left).

**Why:** user-reported excessive whitespace on both sides — cards started 40px in on the left and ended ~96px before the right edge, most of it empty.

**Verification (browser-measured at 1500px):** left card margin 16px; dependency arcs bow ~21–28px into the 36px gutter and are not clipped (43 edges checked); right space is now the arc gutter rather than dead margin. `npm run build` ✓, `tsc -b` ✓, `npm run lint` ✓ (0 errors), `vitest` → 13 passed.

**Key files:** `app/ui/src/tasks/taskGraphModel.ts`

## 2026-06-06: Task node — title takes priority over metadata rail on narrow rows

**What changed (`app/ui/src/tasks/TaskGraphNode.tsx`, `metadataRail.ts`, `taskGraphModel.test.ts`):**
- The metadata rail is now gated on the **full title fitting**. `TaskGraphNode` measures the title's rendered width (cached canvas `measureText` with the app's 13px title font) and only offers `buildRail` the space left **after** the full title; if the title cannot fully fit, the rail yields entirely and the title gets the whole row. Replaces the previous fixed `RAIL_MIN_TITLE` reservation.
- Tags are now **all-or-nothing**: `buildRail` shows a badge in full or drops it — the width-fitted/ellipsis id fallback is gone (`fitText`, `RAIL_MIN_TITLE`, `RAIL_MIN_BADGE` removed). A clipped title beats a clipped title + a clipped tag.
- Net effect (browser-verified at 1700/560/400px): wide rows show full titles plus tags in the leftover and titles are never clipped while tags show; medium rows drop the tags when title+tag won't both fit; mobile/portrait shows **no tags at all**, every title taking the full card width.
- Unit tests updated: the truncation test replaced with an all-or-nothing assertion (a badge that can't fully fit is dropped, not truncated). 13 pass.

**Why:** user-reported — on mobile portrait the id/priority tags crowded a title that itself couldn't fully show; neither read well. Title must win; tags only fill genuine leftover.

**Implementation note:** canvas `measureText` overestimates the rendered title by ~2–3px (no letter-spacing applied), which biases toward hiding the rail — the title-first direction we want.

**Verification:** `npm run build` ✓, `tsc -b` ✓, `npm run lint` ✓ (0 errors), `vitest taskGraphModel.test.ts` → 13 passed, plus live DOM measurement at three viewports.

**Key files:** `app/ui/src/tasks/{TaskGraphNode.tsx, metadataRail.ts, taskGraphModel.test.ts}`

## 2026-06-06: Task node metadata-rail polish (margins, order, alignment, mobile, size)

**What changed (`app/ui/src/tasks/metadataRail.ts`, `TaskGraphNode.tsx`, `taskGraphModel.test.ts`):**
- **Uniform badges:** every rail badge now renders with identical geometry and monospace typography (same padding, same letterSpacing); only color differs per field. The old mix of mono `id` (tight) vs proportional `agent` (loose) left visibly unequal inner margins — now id and agent measure ~5px symmetric padding on both sides.
- **Order** is now `id → agent → priority → workset` (was id → priority → workset → agent).
- **Right alignment:** the right-number column width is always reserved (constant 32px) even when a row has no count, so every row's rail ends at the same right edge (browser-verified: all rows align to one x).
- **Mobile/title priority:** `RAIL_MIN_TITLE` raised to 150px so the title keeps a readable chunk before the rail claims space; on narrow cards the rail sheds priority/agent and collapses to a width-fitted id (browser-verified: title holds ~150px on 280px cards, badges no longer cover the title).
- **Bigger rail font:** badge text 9→10.5px, with the mono char-width constant recalibrated (5.4→6.3) so width math stays accurate; badge height 16→18 to fit.
- Unit tests updated for the new order and recalibrated widths (13 pass).

**Why:** user-reported polish — agent badge had wider inner margins than id; tags weren't right-aligned when some rows lacked a count; on mobile the id/priority badges crowded the title; tag font felt small; requested order id-agent-priority.

**Verification:** `npm run build` ✓, `tsc -b`/`tsc --noEmit` ✓, `npm run lint` ✓ (0 errors), `vitest taskGraphModel.test.ts` → 13 passed, plus live browser measurement at 1920px and 420px viewports.

**Key files:** `app/ui/src/tasks/{metadataRail.ts, TaskGraphNode.tsx, taskGraphModel.test.ts}`

## 2026-06-06: Task node metadata-rail readability fixes

**What changed:**
- `app/ui/src/tasks/metadataRail.ts`: the rail id/agent badges are now **width-driven** instead of hard-capped (id at 16 chars, agent at 12). Every badge shows its full text when it fits the rail's reserved band, so wide rows no longer show a fixed-width `id…` with empty space beside it. Truncation (with ellipsis) happens only when the id is wider than the available space; below a small minimum (`RAIL_MIN_BADGE`) the rail hides rather than show an unreadable stub.
- `app/ui/src/tasks/TaskGraphNode.tsx`: lighter font weights for readability — title 500→400, estimate 700→600, progress/dep-count labels 500→400, rail badge text 600→500. Hierarchy preserved via size/color, not heavy weights.
- Unit tests (`taskGraphModel.test.ts`, +2): a long id renders in full on a wide row (no ellipsis, still right-aligned), width-fits with an ellipsis only when it cannot fit, and the rail hides when too narrow for a readable stub. Existing drop-order coverage unchanged.

**Why:**
- User-reported: right-side metadata tags were fixed-width and truncated with `…` even on wide rows with large empty middles; and node text was uniformly heavy, hurting readability.

**Verification:** `npm run build` ✓, `npx tsc --noEmit` ✓, `npm run lint` ✓ (0 errors), `vitest taskGraphModel.test.ts` → 13 passed.

**Key files:** `app/ui/src/tasks/{metadataRail.ts, TaskGraphNode.tsx, taskGraphModel.test.ts}`

## 2026-06-06: V1 task workspace verification coverage

**What changed:**
- Unit (`app/ui/src/tasks/taskGraphModel.test.ts`, vitest, 11 tests): workset filtering (default active+backlog, archive opt-in), vertical stacked roots + child indentation + width-driven rows (NODE_WIDTH floor), only-real-`depends` edges (parent/priority/state/tag create none), full-title integrity, and width-driven metadata-rail collapse asserting the **exact field prefix at every threshold** (`[id,priority,workset,agent]`→`[id,priority,workset]`→`[id,priority]`→`[id]`→`[]`).
- E2E (`tests/e2e/task-graph.spec.ts`, `workspace-tasks-tab.spec.ts`): rewritten for the single stacked workspace — task nodes, no milestone/Board/List/Archive surfaces, vertical roots sharing one left edge, edge count == depends graph, detail-panel full title, search. Archive guarantee asserted at the **node** level: an archived node is absent by default and renders after enabling the archive chip (active node visible throughout).
- E2E (`tests/e2e/worktree.spec.ts`): added a graph-path worktree-metadata test (open a worktree-bearing node → detail panel shows Worktree label, branch, Active badge), replacing the deleted board-path coverage.
- Refactor: extracted `buildRail` from `TaskGraphNode.tsx` into new `app/ui/src/tasks/metadataRail.ts` so the rail logic is unit-testable without tripping the component-only-export lint rule (no behavior change).

**Why:**
- Final V1 task (`workspace-verification`). The old `task-graph.spec.ts`/`workspace-tasks-tab.spec.ts` were stale (milestones, pan/zoom drag, removed `header`, editor-tab/doorway semantics) and the archive/rail coverage was false-green — chip toggles and rail endpoints were checked, but never node-level archive rendering or intermediate rail prefixes, so a mid-order regression would pass.

**Key files:** `app/ui/src/tasks/{taskGraphModel.test.ts, metadataRail.ts, TaskGraphNode.tsx}`, `app/ui/tests/e2e/{task-graph,workspace-tasks-tab,worktree}.spec.ts`
**Verification:** `npx vitest run src/tasks/taskGraphModel.test.ts` → 11 passed; targeted e2e (task-graph + workspace-tasks-tab + worktree graph-path) → 11 passed against the worktree server (all-worksets data, since the shared dev server on :3001 is a stale build that still filters to active-only); `npm run lint` → 0 errors / 13 existing warnings.
**Commit:** b4d1955, f276f83
**Next:** `dag-layout-mode` (phase 2).
**Blockers:** None.

## 2026-06-06: Remove legacy Board/List/Archive task surfaces and dead code

**What changed:**
- Deleted the multi-view task UI now that the Tasks screen is a single graph workspace: `TaskToolbar`, `board/**`, `list/**`, `archive/TaskArchiveView.tsx`, `archive/useArchiveData.ts` (18 files; empty `board/`+`list/` dirs removed).
- Evidence-based dead-code sweep — all 7 named candidates lost their last importer and were deleted: `TaskGraphDetailPanel.tsx`, `shared/StateBadge.tsx`, `shared/PriorityTag.tsx`, `hooks/{useTaskBoard,useTaskList,useColumnWidths,useTaskViewState}.ts`. Kept (still imported): `shared/StateDot`, `shared/InlineEdit`, `model/taskModel`, `archive/archiveTask.ts`.
- Server: removed the dead `GET /:project/archive` read route (only consumers were the deleted `useArchiveData`/Archive panel); `POST /:project/:taskId/archive` action untouched.
- Tests: replaced the `GET /archive` server test with a workset-filter test asserting `GET /:project` returns all worksets; removed 5 dead Board/List/Graph view-switch e2e tests from `worktree.spec.ts`.
- Docs: `frontend/components.md` (dropped the "pending deletion" legacy block + `useTaskViewState` line), `backend/routes.md` (removed GET /archive row, GET /:project now documented as returning all worksets).

**Why:**
- Subtraction follow-up to the single-workspace migration — the old surfaces were already unmounted; this removes the now-dead files, the dead archive READ path, and surface-specific tests. The archive POST action stays because the detail panel uses it. No backward-compat shim (pre-release).

**Key files:** `app/ui/src/tasks/**` (deletions), `app/server/src/routes/tasks.ts`, `app/server/src/routes/__tests__/tasks-worktree.test.ts`, `app/ui/tests/e2e/worktree.spec.ts`
**Verification:** `cd app/server && npm test` → 409 passed; `cd app/ui && npm run lint` → 0 errors / 13 existing warnings; `npx tsc --noEmit` clean; `npm run build` green.
**Commit:** bf7c69a
**Next:** `dag-layout-mode`, `workspace-verification`.
**Blockers:** None.

## 2026-06-06: Responsive width-driven metadata rail on task nodes

**What changed:**
- `TaskGraphNode` renders a right-aligned metadata rail (`buildRail`) of id/priority/workset/agent badges. Visibility is computed from the actual `node.width`, not CSS breakpoints: badges are kept in priority order `id > priority > workset > agent` and dropped from the right as the row narrows (agent → workset → priority → id). The rail occupies only the band `[titleStart + 72px, rightLabel − gap]`, so it collapses before overlapping the title clip or the reserved right `depends` gutter; the title clip width is recomputed to end at the leftmost badge.
- Noise reduction: `priority === 'normal'` and `workset === 'active'` render no badge (default/common values); `id` is the always-present anchor (truncated to 16 chars, agent to 12).
- `TaskGraphTooltip` gains a full-metadata chip footer (id/priority/workset/agent/#tags) so nothing is lost when the rail collapses — added content only; the `scrollLeft/scrollTop`-based positioning math is untouched.
- `TaskDetailPanel` adds a display-only **Workset** field to the State/Priority/Estimate row (id, priority, agent, tags were already shown).

**Why:**
- Full-width stacked rows have room for metadata when wide but must not crowd the title or dependency arcs when deeply indented/narrow. A width-driven drop order keeps the rail honest at any width while the tooltip + detail panel remain the lossless source. Resolves design Open Question #3 (rail thresholds and field order).

**Key files:** `app/ui/src/tasks/{TaskGraphNode.tsx, TaskGraphTooltip.tsx, TaskDetailPanel.tsx}`
**Verification:** `cd app/ui && npm run lint` → 0 errors / 13 existing warnings; `npx tsc --noEmit` clean; `npm run build` green.
**Commit:** ea43ca8
**Next:** `remove-legacy-surfaces`, `dag-layout-mode`, `workspace-verification`.
**Blockers:** None.

## 2026-06-06: Vertical-scroll viewport for the task workspace

**What changed:**
- Replaced the SVG infinite-canvas pan/zoom with native vertical scroll. `TaskGraphCanvas` sizes the SVG to `bounds.{width,height} * scale` with a `<g transform="scale(scale)">` inside an `overflow-y-scroll overflow-x-auto` container; layout width comes from the scroll container's `clientWidth` so it fits exactly at scale 1 (no horizontal scrollbar). Pan pointer handlers dropped.
- Added `useViewport.ts` (`{ scale, didDrag, zoomIn, zoomOut, resetZoom, scrollNodeIntoView }`) and **deleted** `usePanZoom.ts` + `TaskGraphMinimap.tsx` (no remaining importers). `didDrag` is an always-false ref kept only for `useTaskGraphInteraction`'s click-vs-drag guard.
- Search submit and keyboard navigation (Tab/arrows/Home/End) scroll the target node to vertical center via `viewport.scrollNodeIntoView`. Keyboard `0` maps to `resetZoom`; `+/-/=` zoom.
- `TaskGraphTooltip` positions from `scale` + the scroll container's `scrollLeft/scrollTop`; cleared on scroll and on zoom so it never strands. Selection lives inside the scaled `<g>`, so it tracks scroll/zoom automatically.

**Why:**
- The stacked layout is width-fit, so horizontal pan had nothing to navigate to and fought the layout; a minimap only makes sense for an infinite canvas. Native scroll is smaller in surface and more robust (browser handles wheel/trackpad/touch/momentum). Decision per design Open Question #1: delete rather than constrain, since all pan/zoom/minimap importers were in scope.

**Key files:** `app/ui/src/tasks/{useViewport.ts (new), TaskGraphScreen.tsx, TaskGraphCanvas.tsx, TaskGraphTooltip.tsx, useTaskGraphKeyboard.ts}`; deleted `app/ui/src/hooks/usePanZoom.ts`, `app/ui/src/tasks/TaskGraphMinimap.tsx`
**Verification:** `cd app/ui && npx tsc --noEmit` clean; `npm run lint` → 0 errors / 13 existing warnings; `npm run build` green.
**Commit:** 91885b5
**Next:** `metadata-rail`, `remove-legacy-surfaces`, `dag-layout-mode`, `workspace-verification`.
**Blockers:** None.

## 2026-06-06: Single task workspace shell + workset filter

**What changed:**
- `TaskScreen` is now one workspace shell: it renders only `TaskGraphScreen` + `TaskDetailPanel` (holds a local `selectedTaskId`, loads `useTaskData` just for the detail-panel map) and no longer switches Board/List/Graph/Archive panes. The graph's `TaskGraphToolbar` is the only toolbar.
- `useTaskGraphInteraction` becomes the workspace-state owner: `layout` (`'stacked' | 'dag'`, default stacked) and `filters = { states, worksets }` (worksets default `{active, backlog}`). Persisted under the new key `yaco-task-workspace:${project}`; load coerces any stored layout to `stacked` while DAG is unbuilt.
- `TaskGraphToolbar` adds a layout control (Stacked active; DAG disabled until built) and workset chips (active/backlog/archive) next to the state filter + search; `/` still focuses search.
- Workset filter applied to the rendered set in `TaskGraphScreen` (drop disabled-workset tasks before `computeDisplayLayout`) — archive (~217 tasks) no longer leaks in. Stale selection cleared centrally when the selection leaves `displayLayout.nodes` (any filter), propagated via `onSelectTask(null)`.
- Old `1/2/3/4` view-switch shortcuts removed (they lived in the no-longer-mounted `TaskToolbar`). Optional priority/agent/worktree/parent filters omitted in V1.

**Why:**
- Workset is a filter, not a separate view. Collapsing the four panes into one graph workspace removes the double toolbar and the archive-leak gap, and centralizing selection-clear on the rendered layout keeps the detail panel from showing a hidden task under any filter.

**Key files:** `app/ui/src/tasks/TaskScreen.tsx`, `app/ui/src/tasks/TaskGraphToolbar.tsx`, `app/ui/src/tasks/useTaskGraphInteraction.ts`, `app/ui/src/tasks/TaskGraphScreen.tsx`
**Verification:** `cd app/ui && npm run lint` → 0 errors / 13 existing warnings; `npx tsc --noEmit` clean; `npm run build` green.
**Commit:** d94c276..89198dc
**Next:** `remove-legacy-surfaces` — delete Board/List/Archive panels, `TaskToolbar`, `useTaskViewState`, dead `GET /:project/archive` route + tests; then `viewport-scroll`.
**Blockers:** None.

## 2026-06-06: Stacked vertical full-width task graph layout

**What changed:**
- Default graph layout stacks root sections vertically (positioned by increasing `y`, separated by `ROOT_GAP`) and fills the container width instead of laying roots out in side-by-side horizontal lanes. `computeDisplayLayout` now takes a `containerWidth`; `LayoutNode.width` (`max(NODE_WIDTH, rightEdge - x)`) drives card width, with children indented to a shared right edge. `NODE_WIDTH` is now a min-width floor; `LANE_GAP` removed.
- `TaskGraphNode` renders from `node.width` instead of the `NODE_WIDTH` constant. Title stays single-line with full title on hover/detail.
- Real `depends` edges route through a reserved right-side gutter (`DEPENDS_GUTTER`): control points bow past a single **global** right edge (max `x+width` across visible nodes), endpoints anchored at each card's own right edge, so arcs never cross intervening cards/titles even when a deep row overflows under the width floor. Same/cross-lane geometry (`getRootLane`) removed. No non-dependency edges.

**Why:**
- Stacked full-width rows are the daily workspace layout (vertical scroll as primary navigation); horizontal lanes don't use available width and made cross-lane dependency curves sweep across row bodies. The global-edge bow keeps the shared-right-edge invariant honest under the `NODE_WIDTH` floor on narrow containers.

**Key files:** `app/ui/src/tasks/taskGraphModel.ts`, `app/ui/src/tasks/TaskGraphNode.tsx`, `app/ui/src/tasks/TaskGraphScreen.tsx`
**Verification:** `cd app/ui && npm run build` -> green; `cd app/ui && npm run lint` -> 0 errors / 13 existing warnings.
**Commit:** ec86969..362d196
**Next:** `viewport-scroll` — native vertical scroll / constrain pan-zoom for the stacked layout.
**Blockers:** None.

## 2026-06-06: Task read returns all worksets; graph carries display fields

**What changed:**
- `GET /api/tasks/:project` (`buildTasksResponse`) no longer filters to the active workset — it returns active, backlog, and archive tasks so the workspace can filter client-side.
- `TaskGraphTask` normalization now carries `priority`, `agent`, and `tags` (defaults `normal`/`null`/`[]`); `Priority` is centralized in `taskGraphModel` and re-exported from `taskModel`. No task storage schema change.

**Why:**
- Workset is a filter, not a server-side cut. The single Tasks workspace needs the full task map to switch between active/backlog/archive views; display fields (priority/agent) feed the workspace cards.

**Key files:** `app/server/src/routes/tasks.ts`, `app/ui/src/tasks/taskGraphModel.ts`, `app/ui/src/tasks/model/taskModel.ts`
**Verification:** `cd app/server && npm test` -> 409 pass / 0 fail; `cd app/ui && npm run lint` -> 0 errors / 13 existing warnings; `cd app/ui && npx tsc --noEmit` clean.
**Commit:** 22c35a4
**Next:** Workspace toolbar — default workset filter to active+backlog, archive hidden until enabled.
**Blockers:** None.

## 2026-06-06: CLI JSON envelopes flush before exit

**What changed:**
- Changed the main CLI dispatcher to set `process.exitCode` after rendering instead of calling `process.exit()` immediately. The hook-event fast path keeps its direct exit behavior.
- Added a spawned regression test that writes a large `yaco agent history --json` envelope and parses the complete stdout payload.

**Why:**
- `yaco agent history --json` can legitimately return a few hundred KB (still capped at 200 rows). Immediate `process.exit()` could terminate before stdout flushed, so app/server received truncated JSON and History tabs appeared empty or failed to load. This is a correctness fix, not a pagination/optimization change.

**Key files:** `cli/src/main.ts`, `cli/test/agent-json-surfaces.test.ts`
**Verification:** `cd cli && bun test test/agent-json-surfaces.test.ts` passed; `cd cli && bun test test/unit/envelope.test.ts` passed; `cd cli && bun run test:unit` -> 614 pass / 0 fail; app/server `getHistory()` smoke returned `yaco` 200 rows, `quant` 200 rows, `frontier-llms` 3 rows.
**Commit:** 28ae413
**Next:** None.
**Blockers:** None.

## 2026-06-06: Plan docs moved to all/ and task roots split by bundle

**What changed:**
- Removed root `plan/tasks/tasks.json` stores by splitting active/root tasks into bundle files such as `plan/tasks/ac-gstack-adopt/tasks.json` and `plan/tasks/tui-provider-adapters/tasks.json`; new top-level tasks now default to `plan/tasks/<id>/tasks.json`, while new child tasks inherit the parent task file.
- Migrated real plan docs from `plan/active/*` and `plan/archive/*` into `plan/all/*`; `plan/active`, `plan/backlog`, and `plan/archive` are now symlink-only views across registered project plan roots.
- Updated design/double-design/update-tasks/update-doc/office-hours skills to write real docs under `plan/all/**` and treat active/archive as symlink views.
- Updated task design references from `plan/active/**` to `plan/all/**`.

**Why:**
- `state` and `workset` are now data fields, not directory semantics. Real docs need one stable home (`plan/all/**`), while view directories stay lightweight navigation projections.

**Key files:** `plan/tasks/**/tasks.json`, `plan/all/**`, `plan/{active,archive}/**` symlinks, `agent-config/global/skills/{design,double-design,update-tasks,update-doc,office-hours}/SKILL.md`, `cli/src/lib/core/task/store.ts`
**Verification:** all registered projects passed `yaco task validate --repo <path> --json`; all `plan/{active,backlog,archive}` entries are symlinks; `cd cli && bun test ./test/integration/task/task-cli.integration.ts` -> 19 pass / 0 fail; `cd app/server && npx vitest run src/routes/__tests__/tasks-worktree.test.ts src/routes/__tests__/tasks-cli.test.ts` -> 15 pass / 0 fail; `cd app/ui && npm run lint` -> 0 errors / 13 existing warnings; `cd app/ui && npm run build` passed.
**Commit:** this commit
**Next:** None for the task/doc storage design.
**Blockers:** None.

## 2026-06-06: Archived task snapshots moved into task store

**What changed:**
- Migrated legacy archived task JSON snapshots from `plan/archive/**/*.json` into recursive task-store files under `plan/tasks/archive/**/tasks.json`.
- Added `workset: "archive"`, `archivedFrom`, and `archivedDate` metadata to migrated task records. Non-task JSON artifacts under `plan/archive` were left in place.
- Updated the task archive API grouping to use `archivedDate` before falling back to `updated` / `created`.
- Applied the same migration to registered projects with archived task snapshots (`openweb-projects`, `closepaw-projects`; symlinked projects consume those stores).

**Why:**
- Archived tasks are task data, not document-folder state. Keeping them in `plan/tasks/**/tasks.json` lets the recursive task store own all task records while `plan/archive` remains available for docs and non-task artifacts.

**Key files:** `plan/tasks/archive/**/tasks.json`, `app/server/src/routes/tasks.ts`; external repos `openweb-projects`, `closepaw-projects`
**Verification:** all registered projects passed `yaco task validate --repo <path> --json`; `cd app/server && npx vitest run src/routes/__tests__/tasks-worktree.test.ts src/routes/__tests__/tasks-cli.test.ts` -> 15 pass / 0 fail.
**Commit:** this commit
**Next:** Optional doc-bundle migration to `plan/all/**` plus `plan/{active,backlog,archive}` symlink views.
**Blockers:** None.

## 2026-06-06: TUI provider adapter boundary docs

**What changed:**
- `doc/main/cli/providers.md` gained a **Provider Adapter Model** section: the TUI-only product model (local tmux CLIs, browser attaches to the TUI, reconstruction from provider-persisted files, ACP out of scope), the typed `TuiProvider` registry under `providers/` with the flat `providers.ts` now documented as a legacy shim, a capability-responsibility table, and a **Terminal Runtime Compatibility** subsection (`TuiProvider.terminal` = headless/no-browser runtime vs. app/ui browser presentation). Rewrote the stale "Adding a Provider" steps (adapter + `providers/index.ts` registration + `app/ui/src/lib/providerUi.ts` metadata) and retired flat-`providers.ts` code-location references (assumption tables C1/C2/C8/C10/C11, X1/X2/X8, and the `-> See` link) to the per-adapter files.
- `doc/main/cli/architecture.md` gained a **CLI ↔ App Boundary** section: the CLI JSON/stream surfaces `app/server` consumes (`providers`/`history`/`summaries`/`output-cursor`/`output-follow`), the YACO-owned state files the app still reads directly, capture-vs-output-follow, app/ui owning `ProviderUiConfig` browser presentation, and the OSC runtime-vs-browser split. Fixed the component map's `providers.ts` line to show the `providers/` registry + legacy shim.
- `doc/dev/cli/workflow.md` gained a **Verifying provider adapter changes** subsection listing the per-slice `bun test` commands (contract/lifecycle, hooks/install/doctor, history/summaries/providers JSON, output-follow, project move), the full `bun run test:unit` + `tsc --noEmit` gate, and the matching `app/server` consumer suites.

**Why:**
- `tui-provider-docs` (final task of the `tui-provider-adapters` design, `plan/active/tui-provider-adapters/design_codex.md`): after the CLI adapter registry, app/server boundary, output-follow stream, provider-owned project move, and UI provider config all landed, the SOTA docs needed to describe the finalized TUI-only provider model and CLI/app/UI ownership split, and to retire the stale flat-`providers.ts` references the implementation left behind.

**Key files:** `doc/main/cli/providers.md`, `doc/main/cli/architecture.md`, `doc/dev/cli/workflow.md`, `doc/PROGRESS.md`
**Verification:** `yaco task validate --json` → `{ok:true}`. Doc-only change; no code touched. Internal anchors (`architecture.md#cli--app-boundary`, `providers.md#provider-adapter-model`) and referenced test paths verified against the tree.
**Commit:** this commit.
**Next:** None — closes the `tui-provider-adapters` milestone docs.
**Blockers:** None.

## 2026-06-05: channel reply streaming via CLI output-follow

**What changed:**
- `channels/agent-output.ts` no longer resolves provider log paths or parses Claude/Codex JSONL. `startTurn(session)` resolves an opaque pre-send cursor via `yaco agent output-cursor <handle> --json`; `streamAgentReply(turn)` spawns ONE persistent `yaco agent output-follow <handle> --cursor <token> --offset <bytes> --json` child per turn and maps its NDJSON frames to `{kind:'interim'|'question'|'final'|'timeout', text}` events. `resolveSessionLog`, `classifyClaude`/`classifyCodex`, `formatQuestion`, and the `awaitFinalReply` back-compat shim are gone.
- App keeps its three boundary-owned concerns: the stream **timeout** (the CLI emits no timeout event), the **AskUserQuestion Escape side effect** (`onAskUserQuestion` awaited before the `question` event, with the `Dialog auto-cancelled …` note appended app-side), and **follow-child lifecycle** (terminated on final/end/error, app timeout, session close, and consumer disconnect).
- **Single follower per handle, process-wide.** The per-session lock moved out of the `createRouter` closure into a shared module-level serializer `queueHandleStream(handle, fn)` in `agent-output.ts`, so two separate routers (`wechat` + `whatsapp`) bound to the same session can never spawn overlapping `output-follow` children. `router.ts` dropped its `sessionStreamLock`/`queueSessionStream`.
- **No fast-reply skip.** The follower starts from `max(turn.offset, lastConsumed[handle])` — the pre-send cursor floor (so a reply written between send and follow-startup is never skipped) bumped only past a prior queued turn's consumed `nextOffset` (so a back-to-back same-session turn doesn't replay). Current EOF is never re-sampled after send.
- `agent.ts` `closeAgentSession(handle)` now calls `cancelAgentOutput(handle)` first, terminating any live follower for the killed session. `spawnFollow` attaches `child.on('error', …)` so an OS spawn failure routes through controlled stream termination instead of an unhandled `EventEmitter` crash.

**Why:**
- `app-output-boundary` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): app/server must stop resolving and parsing provider homes so each provider's private log layout lives only under `cli/`. The persistent `output-follow` stream is one subprocess per turn (not per poll), preserving the provider boundary without a spawn storm.

**Key files:** `app/server/src/lib/channels/{agent-output,router}.ts`, `app/server/src/lib/agent.ts`, `app/server/src/lib/__tests__/{agent-output,channel-streaming}.test.ts`; doc `doc/main/app/backend/libs.md`
**Verification:** `cd app/server && npx vitest run agent-output channel-streaming` → 17 pass (incl. two-router singleton + spawn-error tests, deterministic ×3); full server suite → 413 pass; `tsc --noEmit` adds zero errors over the pre-existing baseline.
**Commit:** this commit.
**Next:** `docs-provider-boundary` consolidates the TUI-only provider model and app/CLI boundary docs.
**Blockers:** None.

## 2026-06-05: project move rewrites owned by provider adapters

**What changed:**
- `cli/src/lib/core/project/move.ts` is now a thin orchestrator: it owns only YACO-owned state (session-state `sessionPath`, `projects.json` registry) and aggregates opaque `ProviderMovePlan` buckets by iterating the provider registry. All Claude/Codex provider-home schema logic (encoded project-dir rename + JSONL `cwd` rewrite with mtime preservation; codex rollout/`config.toml`/`state_5.sqlite threads` rewrites) moved to the new `cli/src/lib/core/agent/providers/project-move.ts` behind `provider.projectMove` (`claudeProjectMove()` / `codexProjectMove()`).
- New `ProviderProjectMove` contract (`providers/types.ts`): `plan(inputs) → ProviderMovePlan | null` (side-effect-free, **serializable opaque `payload`**), `apply(plan) → counts` (real applied counts), `renderText(plan) → lines`, and `countRows` (provider-owned legacy `{key,label}` count rows). `ProjectMoveInputs.providerHomeOverrides` (keyed by provider id) replaces the old `claudeHome`/`codexHome` test seam.
- New `cli/src/lib/core/project/match.ts` holds the dependency-free path helpers (`normalizePath`, `resolveMoveArg`, `isPathOrChild`, `translatePath`, `MatchMode`) shared by the mover and the adapters, breaking the would-be `move.ts ↔ providers` import cycle.
- **Command boundary keeps the legacy surface** (review-required): `MoveCounts` stays the flat legacy shape (`{ sessions, registry, claudeProjects, codexSessions, codexConfig, codexThreads }`) and the text count table keeps its historical labels (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/config`, `~/.codex/state_5`) — both rendered even at zero. Keys/labels come from each provider's `countRows`, so `commands/project/move.ts` iterates the registry instead of hard-coding provider knowledge. `moveCountRows()` + `renderProviderSections()` are exported from the project barrel for the command.

**Why:**
- `provider-project-move` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): a new provider should not require editing the generic mover to teach it that provider's private persisted cwd layout. Extraction is guarded by the existing move tests; the legacy count rows/keys/labels are preserved at the command boundary so dry-run JSON/text and real apply counts are unchanged for consumers.

**Key files:** `cli/src/lib/core/project/{move,match,index}.ts`, `cli/src/lib/core/agent/providers/{types,claude,codex,project-move}.ts`, `cli/src/commands/project/move.ts`, `cli/test/unit/{core,commands}/project/move.test.ts`; doc `doc/main/cli/providers.md`
**Verification:** `cd cli && bun test test/unit/core/project/move.test.ts test/unit/commands/project/move.test.ts` → 38 pass; `cd cli && bun run test:unit` → 610 pass, 0 fail; `tsc --noEmit` adds zero errors over the pre-existing baseline.
**Commit:** this commit.
**Next:** `docs-provider-boundary` consolidates the TUI-only provider model and app/CLI boundary docs.
**Blockers:** None.

## 2026-06-05: app/server summaries + history via CLI surfaces

**What changed:**
- `session-summary.ts` no longer resolves `~/.claude` JSONL or `~/.codex` SQLite/rollout files. `resolveSessionSummaries()` now serves from an in-process cache keyed by `(provider, sessionId, sessionPath)` and, for misses grouped by project path, calls `yaco agent summaries --path <p> --json` once per path. Only positive labels are cached; a `processing` → `idle` transition drops a cached label so a turn that changed it re-resolves. New `invalidateSummaryCache()` is wired into the sessions route's `invalidateSessionsCache()` (rename/close/start/manual refresh). `encodeProjectPath()` is retained as a pure helper for the not-yet-migrated `channels/agent-output.ts`.
- `history.ts` shrank from ~300 lines of Claude/Codex parsing to a thin mapper: `getHistory()` calls `yaco agent history --path <p> --json`, maps the CLI row shape (`sessionId`/`updatedAt`) to the UI shape (`id`/`modified`), and re-tags `liveSessionName` by matching CLI `sessionId` against the live YACO session list. `HistorySession.provider` widened from `'claude' | 'codex'` to `string`. `getClaudeHistory`/`getCodexHistory` and `getCodexDb` are gone.
- `agent.ts` gained the thin CLI transports `fetchHistory()` (`CliHistorySession[]`) and `fetchSessionSummaries()` (`CliSessionSummary[]`), mirroring `fetchProviderCatalog()`.
- Tests rewritten to mock the `../agent` CLI transports instead of planting `~/.claude`/`~/.codex` fixtures.

**Why:**
- `app-summary-history-boundary` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): app/server must stop resolving and parsing provider homes so each provider's private file/DB layout lives only under `cli/`. The app-side summary cache keeps the migration from spawning a subprocess on every `GET /api/sessions` poll while the boundary is observable before any persistent-helper optimization.

**Key files:** `app/server/src/lib/{agent.ts,session-summary.ts,history.ts}`, `app/server/src/routes/sessions.ts`, `app/server/src/lib/__tests__/{session-summary,history}.test.ts`; docs `doc/main/app/backend/libs.md`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/server && npm test -- session-summary.test.ts history.test.ts` → 20 pass (2 files); `tsc --noEmit` adds zero errors over the pre-existing baseline; consumes CLI summary/history surfaces from commit 4575fd7.
**Commit:** this commit.
**Next:** `app-output-boundary` migrates `channels/agent-output.ts` off provider-home log reads (then `encodeProjectPath` becomes removable).
**Blockers:** None.

## 2026-06-05: CLI provider output cursor + output-follow stream

**What changed:**
- Added the `output` capability to the provider contract and registered it for Claude and Codex. `ProviderOutput` (`cli/src/lib/core/agent/providers/types.ts`) now exposes `resolveCursor(session)` and `classifyLine(line)`; `classifyLine` returns **`AgentOutputEvent | null`** (at most one event per complete log line — the contract changed from an array to enforce safe `nextOffset` resume).
- New `cli/src/lib/core/agent/providers/output.ts`: `claudeOutput()`/`codexOutput()` adapters (cursor resolution + line classification, ported from the app's parsing), an **opaque cursor token** codec (`oc1_<base64url>` of `{provider,sessionId,path}`), and the provider-agnostic `followOutput()` tailer (`stat` + byte-range reads + byte-space partial-line buffering + offset advancement; terminates on `final`, a defensive max-lifetime cap, caller abort, or read error).
- New CLI surfaces wired in `cli/src/commands/agent/index.ts` via `cli/src/commands/agent/output.ts`: `yaco agent output-cursor <name>` → `{token,offset,sourceMtimeMs}`, and `yaco agent output-follow <name> [--cursor <token>] [--offset <bytes>]` → a persistent NDJSON **stdout stream** of `event`/`end` frames (not the single envelope; the process self-exits). One provider turn = one subprocess that polls internally.
- Strict, security-hardened input handling: a dedicated allowlist parser (`parseOutputFollowArgs`) accepts only the handle + `--cursor`/`--cursor=`, `--offset`/`--offset=`, `--json`. `--offset` (split/equal) is validated to a non-negative integer; `--cursor` values must be present/non-empty/non-flag-like → all reject as `USAGE` before any frame. A well-formed token bound to a different session/provider, or a raw path, is rejected as `INVALID` (the follower always re-resolves the read path from the session's provider and never trusts caller input). `--help`/`-h` is honored only as a standalone request.

**Why:**
- `provider-output-follow-cli` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): channel reply streaming must move behind a CLI surface so provider-home log reads stay under `cli/`, while avoiding a per-poll subprocess spawn storm. The opaque cursor + provider re-resolution keeps app/server from parsing provider paths and closes a path-injection vector; the one-event-per-line contract keeps `nextOffset` resume lossless. The app still owns stream timeout and the AskUserQuestion Escape side effect — the CLI never emits a `timeout` provider event.

**Key files:** `cli/src/lib/core/agent/providers/{output.ts,types.ts,claude.ts,codex.ts}`, `cli/src/commands/agent/{output.ts,index.ts}`, `cli/test/unit/agent-output.test.ts`; docs `doc/main/cli/providers.md`, `doc/main/cli/architecture.md`
**Verification:** `cd cli && bun test test/unit/agent-output.test.ts` → 54 pass; `cd cli && bun run test:unit` → 602 pass / 0 fail (44 files); `tsc --noEmit` clean for all touched files; temp-built `yaco` binary confirmed help envelopes, NDJSON streaming with `nextOffset`, and split/equal-form `--offset`/`--cursor`/unknown-flag/standalone-help validation.
**Commit:** this commit.
**Next:** `app-output-boundary` — app/server consumes `output-cursor` + persistent `output-follow` and drops its own provider log parsing (`channels/agent-output.ts`), keeping app-side timeout + AskUserQuestion side effect.
**Blockers:** None.

## 2026-06-05: app/server provider type boundary — validate against CLI catalog

**What changed:**
- `AgentSession.provider` / `AgentSessionState.provider` widen from `'claude' | 'codex'` to `string`; the YACO-owned `provider` field is trusted verbatim and a state file with no provider string is skipped. Removed `inferAgentProvider` (the handle-name heuristic) entirely.
- Added `fetchProviderCatalog()` (`yaco agent providers --json` → `ProviderCatalogEntry[]`) and a private `assertKnownAgentProvider()`; `startAgentSession(provider: string, …)` validates the provider against the catalog before spawning and throws `unknown agent provider: <id> (known: …)` on a miss. `POST /api/sessions/start` widened its body `provider` to `string`; `shell` still routes to the shell-session path before any catalog check.
- Made the remaining claude/codex-only call sites safe for arbitrary provider strings instead of treating every non-codex provider as Claude/Codex: channel `/new <provider>` drops its hard-coded union and delegates validation to `startAgentSession`; `channels/agent-output.ts` `resolveSessionLog`/`startTurn` return `null` for non-claude/codex providers (terminal-capture fallback); `session-summary.ts` resolves only `claude`/`codex` and skips other providers (no Claude-storage probe).

**Why:**
- `tui-app-provider-type-boundary` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): the CLI provider registry is the authoritative boundary, so app/server should trust YACO state provider strings and validate starts against the catalog rather than carrying a closed union and name heuristics. Provider-native summary/history/output reads stay behind the later `app-summary-history-boundary` / `app-output-boundary` tasks — this change only removes the unsafe Claude/Codex fallbacks in the meantime.

**Key files:** `app/server/src/lib/agent.ts`, `app/server/src/routes/sessions.ts`, `app/server/src/lib/channels/{router,agent-output}.ts`, `app/server/src/lib/session-summary.ts` (+ scoped tests); docs `doc/main/app/backend/{libs,routes}.md`, `doc/main/app/data-model/types.md`
**Verification:** `cd app/server && npm test` → full vitest 425/425 (one pre-existing real-tmux flake in `wechat-pty-tap` passes in isolation). Targeted: `agent`/`agent-output`/`wechat-router`/`sessions-worktree`/`session-summary` → 63 pass. `tsc --noEmit` clean for all touched production files.
**Commit:** this commit.
**Next:** `app-summary-history-boundary` and `app-output-boundary` move provider-native reads behind CLI surfaces; `ui-provider-config` carries the provider-keyed UI map.
**Blockers:** None.
## 2026-06-05: Task graph worksets and recursive task files

**What changed:**
- Added `workset` (`active | backlog | archive`) to the task schema. Missing values normalize to `active`; `yaco task archive` now marks a terminal subtree as `workset=archive` instead of writing/removing snapshot JSON.
- Changed the default task store from `plan/tasks.json` to recursive `plan/tasks/**/tasks.json`, with duplicate-ID detection and source-file writeback for updates.
- Updated app task reads so board/list/graph consume the same active-workset task API; archive view reads `workset=archive` tasks.
- Updated task/orchestrate/design/update-doc docs and SOTA task/paths/app docs for the new storage contract.

**Why:**
- Task execution lifecycle (`state`) and human workset visibility (`workset`) are separate concepts. Recursive task files let project-local task sets live together without tying active/backlog/archive semantics to physical folders.

**Key files:** `cli/src/lib/core/task/*`, `cli/src/commands/task/*`, `app/server/src/routes/tasks.ts`, `app/ui/src/hooks/useTaskGraph.ts`, `agent-config/global/skills/{update-tasks,orchestrate}/SKILL.md`, `doc/main/cli/task.md`
**Verification:** `cd cli && bun run test:unit` -> 554 pass / 0 fail; `cd cli && bun test ./test/integration/task/task-cli.integration.ts` -> 19 pass / 0 fail; `cd app/server && npx vitest run src/routes/__tests__/tasks-worktree.test.ts src/routes/__tests__/tasks-cli.test.ts` -> 15 pass / 0 fail; `cd app/ui && npm run lint` -> 0 errors / 13 existing warnings; `cd app/ui && npm run build` passed.
**Commit:** this commit
**Next:** Migrate the live root `plan/tasks.json` into `plan/tasks/tasks.json`, then move docs under `plan/all/**` with `plan/{active,backlog,archive}` symlink views.
**Blockers:** None.

## 2026-06-05: install/doctor iterate the provider registry

**What changed:**
- `yaco install` hook merge now iterates `listProviders()` and calls each adapter's `hooks.install()` (Claude → `ensureClaudeHooks`, Codex → `ensureCodexHooks`), keying the action list / `--dry-run` plan off `hooks.configPath()` instead of two hard-coded `ensureClaudeHooks()` / `ensureCodexHooks()` calls. The wrapper is still written once up front, so `install` is called directly (NOT `ensureHooks`).
- `yaco doctor` keeps its twelve fixed check names and `{checks,summary}` JSON shape, but the `providers` and `agent-hook-config` details are now registry-driven: `providers` probes each adapter's `executable` via `which`; `agent-hook-config` probes each hook-bearing adapter's `hasInstalledHook()`. Removed the inline `fileContainsYacoHook` walker. Fail strings changed to provider-neutral text (`no provider executable on $PATH (<ids>)`, `no yaco-agent-hook entries in provider configs`); pass-path detail format is byte-identical for the claude+codex pair.
- `yaco agent hooks install` iterates registered providers with hooks and reports `installed` from the registry instead of the literal `["claude","codex"]`.

**Why:**
- The `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`, `provider-install-doctor` task) wants adding a TUI provider to be one adapter, not edits across install + doctor. No per-provider doctor check names are introduced — adding a provider widens the detail string, not the check list, preserving the stable doctor contract.

**Key files:** `cli/src/commands/{install,doctor}.ts`, `cli/src/commands/agent/hooks/install.ts`, `doc/main/cli/{install,doctor}.md`
**Verification:** `cd cli && bun test test/hooks-install.test.ts test/unit/main.test.ts` → 24 pass / 0 fail (acceptance). `bun test test/unit/commands/{doctor,install}.test.ts` → 40 pass / 0 fail. `bun run test:unit` → 552 pass / 0 fail; `test/integration/install.test.ts` → 3 pass. `tsc --noEmit` clean for the scoped files.
**Commit:** this commit.
**Next:** sibling adapter tasks (`provider-output-follow-cli`, `provider-project-move`, app-side boundary tasks) and the `docs-provider-boundary` pass that retires flat `providers.ts` references.
**Blockers:** None.

## 2026-06-05: CLI summary/history/providers JSON surfaces

**What changed:**
- Added three `yaco agent` JSON subcommands so app/server can read provider-reconstructed data without opening `~/.claude` or `~/.codex` itself: `history --path <project> [--json]` (project-scoped, list-valued; live rows tagged by YACO `sessionId`), `summaries --path <project> [--json]` (one `{handle, sessionId, provider, label}` record per live session under the path), and `providers [--json]` (registry catalog `{id, label, executable}` for provider-start validation).
- Moved Claude/Codex history + summary reconstruction into the provider adapters: new `cli/src/lib/core/agent/providers/history.ts` co-locates Claude JSONL parsing (head/tail reads, slash-command-to-args normalization, custom-title/timestamp extraction, `sessions-index.json` enrichment) and Codex `threads` SQLite + rollout-file fallback, exposed as `claudeHistory()` / `codexHistory()` factories wired onto each adapter's optional `history` capability. `finalizeHistory()` owns the generic sort -> cap(200) -> live-tag merge.
- Claude project-dir resolution now reuses the canonical `encodeClaudeCwd` (non-alphanumerics -> `-`), fixing `.worktrees`-style paths that a `/`-only encoder mis-keyed.
- Widened the registry `HistorySession` DTO to carry the fields the History tab renders (`provider`/`summary`/`created`/`gitBranch`/`liveSessionName`).

**Why:**
- The `tui-provider-adapters` design centralizes provider-native storage under `cli/` so app/server consumes `yaco agent ... --json` instead of parsing provider homes. This slice lands the summary/history/catalog read surfaces; the matching app-side boundary removal (`app-summary-history-boundary`, `app-provider-type-boundary`) and the SOTA provider-boundary doc pass (`docs-provider-boundary`) are separate downstream tasks.

**Key files:** `cli/src/lib/core/agent/providers/{history,types,claude,codex}.ts`, `cli/src/commands/agent/{history,summaries,providers,index}.ts`, `cli/test/{history,summary,agent-json-surfaces}.test.ts`, `cli/package.json`
**Verification:** `cd cli && bun run test:unit` -> 552 pass / 0 fail (+9: `.worktrees` encoding, spawned help/catalog envelopes, hermetic data envelopes). `tsc --noEmit` clean for all touched files (only pre-existing out-of-scope errors remain). Source-entry and PATH-prefixed compiled-binary acceptance both return `{ok:true,...}` for the three surfaces.
**Commit:** this commit.
**Next:** `app-summary-history-boundary` (app consumes these surfaces, drops provider-home reads), `app-provider-type-boundary` (validate starts against `agent providers --json`), `docs-provider-boundary` (retire flat `providers.ts` refs, document the app/CLI boundary).
**Blockers:** None.

## 2026-06-05: Agent start/lifecycle consumes the provider registry

**What changed:**
- Moved the start/status/rename/whoami/lifecycle/tmux provider branches onto the committed provider registry adapters. `start.ts` now drives resume canonicalization (`command.normalizeResumeArgs`), name handling (`command.normalizeStartArgs` / `postStartInputs`), startup interstitials (`command.startupInterstitials`, generalized into one `handleStartupInterstitial` loop), the launch command (`command.build`), session-id strategy (`sessionId.startResolution` / `resolve` / `pendingValue`), and PID resolution (`prov.executable`). `status.ts` backfills via `provider.sessionId.resolve` (guarded by `hasProvider`), keys `preferredCommand` off `provider.executable`, and iterates `listProviders()` for the health check. `rename.ts` uses `command.renameInputs`; `whoami.ts` derives session-id env keys from `listProviders().flatMap(p => p.sessionId.envKeys)`; `lifecycle.ts#ensureHooks` delegates config mutation to `getProvider(provider).hooks?.install()`; `tmux.ts` derives the known-agent executable set from the registry.
- Behavior change: the detached Codex OSC 10/11 color responder is started again, now **gated by the adapter `terminal.respondToColorQuery` flag** (no hard-coded provider check, no 1.5s launch delay). Codex start-time sessionId stays state-file-only; status backfill resolves provider storage.
- Strengthened `cli/test/lifecycle-guards.test.ts`: the Codex start test proves the adapter resolver is *not* consulted at start even when provider storage could resolve, plus a new test that status backfill *does* resolve a pending Codex sessionId from provider storage.

**Why:**
- The lifecycle paths had hard-coded `provider === "claude" | "codex"` branches; the TUI provider-adapter design centralizes per-provider behavior so adding a provider is one adapter, not edits across startup/status/rename/whoami/hooks/tmux. The OSC responder is the canonical adapter-driven terminal-runtime quirk, so it returns gated by the adapter flag while preserving the perf win (the 1.5s launch delay and 10s sessionId wait stay removed; the responder is a non-blocking `pipe-pane`).

**Key files:** `cli/src/commands/agent/{start,status,rename}.ts`, `cli/src/lib/core/agent/{whoami,lifecycle,tmux}.ts`, `cli/test/lifecycle-guards.test.ts`, `doc/main/cli/{providers,lifecycle,architecture}.md`
**Verification:** `cd cli && bun test test/start.test.ts test/rename.test.ts test/whoami.test.ts test/hooks-install.test.ts test/tmux.test.ts test/lifecycle-guards.test.ts` → 79 pass / 0 fail. `cd cli && bun run test:unit` → 546 pass / 0 fail. `tsc --noEmit` clean for all touched files (only pre-existing out-of-scope errors remain).
**Commit:** this commit.
**Next:** Sibling adapter tasks (summary/history CLI, output-follow, project-move, install/doctor, app boundary) and the `docs-provider-boundary` doc pass that retires the flat `providers.ts` references.
**Blockers:** None.

## 2026-06-05: Installer drops migrated legacy hook-v2.sh entries

**What changed:**
- Added `dropLegacyMultmuxHooks()` in `cli/src/lib/core/agent/lifecycle.ts` and wired it into `ensureClaudeHooks` + `ensureCodexHooks`. The hook merge now removes legacy `bash ".../hook-v2.sh"` shell-hook groups (under `~/.multmux` or the migrated `~/.yaco`), pruning only groups it empties and leaving every other entry — including unrelated empty groups — untouched.
- Tests in `cli/test/hooks-install.test.ts` for the pure helper plus both provider merges.

**Why:**
- The prior install only *added* the managed `yaco agent hook-event` group beside the old shell hook — `cleanupDeprecatedHooks` matched only `on-stop.sh`, and the legacy-drop never recognized the migrated `~/.yaco/hook-v2.sh` path. Result: every hook event fired twice and `hook-v2.sh` stayed referenced, blocking its removal. `yaco install` now self-heals on any machine (incl. the laptop).

**Key files:** `cli/src/lib/core/agent/lifecycle.ts`, `cli/test/hooks-install.test.ts`, `doc/main/cli/install.md`
**Verification:** `cd cli && bun run test` → 509 pass / 0 fail. `tools/install.sh` → doctor 12/12; this machine's `~/.claude/settings.json` + `~/.codex/hooks.json` now hold 0 `hook-v2.sh` refs (idempotent on re-run).
**Commit:** this commit.
**Next:** `wrapper-v2.sh` / `hook-v2.sh` stay on disk until the ~20 pre-cutover tmux panes drain, then deletable.
**Blockers:** None.

## 2026-06-05: Shed remaining multmux naming (server symbols + gitignores)

**What changed:**
- Renamed `app/server` agent-session symbols off the old multmux name: `MultmuxSession`→`AgentSession`, `MultmuxStateFile`→`AgentSessionState`, `MULTMUX_SESSIONS_DIR`→`AGENT_SESSIONS_DIR`, plus the `start`/`close`/`rename`/`to`/`watch` + `infer`/`query` helpers → `Agent*`. Internal-only; HTTP/route contracts and the on-disk state-file schema are unchanged.
- Cleaned stale `.gitignore` entries: dropped `.multmux/` (root, agent-config, cli); in `cli/.gitignore` replaced the no-longer-built `/multmux`, `/tmusk`, `/tmusk-sidebar` with the current `/yaco` binary.
- Synced `doc/main/app/backend/libs.md` to the new names and removed the now-false "type names intentionally retained" note. Test fixture project name `'multmux'`→`'demo'`.

**Why:**
- The runtime moved to `~/.yaco` / `yaco agent` long ago; the lingering `Multmux*` symbol names and dead gitignore lines were the last in-tree naming drift. `AgentSession(State)` mirrors the existing `ShellSession`/`HistorySession` convention and the CLI's `SessionState`; no `Yaco*` prefix since the brand is implicit inside the repo. The `tmusk` skill name and the `~/.multmux`→`~/.yaco` migration script keep the old name intentionally.

**Key files:** `app/server/src/lib/{agent,constants,history,project-watcher,session-reconciler,session-summary}.ts`, `app/server/src/lib/channels/{agent-output,router}.ts`, `app/server/src/routes/sessions.ts`, `.gitignore`, `agent-config/.gitignore`, `cli/.gitignore`, `doc/main/app/backend/libs.md`
**Verification:** `cd app/server && npx vitest run` → 31 files / 420 tests pass. `tsc --noEmit` shows only pre-existing unrelated errors (none in renamed files).
**Commit:** 43dc42a (code) + this docs commit.
**Next:** Optional — rename the `tmusk` skill to `agent` (skill registry + docs); deferred by request.
**Blockers:** None.

## 2026-06-05: Fast Codex startup path

**What changed:**
- Removed Codex's default 1.5s wrapper launch delay and stopped starting the detached OSC 10/11 color responder on startup.
- Kept startup `/rename <handle>` as best-effort provider-title sync, but changed it to submit-only: `yaco agent start codex` no longer waits for the slash command to finish.
- Removed the 10s Codex non-resume sessionId wait. Startup now uses a hook-written sessionId when already present, otherwise writes `pending:awaiting-first-prompt`; later hooks or status reconciliation backfill the real thread id.
- Updated lifecycle/provider docs and integration test wording so YACO handle remains the authoritative runtime identity while Codex internal title sync is best-effort.

**Why:**
- Workflow only needs the YACO handle/tmux/state path to attach, send, capture, and kill. Codex title color fidelity and immediate thread-id discovery were on the startup critical path but are not required for session availability.

**Key files:** `cli/src/commands/agent/start.ts`, `cli/test/lifecycle-guards.test.ts`, `cli/test/integration/agent-lifecycle.integration.ts`, `doc/main/cli/{lifecycle,providers}.md`
**Verification:** `cd cli && bun test test/lifecycle-guards.test.ts test/start.test.ts test/providers.test.ts test/tmux.test.ts` passed (79 tests); `cd cli && bun run build` passed; `git diff --check` passed.
**Commit:** This commit.
**Next:** Optional live Codex smoke through Workflow to confirm perceived start latency and acceptable input-box color behavior.
**Blockers:** None.

## 2026-06-05: Add `yaco agent whoami`

**What changed:**
- Added `yaco agent whoami`, returning the current YACO session handle in text mode and full runtime state plus identity source in `--json` mode.
- Implemented identity resolution in priority order: `TMUX_PANE` tmux session lookup, provider session-id env (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`), then nearest ancestor PID match.
- Updated tmusk skill docs and CLI architecture/provider docs for the new command and assumptions.

**Why:**
- Agents need a reliable way to self-identify their YACO handle without relying on prompt-injected names. The fallback order keeps local tmux identity canonical while still working inside provider tool subprocesses when `TMUX_PANE` is unavailable.

**Key files:** `cli/src/lib/core/agent/whoami.ts`, `cli/src/commands/agent/whoami.ts`, `cli/src/commands/agent/index.ts`, `cli/test/whoami.test.ts`, `doc/main/cli/{architecture,providers}.md`, `agent-config/global/skills/tmusk/SKILL.md`
**Verification:** Live QA with `qa-claude-whoami` and `qa-codex-whoami` passed for normal `TMUX_PANE` resolution and `env -u TMUX_PANE ... whoami` session-id fallback; `cd cli && bun test test/whoami.test.ts test/agent-dispatch.test.ts` passed (17 tests); `cd cli && bun run test:unit` passed (505 tests); `cd cli && bun run build` passed; `git diff --check` passed.
**Commit:** This commit.
**Next:** None.
**Blockers:** None.

## 2026-06-05: Streaming voice dialog

**What changed:**
- Replaced the one-shot `/api/voice/compose` flow with split `/api/voice/transcribe` and `/api/voice/format` endpoints, including upload/type validation, transcript/filePath caps, and `retry-after` forwarding on upstream 429s.
- Added self-hosted lazy VAD assets, a `voiceVad.ts` MicVAD wrapper with ~10s coalescing, a single-active-phase voice reducer, and `useVoice.ts` orchestration for per-chunk transcription, drain-gated final formatting, throttling, and stale-run cleanup.
- Updated the voice tray/control UI to show live transcript + pending count, freeze insertion target per run, and keep Insert/Discard clipboard backup e2e coverage on the split endpoint path.
- Added focused unit/e2e tests and a manual Chrome desktop + phone-over-Tailscale VAD checklist.

**Why:**
- Voice input should feel live without relying on a true streaming Whisper endpoint: VAD creates silence-aligned chunks, the client coalesces them to stay under Groq free-tier RPM limits, and the formatter runs once at Stop over the full transcript.

**Key files:** `app/server/src/routes/voice.ts`, `app/ui/src/hooks/{useVoice,voiceVad,voiceStateMachine}.ts`, `app/ui/src/components/ComposeTray.tsx`, `app/ui/tests/e2e/voice-compose-backup.spec.ts`, `plan/archive/20260605_voice-streaming/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run useVoice voiceStateMachine src/hooks/__tests__/voiceVad.test.ts` passed; `cd app/ui && npx playwright test voice` passed; `cd app/ui && npm run build` passed; `cd app/server && npm test` passed.
**Commit:** `b3026e6`
**Next:** Optional manual VAD smoke test on Chrome desktop and phone over Tailscale.
**Blockers:** None.

## 2026-06-04: Self-hosted, lazy-loaded VAD assets (`vs-vad-assets`)

**What changed:**
- `app/ui` now self-hosts the in-browser VAD runtime instead of pulling it from a CDN. Pinned `@ricky0123/vad-web@0.0.30` + `onnxruntime-web@1.20.1` (exact); added `vite-plugin-static-copy` (dev).
- `vite.config.ts`: `viteStaticCopy` copies exactly four files into `dist/assets/vad/1.20.1/` (flat, `rename: { stripBase: true }`, `Target[]`-typed): vad-web worklet, `silero_vad_v5.onnx`, and the single-threaded SIMD **non-jsep** `ort-wasm-simd-threaded.{mjs,wasm}`. One `VAD_ASSET_VERSION` drives both the copy dest and the `__VAD_ASSET_BASE__` `define` (consumer's single source of truth for the URL).
- `app/server/src/index.ts`: added `.wasm` → `application/wasm` (mandatory for `WebAssembly.instantiateStreaming`) and `.onnx` → `application/octet-stream` to the MIME map; the existing `/assets/*` `immutable` rule covers the version-pinned dir.

**Why:**
- The app runs over Tailscale / offline, so VAD must not depend on a CDN and must be reproducible. Self-hosting + content-pinned `immutable` cache makes first-voice-use a one-time ~13MB download per device with zero page-open cost. vad-web imports `onnxruntime-web/wasm` (non-jsep), so the single-threaded SIMD build suffices — avoiding the `SharedArrayBuffer`/COOP+COEP headers the threaded build would need.

**Key files:** `app/ui/package.json`, `app/ui/vite.config.ts`, `app/server/src/index.ts`; docs: `doc/main/app/backend/server.md`, `doc/dev/app/workflow.md`, `plan/archive/20260605_voice-streaming/implementation_summary.md`.
**Verification:** `tsc -b tsconfig.node.json` clean; `vite build` ok (`Copied 4 items`, flat); prod (Hono) + dev (vite middleware) serve all four `200` with correct MIME + `immutable`, binaries byte-identical to source, non-copied `…jsep.wasm` `404`s; VAD/ORT JS absent from every app chunk.
**Commit:** docs only; task code pending orchestrator review (`vs-vad-assets`).
**Next:** `vs-vad-module` (`voiceVad.ts`) consumes `__VAD_ASSET_BASE__` and **must** pass `model: 'v5'` (only the v5 model is copied).
**Blockers:** Full `app/ui` `npm run build` is red on sibling voice tasks mid-migration (`voiceStateMachine.ts` ahead of its consumers) — not from this task.

## 2026-06-04: Rename in-repo `projects/` → `plan/` across all registered repos

**What changed:**
- Renamed the in-repo task-graph + design-doc directory `projects/` → `plan/` and made it the global default (`DEFAULT_PROJECT_PATHS` in `cli/src/lib/core/paths/yaco-paths.ts`). Rebuilt + reinstalled the compiled `yaco` binary.
- Ontology is now **project ⊃ plan ⊃ task**: "project" stays the repo-level concept (registry `~/.yaco/projects.json`, `yaco project`, app `Project` type, and the unrelated `~/.claude/projects` session store all unchanged); `plan/` is the in-repo dir.
- yaco repo: `git mv projects plan` (~700 files, history preserved) + forward refs updated (6 skills, app/ui hardcoded `TASKS_FILE_PATH`, doctor/task/install path fixtures, SOTA docs, CLAUDE.md/README). Historical content (archived design docs, `doc/progress/*`) moved with the dir but text left unchanged.
- All 13 registered repos migrated, each preserving its tracking intent: tracked `projects/` → `git mv`; gitignored `projects/` (lawyer_search, closepaw) → renamed dir + ignore pattern, `plan/` stays ignored; non-git (localbiz, jobspace) → plain `mv`; tracked symlinks (openweb, closepaw→closepaw-projects) → retargeted.

**Why:**
- The in-repo `projects/` dir collided with the registry-level "a project = a registered repo", and the directory name echoed the concept at a different granularity. `plan/` removes the collision and reads naturally with `tasks.json` (the plan) + design-doc bundles.

**Key files:** `cli/src/lib/core/paths/yaco-paths.ts`, `app/ui/src/hooks/useTaskGraph.ts`, 6 `agent-config/global/skills/*/SKILL.md`, `doc/main/**`, `CLAUDE.md`, `README.md`; `git mv` of `projects/` → `plan/`.
**Verification:** cli unit 509 pass, task integration 19 pass, app/server 389 pass; `yaco doctor` task-graph resolves `plan/tasks.json`; `yaco task list` reads the graph. `find ~/ld-workspace` confirms no `projects/` in any registered repo.
**Commit:** `968901c` (yaco repo); other repos have their own local rename commits.
**Next:** Decide structure for the non-standard openweb-projects (root-level content vs nesting under `plan/`); deferred separate-private-repo design for `plan/`.
**Blockers:** None

## 2026-06-04: Resolve Documentation Consolidation Review Follow-Ups

**What changed:**
- Repointed remaining active project references from old `agent-config/doc/...` paths to root `doc/main/agent-config/...` and `doc/dev/agent-config/...`.
- Fixed moved progress-history markdown links/examples that tripped link sweeps after the root doc consolidation.

**Why:**
- Claude review found no blockers, but identified low-risk stale references that could confuse future agents.

**Key files:** `projects/active/mattpocock-skills-review/**`, `projects/active/potential-publish/initial/design_codex.md`, `projects/active/yaco-core/initial/design_claude.md`, `doc/progress/{app,cli,agent-config}.md`
**Verification:** Markdown link/path sweep, stale active-project path grep.
**Commit:** This follow-up commit
**Next:** Leave ignored `app/doc/todo/progress.json` alone unless runtime-state cleanup is explicitly requested.
**Blockers:** None

## 2026-06-04: Consolidate Monorepo Documentation

**What changed:**
- Moved component SOTA docs from `app/doc`, `cli/doc`, and `agent-config/doc` into root `doc/main/{app,cli,agent-config}` and `doc/dev/{app,cli,agent-config}`.
- Moved imported component histories into `doc/progress/`.
- Added root documentation maps and slimmed component `CLAUDE.md` files to local quickstarts.

**Why:**
- The monorepo is now merged, so docs need one canonical root hierarchy while preserving scoped ownership.

**Key files:** `doc/main/README.md`, `doc/main/architecture.md`, `doc/dev/README.md`, `doc/progress/README.md`, `CLAUDE.md`, `app/CLAUDE.md`, `cli/CLAUDE.md`, `agent-config/CLAUDE.md`
**Verification:** Markdown link/path sweep.
**Commit:** Pending
**Next:** Keep future component docs under root `doc/`.
**Blockers:** None
