# Progress

## 2026-08-11: export eligibility is a test, not a review judgment

**What changed:**
- `cli/test/unit/export-audit.test.ts` audits every `cli/package.json#exports` entry through its transitive production import closure, walked with the TypeScript compiler (`cli/test/helpers/export-closure.ts`). Four things are pinned per export: the file closure, the specifiers the walk could not follow, the exported names grouped by origin file, and the exported error classes. Excluded subsystems (tmux, reconciliation, lifecycle, usage, mutation, synchronous sleep) are named by file, asserted unreachable, **and asserted to exist**.
- `@yaco/cli/core/worktree` narrows to `validateSlug`, `worktreePath`, `worktreeBranch`. `@yaco/cli/core/task` narrows to the model, the pure graph analysis and the read half of the store — the writers, the tasks-file lock, `archive.ts` and `link.ts` left the barrel, and `cli/src/commands/task/*` imports them directly. `DEFAULT_TASK_LOCK_TIMEOUT_MS` moved to `task/model.ts`.
- `YACO_TASK_LOCK_TIMEOUT_MS` is read only at `cli/src/commands/task/lock-timeout.ts` and threaded down as an explicit `AcquireOptions.timeoutMs`; `mutateTaskAgentLink` and `rewriteTaskAgentHandle` gained the parameter.
- `TomlParseError` is deleted; `parseScopedToml` raises `CliError(ENV, "yaco.toml:<line>: …")` — same message, same code, no `details`, so the envelope is byte-identical.
- New SOTA doc `doc/main/cli/exports.md`.

**Why:**
- Phase 2 of `cli-node-sdk` moves five app read paths in process. What an export may contain then runs inside the app's event loop under the app's lifetime, so it is a contract; four cutovers depend on this gate being real before they land.
- The compiler, not a regex, because the two shapes that decide the answer are one AST node apart: a re-export is an edge with no `import` statement, and a type-only import is not an edge at all. An audit that gets either wrong is worse than none, because it reads as enforcement.
- Four cross-provider review rounds turned the gate from a name-matching scan into one that judges what names stand for: origins pinned by declaration file (a same-named writer in an already-reachable module), `isProcess` covering `globalThis["process"]` aliases, `…Sync` failing closed against a bounded allowlist rather than a forbidden list, constant-truthy loop conditions, and rule 6 asking the type system rather than the heritage clause's spelling.
- Every check has been watched fail. Planted and reverted: a fourth ambient env name, a re-exported `runGit`, `saveTasks` republished as `loadTasks`, `withLock` back on the barrel, a second `readdirSync` in the debt file, a second error class, a same-named writer in `graph.ts`, and a dropped `timeoutMs` (which the integration test catches at 10125ms against a 5000ms bound).

**Known debt:** `loadTaskStore` still walks the task tree with a synchronous recursive `readdir`, which rule 5 excludes. It is pinned in the audit as an exact finding multiset (not waived by file), so a second traversal fails and the entry must be deleted when the design's Phase-2 cutover 1 lands the `fs/promises` chunked reader. Converting it here would change `app/server`'s call site and take that cutover's work.

**Key files:** `cli/test/unit/export-audit.test.ts`, `cli/test/helpers/export-closure.ts`, `cli/src/lib/core/{task,worktree,paths}/index.ts`, `cli/src/commands/task/lock-timeout.ts`, `cli/src/lib/core/paths/toml.ts`, `doc/main/cli/exports.md`
**Verification:** `bash scripts/verify.sh` all steps pass (1260 CLI unit tests, 10 pack-smoke, 825 app/server tests); `task-cli` integration 27/27; eight falsification plants, each reverted.
**Commit:** `50bde3b4..809390cb`
**Next:** Phase-2 cutover 1 — task GET against a shared `fs/promises` chunked reader, which also clears the rule-5 debt.
**Blockers:** None.

## 2026-08-11: the CLI ships as an npm package — two artifacts, one source tree

**What changed:**
- `cli/bin/yaco.mjs` is the `bin` entry: a Node `>=24.15.0` guard, then a dynamic import of `dist/yaco.mjs` and `await main()`. The comparator lives in `bin/node-floor.mjs` so it can be tested — the launcher runs the CLI the moment it is imported.
- `npm run build` emits both artifacts. `build:bundle` is esbuild → `dist/yaco.mjs` (365 KB, the command); `build:lib` is `tsc -p tsconfig.build.json` with `rootDir: src` → `dist/**.js` + `.d.ts` (the exports map). `prepack` runs a clean build.
- `cli/package.json` gains `engines.node`, a `files` allowlist, and an exports map with `development` (→ `src/**.ts`, for `app/server` under tsx) / `types` / `default` conditions. `@types/bun` → `@types/node`, `typescript` peer → dev, `bun.lock` and `private` deleted. `src/main.ts` loses its dead bun shebang and its `import.meta.main`, and exports `main`.
- `tools/install.sh` packs `@yaco/cli` and `npm install --global --prefix`es the tarball. It bootstraps the CLI workspace's dependencies only when the clone has none, and requires `$YACO_BIN_DIR` to end in `/bin`.
- `package-root.ts#yacoExecutable()` replaces two divergent chains (`lifecycle.ts`, `tmux.ts`) with one: `$YACO_PATH` → an *explicitly supplied* `$YACO_BIN_DIR/yaco` → a PATH walk that skips `node_modules/.bin` shims → `<package-root>/bin/yaco.mjs`. The two rungs that are gone are the ones that were broken — a `process.execPath` sniff that only fired for a Bun binary, and a literal `"yaco"` that failed at every hook fire. The wrapper's four-rung checkout walk is gone; `readAgentWrapperScript()` reads the packaged asset or raises `INTERNAL`.
- `scripts/verify.sh` and CI drop Bun and gain four named CLI steps: typecheck, build, test, pack smoke. New `cli/test/integration/pack.test.ts` is that smoke.

**Why:**
- The repo had not been installable since `cli-sqlite-hop`: `tools/install.sh` built a `bun build --compile` binary that exits before `main` on `node:sqlite`. Restoring installability was this change's definition of done.
- Two artifacts because neither serves both jobs. Measured on this machine against a Bun binary rebuilt from `375baaf4`, 30 alternating samples: `--help` 62.9 → 69.6 ms bundle / 128.1 ms module graph; `task list` (469 tasks) 84.6 → 108.3 / 169.7 ms. Mutating hook p95 `UserPromptSubmit` 86.1 → 110.6 ms (+24.5, gate < 50). And TypeScript source under `node_modules` fails plain Node with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, so the exports map needs emitted JS regardless.
- The resolver chains existed because a Bun-compiled binary served its modules from a virtual filesystem and the package could not name its own files. A real package root supplies a floor rung that always exists, so the literal `"yaco"` — which wrote a hook command that failed silently at every fire — has something to be replaced by. QA caught the over-deletion, and cross-provider review caught the two ways the restored rung was still wrong: `which yaco` answers with npm's workspace shim under any npm script (so a checkout still hijacked global hooks), and exporting the *defaulted* `$YACO_BIN_DIR` from `runInstall` let a guess outrank the executable the user had actually just run. Both now have tests.
- The dependency repair deletes nothing. `npm ci --workspace` prunes every workspace it was not asked about, and three attempts at deciding *when* that is safe (directory exists; a marker inside `node_modules`; npm's hidden lock) each either could not survive the operation they described or failed open when missing — the last one reproducibly authorized deleting a real second-workspace tree. So the install resolves in an isolated stage built from the manifests and the lockfile, and the result is copied in rather than swapped for what is there.
- `typescript` was a `peerDependency`, which npm auto-installs — every `npm i -g @yaco/cli` was pulling 23 MB of compiler the CLI never runs.
- Distribution cost worth knowing: the installed executable is `#!/usr/bin/env node`, so `node` must be on `$PATH` wherever a hook fires. The single-file Bun binary did not need that. It is the ordinary npm global-bin contract.

**Key files:** `cli/bin/{yaco,node-floor}.mjs`, `cli/tsconfig.build.json`, `cli/package.json`, `cli/src/package-root.ts`, `cli/src/lib/core/agent/{lifecycle,tmux}.ts`, `cli/src/main.ts`, `tools/install.sh`, `scripts/verify.sh`, `.github/workflows/ci.yml`, `cli/test/integration/{install,pack}.test.ts`, `cli/test/unit/{package-root,node-floor}.test.ts`, `app/server/{package.json,tsconfig.json}`
**Verification:** `scripts/verify.sh` all steps passed (cli 1204 unit + 10 pack, server 825, codex-transcribe 75); `cli` integration `install.test.ts` 10/10 with the parked clean-`$BIN_DIR` case unskipped; a `git archive HEAD` clone bootstraps and installs end to end in ~10 s into an isolated `HOME`/`YACO_HOME`/prefix; the typecheck step was proven to fail on a planted type error the test step passes. Cross-provider review (Codex) and QA in `plan/all/cli-node-sdk/`.
**Next:** `read-export-gate` — audit every export against the six eligibility rules before the Phase 2 read cutovers.
**Blockers:** None

## 2026-08-10: the CLI leaves Bun — `bun:sqlite` → `node:sqlite` in one commit

**What changed:**
- `cli/src/lib/core/agent/session-id.ts` and `providers/{history,project-move}.ts` open `node:sqlite`'s `DatabaseSync`. With them, in the same commit: the 6 test files that stage a database move to Vitest, `test/cohorts.mjs` + `cohorts.test.ts` + `helpers/bun-sqlite-stub.ts` + its `vitest.config.ts` alias are deleted, `module-mock-scope.test.ts` loses its bun clause, and `runCli` spawns `process.execPath` on `src/main.ts` instead of `bun run`.
- `vitest.config.ts` declares the two suites as projects — `integration` is `test/integration/**`, `unit` is everything else — and both include `*.test.ts` and `*.integration.ts`, so the "file in no suite" bug the deleted runner existed to prevent stays prevented by the glob.
- Two new tests in `test/unit/core/project/move.test.ts`: a `state_5.sqlite` with no `threads` table is a no-op, and an aborting bucket leaves no partial write. Both were verified by mutating the production code until they fail.
- `cli/package.json` drops the cohort scripts and the `build` script; `npm run test:unit` is `vitest run --project unit`.
- **`tools/install.sh` is broken until `cli-dual-artifact-package`.** It ends by running the binary it just built, and that binary is `bun build --compile`. Documented in `cli/CLAUDE.md` and `doc/dev/cli/workflow.md`.

**Why:**
- Bun 1.3.13 answers `node:sqlite` with "No such built-in module", so there is no ordering in which the production users and their fixtures move separately and the tree stays green. Everything that reaches SQLite — three source files, six fixtures, the runner that partitioned them, the helper that spawns the CLI — is one atomic set.
- The mapping is mechanical except in one place, and that place was a silent behavior change: `.get()` returns `undefined` on a miss where `bun:sqlite` returned `null`, so `project-move`'s ported `hasThreadsTable` reported *present* for every database without the table, and the planner would then query a table that does not exist. Raw SQL is the other trap in the opposite direction — `DatabaseSync` has no `run` at all, so a missed call site is a `TypeError` raised from inside the write transaction, which is the least-read path in the file.
- `providers/claude.ts`'s eager `history`/`project-move` imports were left alone. They were flagged by the previous task only because they forced the Vitest stub; the stub dies here from the specifier resolving natively, and deferring them for real would require `ProviderProjectMove.plan`/`apply`/`renderText` — all synchronous — to become async.
- The compiled artifact was the cost, not an accident: `package-root.test.ts`'s "from a compiled artifact" block (3 assertions) is deleted and `install.test.ts`'s clean-`$BIN_DIR` bootstrap is skipped, both naming `cli-dual-artifact-package`, which owns the `bin/yaco.mjs` + `dist/` layout that replaces the single-file binary.

**Key files:** `cli/src/lib/core/agent/session-id.ts`, `cli/src/lib/core/agent/providers/{history,project-move}.ts`, `cli/vitest.config.ts`, `cli/test/helpers/cli-process.ts`, `cli/test/unit/core/project/move.test.ts`, `cli/test/unit/package-root.test.ts`, `cli/package.json`, `cli/CLAUDE.md`, `doc/dev/cli/workflow.md`
**Verification:** `scripts/verify.sh` all steps passed; `npx tsc --noEmit -p .` clean in `cli/`; unit 1196 passed / 0 failed (1209 → 1196 = −12 `cohorts.test.ts`, −3 compiled artifact, +2 SQLite), integration 80 passed / 1 skipped (was 81); `cli/test/golden/matrix.json` reproduces byte-identical with a Node child against the Bun-captured baseline and was **not** recaptured; cross-provider review (Codex) and QA in `plan/all/cli-node-sdk/`.
**Next:** `cli-dual-artifact-package` — the Node artifact, `tools/install.sh`, and the manifest/lock cleanup (`@types/bun`, `cli/bun.lock`, `src/main.ts`'s dead bun shebang).
**Blockers:** None

## 2026-08-10: the CLI test suite moves to Vitest, minus six database fixtures

**What changed:**
- 84 of the tree's 90 `cli/test` files now import `vitest`. The 6 that remain open a `bun:sqlite` `Database` — `test/{history,session-id,summary}.test.ts`, `test/unit/{commands,core}/project/move.test.ts`, `test/unit/core/agent/ordering.test.ts` — and are `cli-sqlite-hop`'s to move. No pre-existing test changed meaning: 1187 → 1209 unit, the +22 being `test/wrapper-resolve.test.ts` (10 tests, added by `cli-portable-runtime` and never listed in `test:unit`) and the new `test/cohorts.test.ts` (12).
- `cli/test/cohorts.mjs` replaces the hand-maintained file list in `cli/package.json`. It assigns each file to a cohort by which runner it imports, runs both, and fails closed on a file that names neither or both — the class of drift that orphaned `wrapper-resolve.test.ts` for a whole task — and on a bun-cohort file that runs no test, judged from the file's own source rather than from anything the run reports.
- Two temporary bridges, both deleted by `cli-sqlite-hop`: `vitest.config.ts` aliases `bun:sqlite` to a stub whose constructor throws, and `test/helpers/cli-process.ts` owns how a test starts the CLI.
- The three `mock.module` users move to `vi.mock` + `vi.hoisted` and `test/helpers/module-mock.ts` is deleted rather than ported. `module-mock-scope.test.ts` survives with its exemption removed.
- `cli/test/unit/core/agent/usage-child-process.test.ts` now observes the codex child's stdin `EPIPE` instead of asserting a listener exists.

**Why:**
- 32 files reach `bun:sqlite` only because `providers/claude.ts` statically imports `history.ts` and `project-move.ts`; none opens a database. Reading "closure requires `node:sqlite`" as *static graph* rather than *runtime need* would have left the migration at 51 files and stranded all three `mock.module` users, which this task owed. The stub answers the barrel without putting a database in play, and is fail-closed: a test that really wants one throws.
- `src/main.ts` still imports `bun:sqlite` transitively, so a subprocess test's child is a Bun process whichever runner hosts it. `process.execPath` is the *host* — under Vitest, node — which is why `test/golden/capture.ts` broke: the golden child's env carries an empty PATH and `uv_spawn` resolves the program against the child's PATH, so the runtime must be named absolutely. Naming it in one place makes `cli-sqlite-hop` a one-line change instead of eighteen.
- Bun's `mock.module` rewrites a module's own internal references; `vi.mock` replaces its exports and leaves a real function's internals alone. A straight port silently stopped exercising the Codex post-start-input path, because the real `sendKeysWhenInputEmpty` called real tmux. Found by a failing assertion, not by review.
- The EPIPE conversion was owed from `cli-portable-runtime`, whose test could only be structural because Bun raises no such event. Neither scenario it used reproduces it on Node: a child that never spawned and one that has already exited both leave `stdin.errored` null. Only a child that is alive with its read end closed raises it — and deleting the guard in `usage.ts` makes the run exit 1 with an unhandled `EPIPE`, so the assertion is load-bearing.

**Key files:** `cli/test/cohorts.mjs`, `cli/vitest.config.ts`, `cli/test/helpers/{cli-process,bun-sqlite-stub}.ts`, `cli/test/{kill,lifecycle-guards}.test.ts`, `cli/test/unit/agent/reclaim-crashed.test.ts`, `cli/test/unit/core/agent/usage-child-process.test.ts`, `cli/test/golden/capture.ts`, `cli/package.json`, `cli/bun.lock`, `doc/dev/cli/workflow.md`
**Verification:** `scripts/verify.sh` all steps passed; `npx tsc --noEmit -p .` clean in `cli/`; unit 1115 vitest + 94 bun, integration 81 vitest, 0 fail, both cohorts run at every batch commit; `cli/test/golden/matrix.json` recaptured byte-identical from a Node-hosted runner; the former `mock.module` users green under `--sequence.shuffle` at 5 seeds, `--no-file-parallelism` at 2, and solo.
**Commit:** 64243403..HEAD
**Next:** `cli-sqlite-hop` — the three production `bun:sqlite` users, the 6 fixtures, and the temporary runner in one commit.
**Blockers:** None

## 2026-08-11: the CLI's production code drops every non-SQLite Bun API

**What changed:**
- `Bun.sleepSync` → `cli/src/lib/core/sleep.ts` (`Atomics.wait` on a lock nobody notifies), `Bun.TOML.parse` → `smol-toml`, and `Bun.spawn`/`Bun.spawnSync` → `node:child_process` in the codex app-server quota probe. `cli/src/` now contains no `Bun.*` reference.
- This is the plateau, not the finish: `bun:sqlite` still backs session-id correlation, provider history, and project-move (Bun cannot load `node:sqlite`, so that hop is `cli-sqlite-hop`), `main.ts` keeps its bun shebang until the Node launcher exists, and the tests still run on `bun:test` until `cli-vitest-cohorts`.
- New `cli/src/package-root.ts` owns the single package-relative expression and the "is this process the yaco executable" test. The agent wrapper and `doctor`'s manifest resolve through it; `hook-event-bin.ts`, two unreferenced path helpers, and legacy `hook-event-bin.ts` recognition in both hook-ownership matchers are deleted.
- `tools/install.sh` installs the CLI's dependencies from an isolated copy of `cli/package.json` + `cli/bun.lock` when a trial bundle cannot resolve them, and `cli/bun.lock` lists them.

**Why:**
- Two self-invocation rungs keyed on `process.argv[0]` ending in `/yaco` could never fire: in a compiled artifact `argv[0]` is the bare string `"bun"`. An installed binary that was neither on `$PATH` nor named by `$YACO_BIN_DIR` therefore wrote the literal `"yaco"` into provider hook configs and every hook fire failed silently. `process.execPath` is the live signal, gated on the package root being unreadable — which is the same fact the asset lookups already depend on, so the two cannot disagree.
- Node reports a missing binary and a broken input pipe asynchronously where Bun raised them in place; unobserved, either is an uncaught exception that replaces a diagnosable quota failure with a crash (measured on Node 24). Teardown waits on the child's `exit`, not its `close`: an orphaned grandchild holds the stdio pipes, and `close` waits for those too — the command hung instead of reporting.
- The first runtime dependency broke the README's first-run command, because `bun build` resolves from `node_modules` and a clone that has never been installed has none. Caught by the fresh-clone integration test, not by review — and then twice more by review: installing inside `cli/` makes Bun discover the monorepo workspace and die migrating the npm lockfile, and every readiness check short of asking the bundler mistook a partial install (an empty `node_modules`, a package whose manifest arrived without its entry point) for a finished one.
- The wrapper's checkout fallback chain is deliberately kept: a compiled artifact's package root is Bun's virtual filesystem, so the corrected resolver only becomes correct for the artifact once `dist/yaco.mjs` exists. Deleting the chain now would break the installed binary.

**Key files:** `cli/src/{package-root,main}.ts`, `cli/src/lib/core/sleep.ts`, `cli/src/lib/core/agent/{lifecycle,tmux,hook-event}.ts`, `cli/src/lib/core/agent/providers/{usage,hooks}.ts`, `cli/src/commands/{doctor,agent/start}.ts`, `tools/install.sh`, `cli/bun.lock`, `package-lock.json`
**Verification:** `scripts/verify.sh` all steps passed; `npx tsc --noEmit -p .` clean in `cli/`; `bun run test` 1187 pass / 0 fail with `cli/test/golden/matrix.json` recaptured byte for byte; the integration suite green including a real `tools/install.sh` bootstrap of a dependency-free `git archive` clone; cross-provider review (Codex) and QA in `plan/all/cli-node-sdk/`.
**Commit:** 28552acf..HEAD
**Next:** `cli-vitest-cohorts` — port the tests off `bun:test` in green cohorts.
**Blockers:** None

## 2026-08-10: WhatsApp loads lazily — 626 MB of Chromium leaves the default install

**What changed:**
- `whatsapp-web.js` is now behind `whatsapp/load.ts`'s cached `await import()`, an `optionalDependency`, and the repo-root `.puppeteerrc.cjs` sets `skipDownload: true` so its puppeteer stops downloading Chromium. Absent, it reports the install command instead of a stack trace. The task brief said to move the import site in `app/server/src/index.ts` into the `if (channels.whatsapp)` gate; that alone would not have worked, because `routes/whatsapp.ts` also imports `lib/whatsapp` statically — deferring the dependency itself is the one boundary that covers every entry point, and `index.ts` needed no change at all.
- Deferring it split `initWhatsApp()` into a synchronous prologue and an async `startClient()`, which opened a window where a start is running but `client` is not yet published. Four rounds of independent Codex review found four lifecycle defects in that window and around it, each reproduced before it was fixed and each now pinned by a test that fails when the fix is removed: a stop racing the load launched a browser anyway; a retired client's events could resurrect a stopped channel; a restart during teardown either lost (before) or stole live resources (after the first fix); and `myJid` survived a session, letting a replacement answer a message before its own `ready`.
- The answer is three collaborating pieces in `whatsapp/index.ts`: `endSession()` takes every piece of per-session state synchronously before any await, `stopGeneration` supersedes a start that is still invisible and silences a retired client's callbacks, and `releaseSession()` serializes the physical teardown (destroy, logout, `rm -rf SESSION_DIR`, taps) that a successor's identical browser profile directory has to wait for.

**Why:**
- The `if (channels.whatsapp)` gate gated initialization, not loading, so every clone-install user paid 626 MB in `~/.cache/puppeteer` and every boot pulled the graph in — for a channel that is off by default.
- The lifecycle work was not scope creep for its own sake: three of the four defects were only reachable through windows this change opened, and the fourth (`myJid`) only through the restart path the third fix made work.

**Key files:** `app/server/src/lib/whatsapp/{load.ts,index.ts}`, `app/server/src/lib/whatsapp/__tests__/`, `app/server/package.json`, `.puppeteerrc.cjs`, `package-lock.json`
**Verification:** `scripts/verify.sh` green (825 server tests, 9 new). Every new test falsified by breaking its fix. Boot registry proven by child-process `require.cache` sampling, not timing — pre-fix it returns `["whatsapp-web.js","puppeteer","puppeteer-core"]`, post-fix `[]`. Live HTTP against a real server on a throwaway `YACO_HOME`: 0 Chrome with the channel off → real QR from WhatsApp plus 9 Chrome processes after `POST /enabled {true}` → 0 after `{false}`. An authenticated session and reply streaming were **not** exercised (needs a linked device; the operator declined to have their account used) — see `plan/all/cli-node-sdk/qa_whatsapp-lazy-load.md`.
**Commits:** `43300179`, `f2e756e2`, `8bbcaeb3`, `b7bb57ba`, `6d20130a`
**Next:** `app-package` (this was its blocking dependency).
**Blockers:** None.

## 2026-08-10: CLI read ordering is defined, and a golden matrix pins it

**What changed:**
- Every agent read path that enumerates a directory or resolves a tie now returns a total, name-derived order: `listStateHandles` ascending (the order behind `agent list`, `agent summaries`, every `listByPath` caller); Claude project logs and Codex rollout day directories read sorted; `finalizeHistory` ordering by recency then ascending `sessionId`, with an unparseable `updatedAt` ranked after every real timestamp instead of compared as NaN; both `threads` queries tie-breaking on `id`; equal-delay rollout selection resolving to the smallest rollout path. Comparison is by code unit — plain `.sort()`, never `localeCompare`.
- New `cli/test/golden/`: a hermetic capture harness (own `$HOME`/`$YACO_HOME`, empty `$PATH`, redacted paths) that freezes exit code, stdout, stderr, and durable `$YACO_HOME` state for 31 cases spanning help, text/JSON successes, the agent list/history/summaries/messages/status reads, task reads, paths, doctor, install, and one case per error class.
- Two matrices are committed: `matrix.original.json` captured on Bun **before** the sort (a historical artifact, never recaptured) and `matrix.json` after (recaptured and compared byte for byte by `golden.test.ts`). `ordering-delta.test.ts` holds the 23 non-order-sensitive cases byte-identical across the two and shows exactly 8 reordering.

**Why:**
- State-file enumeration was unsorted, so `agent list` row order was undefined by construction and differed between Bun and Node on the same directory. That had to be fixed *before* the Node port, or the port's golden matrix could not separate a real regression from a directory-order artifact. `doctor --json` is in the baseline from the start because it reports the package version — the port's one intentional output delta, which a baseline that omitted it could not distinguish from a regression.
- The `updatedAt` NaN fallthrough (caught in review) made the history comparator intransitive, handing the order back to the sort's internals — the exact nondeterminism being removed.

**Key files:** `cli/src/lib/core/agent/{session-state,session-id}.ts`, `cli/src/lib/core/agent/providers/{history,output}.ts`, `cli/test/golden/**`, `cli/test/unit/core/agent/ordering.test.ts`, `doc/main/cli/architecture.md`
**Verification:** `scripts/verify.sh` all steps passed; `npx tsc --noEmit -p .` clean in `cli/`; `bun run test` 1175 pass; every new assertion confirmed to fail against the pre-sort tree; QA over the real machine's 15 live sessions in `plan/all/cli-node-sdk/qa-cli-order-determinism.md`.
**Commit:** db64f544..HEAD
**Next:** `cli-portable-runtime` — the Bun-compatible plateau, against this post-ordering baseline.
**Blockers:** None

## 2026-08-10: per-skill skills links + the shipped set shrinks to 22 yaco-coupled skills

**What changed:**
- `~/.claude/skills` is now a real directory: `installGlobalLinks` plants one symlink per skill in `agent-config/global/skills/` (the listing is the manifest), migrates the legacy whole-dir symlink in place (relative targets resolved against the link's dir, not cwd), and merges additively — same-name real files/dirs are kept (never clobbered, even with `--force`), live foreign links need `--force`, dangling links are replaced. `~/.agents/skills` stays a whole-dir symlink.
- `yaco doctor`'s `skills-link` check resolves the manifest via the registry's `yaco` entry (cwd-independent) and requires every shipped skill to resolve inside the container, accepting user overrides of any shape; legacy symlink layout and non-dir manifests fail cleanly instead of throwing.
- 8 skills left the repo per `plan` bundle skill-separate: 7 personal-methodology skills (office-hours, scope-review, ux-design, self-improve, write-skill, refer, borrow) moved to the private agent-global repo (which links them back via its own `link-skills.sh`), and the `yaco` router skill was deleted (zero references). The shipped 22 = CLI companions + the `/orchestrate` runtime closure + the design cluster; `/design`'s description dropped its reference to the unshipped shape skills.

**Why:**
- The whole-dir symlink could not coexist with a user's own `~/.claude/skills` — the exact audience most likely to try yaco got a hard install failure. Per-skill links make the merge additive in both directions and let personal skills live in a separate repo.

**Key files:** `cli/src/commands/install.ts`, `cli/src/commands/doctor.ts`, their unit tests, `agent-config/global/skills/`, `README.md`, `doc/main/cli/{install,doctor}.md`, `doc/{main,dev}/agent-config/`
**Verification:** cli unit suite green (1156 pass incl. 8 new link/merge/migration tests); `npx tsc --noEmit -p cli` clean; live migration on this machine: `tools/install.sh --cli-only` → doctor 11/11, then agent-global `link-skills.sh` → 29 entries (22 yaco + 7 personal) coexisting.
**Commits:** `d1a61329`, `281539aa` (cli), `5752afaa`, `48ea7cc9` (skills), + README/docs commit
**Next:** —
**Blockers:** None.

## 2026-08-09: `yaco plan init` also writes the root `.ignore` whitelist for the plan dir

**What changed:**
- `runPlanInit` gained a step between host-exclusion and `--remote`: ensure the repo-root `.ignore` contains `!<plan>/` (plan name resolved from `[paths]`). Created when absent, appended when missing, existing lines never rewritten or reordered; `PlanInitResult.ignoreUpdated` reports it and the text render shows it.
- The line-ensure logic shared with the `info/exclude` step was extracted into one `ensureLine(filePath, entry)` helper; `ensureExcluded` now only resolves the git path and delegates.

**Why:**
- The `info/exclude` entry that hides the colocated plan repo from host git also blinds ignore-stack tools (rg, fd, agent file search) to `plan/`. A root `.ignore` negation re-includes it at higher precedence than any gitignore source, and is a no-op for tools when the plan dir is tracked. yaco itself got the line by hand (`e6893e12`); init now ensures it for every user.

**Key files:** `cli/src/commands/plan/init.ts`, `cli/test/unit/commands/plan/init.test.ts`, `doc/main/cli/plan.md`
**Verification:** `scripts/verify.sh` green (cli 1142 pass); `npx tsc --noEmit -p cli` clean; 6 new unit tests cover create/append/newline-glue/already-present/custom-plan-name/idempotency; `rg --files` E2E check on a fresh private-plan repo lists `plan/` files after init.
**Commit:** `af4f28c9` + docs commit
**Next:** —
**Blockers:** None.

## 2026-08-08: cli unit tests stop depending on the checkout path — module mocks are file-scoped

**What changed:**
- `cli/test/helpers/module-mock.ts` adds `mockSrcModule(srcPath, factory)`: it registers the mock in `beforeAll` and re-registers a snapshot of the module's real exports in `afterAll`, so the mock exists only while the calling file's tests run. Modules the file already imported still see it — ESM named imports are live bindings and bun updates a module's exports in place.
- The three files that registered mocks now go through it: `test/lifecycle-guards.test.ts` (`tmux.ts`, `lifecycle.ts`, `session-id.ts`), `test/kill.test.ts` and `test/unit/agent/reclaim-crashed.test.ts` (`tmux.ts`).
- `cli/test/unit/module-mock-scope.test.ts` fails the suite if any test file registers a module mock outside the helper. The scan is a literal substring match — no comment stripping, no lexing — so it can only over-report; anything that parses TypeScript to decide what counts can be fooled into a false negative by a string holding a comment marker.
- `test/unit/commands/install.test.ts` drops two `spawnSync` workarounds that existed only to escape the leaked mock; that file plus `doctor.test.ts` fall from ~40s to 3.2s.
- The replacement **merges**, as bun's own registration does: an omitted export keeps its real implementation. `lifecycle-guards` relies on exactly that (it never stubs `isProcessAlive`), so the semantics are documented rather than changed.

**Why:**
- `bun test` runs all 73 cli test files in one process, bun's module-mock registry is process-global, and `mock.restore()` does not undo a registration. Three files registered mocks at top level, so they rewrote what every other file imported. bun's load order follows filesystem traversal, so the suite's result depended on where the repo was checked out: green at `~/ld-workspace/yaco`, 10 failures in `hooks-install.test.ts` from a `git archive` export at `/tmp/w/yaco`, 4 failures in `tmux.test.ts` on the GitHub runner — the last of those against `resolveAgentPidFromProcesses`, a pure function.

**Key files:** `cli/test/helpers/module-mock.ts`, `cli/test/unit/module-mock-scope.test.ts`, `cli/test/lifecycle-guards.test.ts`, `cli/test/kill.test.ts`, `cli/test/unit/agent/reclaim-crashed.test.ts`, `cli/test/unit/commands/install.test.ts`, `doc/dev/cli/workflow.md`
**Verification:** `bun run test:unit` green in the worktree and in a fresh `git archive` export at `/tmp/w/yaco` (10 failures there before); each previously-failing file green standalone at both paths; on a pinned checkout, `bun test --randomize --seed=1..5` over the mocker+victim set is 10/10 runs green, where the same set before the fix failed 10/0/1/1/14 tests by seed; guard verified to fail closed against planted offenders; `npx tsc --noEmit -p cli` clean.
**Commit:** `c92f248a`, `893f002f`, `aeddbbf2`, `cec91afd`
**Next:** `test/state.test.ts` has within-file env-var order coupling that only `--randomize` exposes (present before this change) — a separate fix.
**Blockers:** None

## 2026-08-08: A fresh clone with no `plan/` installs green — `task-graph` skips

**What changed:**
- `checkTaskGraph()` (`cli/src/commands/doctor.ts`) reports **`skip`** instead of `fail` when the repo's task store is absent, with a detail that names the resolved path and how a graph gets created (`` `yaco task set` ``). `REQUIRED_CHECKS` is still the same 11 names.
- Nothing else moved: `runAllChecks` already counted `skip` in neither summary bucket, so `summary.fail` stays 0, `yaco doctor` exits 0, and install's one-line `summary.fail > 0` bail (`cli/src/commands/install.ts`) passes untouched.
- **Absent is the zero state; unreadable is breakage.** The skip fires only for a path that is genuinely not there. A store that is there but unresolvable fails and says why: a symlink dangling at a moved/extracted store **at any depth** (`plan` or `plan/tasks`), a permission wall, a graph that loads but does not validate — and a `--repo` that does not exist at all.
- `doc/main/cli/doctor.md` documents the skip state as a store-state table and drops the last of the stale twelve-check/`claude-md-link` text; `doc/main/cli/README.md`, `doc/dev/cli/workflow.md`, and the root README's `task-graph` sentence follow.

**Why:**
- The public tree is history-scrubbed of `plan/`, so a fresh clone has no task store at all. Doctor failed that check, install bails on any failing check, and `tools/install.sh` therefore exited non-zero on the exact first-run flow the README promises — the release blocker.
- A repo nobody has planned yet is not a broken repo. Doctor already had the status for "nothing to check here"; using it is the whole fix. The alternatives — an `--allow-missing-task-graph` flag, or teaching install to ignore one named check — both add a knob for a state that is simply normal, and the second turns a one-line gate into a per-check policy table.
- The unreadable/absent split is not pedantry, and `existsSync` cannot draw it: it denies a dangling symlink exactly as it denies a missing path. Worse, `loadTasks()` returns `{}` for a path it cannot see and an empty graph validates — so a `plan/tasks` symlink dangling at an extracted store reported **pass** before this task. Pointing the plan root outside the public tree is precisely how a repo separates its plan, so the probe now `lstat`s up to the nearest component that exists and fails naming it.
- The `--repo` wire-through tests in both `doctor.test.ts` and `install.test.ts` used "a repo with no task store" as their *failure* fixture; that fixture is now the skip case, so both were re-fixtured onto a present-but-invalid graph. They still prove the same thing — a failure detail naming the `--repo` target, not cwd.

**Key files:** `cli/src/commands/doctor.ts`, `cli/test/unit/commands/{doctor,install}.test.ts`, `cli/test/integration/install.test.ts`, `doc/main/cli/doctor.md`, `doc/main/cli/README.md`, `doc/dev/cli/workflow.md`, `README.md`, `plan/all/release-recap/oss-doctor-fresh-clone-{plan,review,qa}.md`
**Verification:** `scripts/verify.sh` green at every commit; `npx tsc --noEmit -p cli` clean; cli 1133/1133. New `tools/install.sh` integration case runs the README entry point on a `git archive` export with no `plan/`, doctor **enabled** — the pre-existing bootstrap case passes `--skip-doctor` against a checkout that has a `plan/`, so it could not catch this. E2E QA (`oss-doctor-fresh-clone-qa.md`) — a real `git clone` with `plan/` removed, installed under an isolated `HOME`/`YACO_HOME`/`YACO_BIN_DIR`/`PATH`: `tools/install.sh --cli-only` exits **0**, `yaco doctor` exits **0** at `10 pass, 0 fail` with the `task-graph` skip, and the real `~/.claude`, `~/.codex`, `~/.yaco`, `~/.local/bin/yaco` are byte-identical afterwards. Cross-provider Codex review (`oss-doctor-fresh-clone-review.md`): **APPROVE**, 0 critical / 0 high after four rounds — it drove the three boundary fixes above (leaf dangling link, ancestor dangling link, missing `--repo`).
**Commit:** `c6cce7d6..3ff195b1` (4 commits)
**Next:** remaining `oss-release-v0.1` tasks. `oss-doc-cleanup`'s doctor-doc slice is done here; its `install.md` / `agent-config/architecture.md` slice is not.
**Blockers:** None.

## 2026-08-08: Lockfile sync — react-arborist 3.8.0 → 3.16.0

**What changed:**
- Refreshed one `package-lock.json` entry (`version` / `resolved` / `integrity`) via `npm update react-arborist --package-lock-only`. No `package.json` touched anywhere; 3.16.0's `dependencies` and `peerDependencies` are identical to 3.8.0's, so no transitive entry moved.
- Corrected `doc/main/app/ui/workspace/explorer-and-changes.md`: the explorer's custom `handleClick` override was justified there by "3.5.0 only checks `metaKey`", which 3.16.0's `NodeApi.handleClick` (it handles `metaKey || ctrlKey`) makes false. The override is still required — it stops a modifier click from falling through to preview-open / dir-toggle.

**Why:**
- A clean `npm ci` installed 3.8.0 while `app/ui/src/components/FileExplorer.tsx:458`'s `onCreate` is written against 3.16.0's `CreateHandler` (which may return the created node). `package.json`'s `^3.4.3` permitted both, so every local `node_modules` ran 3.16.0 and only fresh clones broke — `npx tsc -b` failed TS2322 and `npm run build` failed with it. External contributors and the new CI workflow could not go green.
- Updated the lock rather than rewriting the component down to the 3.8.0 signature: 3.16.0 is the release that added the return-the-node behavior the component's `idAccessor="path"` design relies on.
- The rest of the lock↔`node_modules` drift (129 installed-version mismatches, plus 79 locked-but-absent packages of which 68 are other-platform optionals) was deliberately left alone — a reviewable one-entry diff beats an unreviewable ~200-entry one on a release branch, with no failure to justify it.

**Known gaps (out of this task's declared `package-lock.json` scope):** `app/ui/package.json` still declares `react-arborist: ^3.4.3` though the source needs 3.16.0; `app/ui/package-lock.json` and `app/server/package-lock.json` are tracked, stale since 2026-06-03, and inert (both are root `workspaces` entries, so `cd app/ui && npm ci` installs the root project and never reads them); and `fileExplorerNode.tsx`'s comment repeats the stale 3.5.0 rationale. All three want one follow-up under `oss-release-v0.1`.

**Key files:** `package-lock.json`, `doc/main/app/ui/workspace/explorer-and-changes.md`, `plan/all/release-recap/oss-lockfile-sync-{plan,review,qa}.md`
**Verification:** Hermetic export (`git archive` → a short non-`/tmp` path, no `node_modules`) + fresh `npm ci`: `npm ci` exit 0 installing react-arborist 3.16.0; `app/ui` `npx tsc -b` and `npm run build` exit 0 (**both were red before**); `app/ui` lint 0 errors; `app/ui` vitest 1180/1180; `cli` bun test 1125/1125; `app/server` 795/795; 18/18 File-Explorer Playwright specs green, including all four `file-create` specs that drive the `CreateHandler` API that differs between the two versions. `scripts/verify.sh` green in-worktree. Cross-provider Codex review (`oss-lockfile-sync-review.md`): APPROVE, 0 critical / 0 high; it independently recomputed the tarball SHA-512 against the lock's `integrity`.
**Commit:** `2d71bd82`
**Next:** the follow-up above; then the remaining `oss-release-v0.1` publish tasks.
**Blockers:** None.

## 2026-08-08: Root MIT LICENSE and publish-guard package metadata

**What changed:**
- Added root `LICENSE` — the verbatim OSI/SPDX MIT text, `Copyright (c) 2026 Qi Guo`. Byte-diffed against an upstream MIT `LICENSE` and found character-identical modulo the copyright line, so SPDX/licensee scanners match it.
- Filled `description` / `license` / `repository` in root `package.json` and `cli/package.json`; `cli` also carries `directory: "cli"` since it is a monorepo subdirectory. `package-lock.json` picks up two derived `"license": "MIT"` lines because npm mirrors that field into the lock's root and workspace entries.
- `"private": true` **deliberately retained** in both manifests — it is a load-bearing publish guard, not leftover scaffolding. Do not remove it while adding npm metadata.

**Why:**
- v0.1 ships via `git clone` + `tools/install.sh`, not npm: `cli`'s `bin` points at a TypeScript entry that node cannot execute, so publishing would ship something broken. Real per-platform binary distribution is its own project.
- MIT over Apache-2.0 because the dependency census came back MIT 617 / ISC 69 / Apache-2.0 42 / BSD-3 19 / BSD-2 13 / BlueOak 6 / MPL-2.0 4 / MIT-0 2 with **zero GPL/AGPL/SSPL** — no compatibility constraint to work around, and an explicit patent grant only adds reading cost for a v0.1 personal dev tool.
- Holder is the legal-name form `Qi Guo`, not the `qiguo` shell username or the `imoonkey` handle; a single-year 2026 needs no range since the first commit is 2026-03-04.

**Known gap (deliberately out of this task's scope):** `app/server/package.json` carries no `private: true`, so `npm publish --workspaces` prepares `yaco-server@0.0.1` — the only workspace not skipped. Tracked against the `oss-release-v0.1` milestone.

**Key files:** `LICENSE`, `package.json`, `cli/package.json`, `package-lock.json`, `plan/all/release-recap/`
**Verification:** `scripts/verify.sh` green. Cross-provider Codex review (`review-oss-license-mit.md`) — 0 critical / 0 high in scope. QA on a hermetic `git archive` fresh clone plus an isolated-`HOME` run (`qa-oss-license-mit.md`): LICENSE ships at root with 3/3 canonical MIT anchors, workspace graph resolves with no further lock drift, publish refused for root/cli/ui/codex-transcribe, `yaco doctor` still parses `cli/package.json` to `0.1.0` rather than its silent `0.0.0` fallback, and the `@yaco/cli/core/*` exports still resolve for `app/server`.
**Commit:** `5e8a8313`
**Next:** `oss-readme-rewrite` — the root README still has no license section and no runtime prerequisites.
**Blockers:** None

## 2026-08-07: `yaco install` is purely additive — global CLAUDE.md left the repo

**What changed:**
- Deleted `agent-config/global/CLAUDE.md`. It holds the maintainer's personal global agent rules and now lives in a separate private repo, symlinked in by hand.
- `installGlobalLinks` (`cli/src/commands/install.ts`) no longer writes `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`. It plants only `~/.claude/skills` and `~/.agents/skills`. The "is this a YACO checkout" precondition moved from the deleted file onto `agent-config/global/skills/`, keeping the same `ENV` refusal for a wrong `--repo`.
- `yaco doctor` dropped the `claude-md-link` check. `REQUIRED_CHECKS` is now **11** names, a deliberate change to a published contract.

**Why:**
- The two dropped symlinks made install a *takeover*, not an addition: a stranger running `tools/install.sh` had their own `~/.claude/CLAUDE.md` claimed (refused on conflict, but `--force` rewrote it). `~/.claude/skills` was always additive — removing the instruction-file half leaves only that behavior, which is the only half that is defensible for an outside user.
- The file and the wiring had to move together: install hard-required the file, so deleting it alone would have made every install fail `ENV`.
- `skills/` is the better checkout marker anyway — it is what install actually links, so the precondition now guards the thing it is about to use.

**Key files:** `cli/src/commands/install.ts`, `cli/src/commands/doctor.ts`, `cli/test/unit/commands/{install,doctor}.test.ts`, `cli/test/integration/install.test.ts`, `agent-config/global/skills/init-all/SKILL.md`, `plan/all/release-recap/`
**Verification:** `scripts/verify.sh` steps all green (`npx tsc --noEmit -p cli` clean; cli 1125/1125 at `--timeout 30000`; server 795/795; ui lint 0 errors; root build OK). Codex cross-provider review of `c22f3ba6`: APPROVE, 0 findings. E2E QA 27/27 — real `tools/install.sh` on a fresh `git clone` under an isolated `HOME`: install exits 0 without the deleted file, a pre-existing `~/.claude/CLAUDE.md` stays byte-identical (including under `--force`), `~/.codex/AGENTS.md` is never created, doctor reports 11/11 green.
**Commit:** `c22f3ba6`
**Next:** `oss-doc-cleanup` syncs `doc/main/cli/{install,doctor}.md` and `doc/main/agent-config/architecture.md`; `oss-readme-rewrite` syncs the root README's 12-check list. Both depend on this task and deliberately still describe the old wiring.
**Blockers:** None in code. The human still has to host the extracted `CLAUDE.md` in its private repo and `ln -s` it on both machines — deferred by design, recoverable from git history at `a17bd086`.


## 2026-08-07: Rewrite the root README for a first-time reader

**What changed:**
- Replaced the maintainer-facing source map in `README.md` with a README written for someone who has never seen YACO: product positioning (an orchestration layer over Claude Code / Codex, never an agent itself), a requirements table, the source-install path, a first-run walkthrough, the `plan/` story, and a Development section in place of a `CONTRIBUTING.md`.
- Documented the three runtime prerequisites that were written down nowhere in the repo — bun (`tools/install.sh` hard-requires it), node + npm (`yaco install` runs `npm install` in `app/server` and `app/ui`), and the `node-pty` native-build toolchain — plus tmux and git, which `yaco doctor` already checks.
- Recorded install behavior a stranger cannot infer: a missing provider CLI makes the closing `yaco doctor` fail, which makes the whole bootstrap exit non-zero *after* it has mutated the machine, and the install is not transactional. The step list follows the real side-effect order (wrapper → hooks → links → app npm installs → registry → doctor).
- Corrected the `plan/` narrative: `plan/` is the user's own directory, committed with the code by default; `yaco plan init` makes it a separate colocated repo but does **not** untrack what the host already committed and does not make any remote private. YACO's own private `plan/` is called out as the exception, and the README no longer implies the public repo carries live plan history.

**Why:**
- `oss-release-v0.1` puts this repository in front of people with no context. The previous README answered "where does the code live" for a maintainer and answered none of "what is this", "what do I need", "what do I run first" — and the prerequisites gap alone would stop a stranger at the first command.

**Key files:** `README.md`
**Verification:** `scripts/verify.sh` green; `app/ui` component tests (1180) green; every command, flag, path and port in the README traced to the source that implements it; link and personal-literal sweep clean; independent cross-provider (Codex) review, two rounds, artifact at `plan/all/release-recap/oss-readme-rewrite-review.md`.
**Commit:** a2f3c924..HEAD
**Next:** `oss-license-mit` adds the `LICENSE` the README links to; `oss-doc-cleanup` sweeps `doc/` for the same public-repo framing.
**Blockers:** None

## 2026-08-08: Narrow Linux CI

**What changed:**
- Added `.github/workflows/ci.yml`, the repository's first CI. One `ubuntu-latest` job on push-to-`main` and pull request: root `npm ci`, then `cli` bun test, `app/server` test, and `app/ui` typecheck + lint + build.
- Documented the workflow and its exclusions under "Continuous integration" in `doc/dev/README.md`.

**Why:**
- The README promises `cd cli && bun run test`, `cd app/server && npm test`, and `cd app/ui && npm run lint`. With the repo about to be public and no CI, the first external clone would have been the test environment for those promises.
- The Playwright e2e suite is excluded on purpose: four specs are red on `main`, and a red badge on launch day is worse than no badge. `cli`'s `test:integration` is excluded because it runs `tools/install.sh`, which mutates the host's `~/.claude` / `~/.codex` / `~/.yaco`.
- Every step is the verbatim command a contributor runs, so a local pass and a CI pass mean the same thing.

**Key files:** `.github/workflows/ci.yml`, `doc/dev/README.md`, `plan/all/release-recap/oss-narrow-ci-plan.md`, `plan/all/release-recap/oss-narrow-ci-review.md`
**Verification:** Every step run twice — in this worktree and in a clean `git archive` + `git init` + `npm ci` checkout that simulates `actions/checkout`. Clean checkout: `npm ci` exit 0 (745 packages), cli 1122/1122, app/server 795/795 across 46 files, eslint 0 errors. Independent Codex review validated the workflow with `actionlint 1.7.12`, resolved each action's `action.yml`, and confirmed no step reaches Playwright — zero findings against `ci.yml`.
**Commit:** This commit
**Next:** Enable the workflow's badge and discharge "green on the release SHA" once the repo has a GitHub remote.
**Blockers:** `app/ui` typecheck and build are red on a clean `npm ci` — root `package-lock.json` pins `react-arborist@3.8.0` while every local `node_modules` and `FileExplorer.tsx:458` are written against `3.16.0`. Pre-existing `main` debt surfaced by this task, out of its `.github/workflows/**` scope; CI cannot go green until the lockfile is refreshed.


## 2026-08-07: Trusted hostnames come from the environment, not the source

**What changed:**
- `DEFAULT_ALLOWED_HOSTNAMES` and the Vite dev server's `allowedHosts` both hardcoded one deployment's tailnet names. Shipped defaults are now `localhost`, `::1`, `.local`, and private-LAN addresses only; a deployment names its own hosts in `YACO_ALLOWED_HOSTNAMES`, which the API server and Vite read with the same syntax from separate sources — `app/server/.env` for the backend, the service environment for Vite. A leading-dot entry allows the subdomains of a domain; Vite additionally admits the bare domain, the one place the two deliberately differ.
- Origin validation moved out of `index.ts` into `server/src/lib/origin.ts` as `createOriginGuard(env)`, with 21 tests. `index.ts` starts a server on import, so the guard was untestable where it lived — extracting it is what made the env behavior checkable.
- `app/scripts/services.sh` bakes the variable into the generated systemd unit and launchd plist for the `ui` service alone — anywhere else it would outrank `app/server/.env` permanently — and refuses a value that is not a hostname list.
- `skills/refer` no longer hardcodes one machine's reference-library path; it reads `$REF_LIB`.

**Why:**
- OSS release prep: shipped code carried a real Tailscale identity. Anyone publishing the repo publishes those names, and anyone cloning it inherits an allowlist for hosts they do not own.
- Two defects surfaced while closing it. A leading-dot entry with no domain (`.`) matched every hostname a browser writes with the DNS root dot, and briefly matching Vite's wider "domain and its subdomains" reading made the shipped `.local` default trust a bare `local` origin. Both are now narrowed and pinned by tests. Separately, `new URL('http://[::1]').hostname` is `'[::1]'`, so the long-standing `::1` default had never actually matched.
- Generating the service env unconditionally would have shadowed `app/server/.env`, since `dotenv` leaves a key alone once it is present.

**Key files:** `app/server/src/lib/origin.ts`, `app/server/src/index.ts`, `app/ui/vite.config.ts`, `app/scripts/services.sh`, `doc/main/app/security.md`, `doc/dev/app/workflow.md`, `agent-config/global/skills/refer/SKILL.md`
**Verification:** `scripts/verify.sh` green. Integration QA against a live server process — CORS responses and WebSocket upgrades for configured, default, and hostile origins — plus `services.sh install` into a temp HOME with the platform tools shimmed (`systemd-analyze verify` on the generated units), and the `app/ui` Playwright suite. Counts and per-flow results in `plan/all/release-recap/oss-personal-literals-qa.md`; the independent Codex review and its rounds are in `plan/all/release-recap/oss-personal-literals-review.md`.
**Commits:** `f4463fb0`..`HEAD` on `task/oss-personal-literals`
**Next:** `oss-global-claude-extract` removes `agent-config/global/CLAUDE.md`, the last personal literal in the repo. Reaching the app over the real tailnet with the variable set stays a human check.
**Blockers:** None

## 2026-07-29: Selectable Codex and Groq voice transcription

**What changed:**
- Added the deep `@yaco/codex-transcribe` workspace package. It reads the existing Codex-owned ChatGPT OAuth metadata on each operation, sends the pinned Desktop header/multipart contract to the hidden batch transcription endpoint, and exposes stable error codes without logging credentials, audio, transcript, or upstream bodies.
- Changed `/api/voice/status` to report Codex and Groq STT plus formatter capabilities independently; `/api/voice/transcribe` now requires `provider=codex|groq` and has no implicit default or failover.
- Added persisted provider and Auto format controls to the compose tray. An in-flight take freezes both choices; after a failure the user can explicitly switch provider and Retry the same cached audio.
- Added a default-off, environment-only live runner whose JSON Lines output is limited to status, MIME, attempt, and latency.

**Why:**
- Codex-authenticated users can reuse their existing local login for raw transcription without running cproxy or copying OAuth credentials into YACO, while Groq remains an explicit supported alternative and the formatter stays optional.
- The ChatGPT endpoint is hidden and can change. Explicit provider provenance, typed 401/403/429 handling, a retained Groq path, and an opt-in live probe constrain that risk without browser cookies, Cloudflare challenge code, token refresh ownership, or silent provider switching.

**Key files:** `packages/codex-transcribe/`, `app/server/src/routes/voice.ts`, `app/ui/src/hooks/useVoice.ts`, `app/ui/src/components/ComposeTray.tsx`, `plan/all/20260729_codex-transcribe/`
**Verification:** `scripts/verify.sh` green; package 75/75; focused server 71/71 and UI 21/21; isolated voice Playwright 7/7. Synthetic live QA: macOS Codex 10/10 across WebM/Opus and MP4/AAC, Linux Codex 2/2, and both Codex/Groq produced non-empty expected-phrase matches without logging transcripts.
**Commits:** `32d29671`, `76fb755d`, `447941db`
**Next:** Keep the opt-in live runner as the explicit signal if the hidden endpoint or Desktop header allowlist changes.
**Blockers:** None

## 2026-07-27: CSV/TSV files preview as a sortable table

**What changed:**
- `.csv`/`.tsv` joined `isPreviewableFile`, so the existing Edit/Split/Preview toggle now drives a third renderer, `DelimitedPreview`, beside markdown and HTML. Parsing is `papaparse` (`delimitedTable.ts`): quoted delimiters/newlines, CRLF and BOM handled, tab pinned for `.tsv` and sniffed for `.csv`, and ragged rows squared to the widest row so cells never shift columns.
- Sorting via `@tanstack/react-table` (headless — the markup and Solarized styling stay ours), every column on the `alphanumeric` sort function. Overflow toggles clip↔wrap from the status bar; columns drag-resize from a per-header grip (double-click resets) through a `col → px` map the grid template mixes with the content-derived `ch` widths. Rows band by display position.
- Rows render through a `memo`'d `DelimitedRow` taking only per-row-stable primitives, `overscan` 16 → 6, and the row-number gutter is deliberately **not** frozen.
- `.markdown-preview` and the CSV preview root both opt back into `user-select: text`.

**Why:**
- React Compiler skips this component (both TanStack hooks return functions it cannot memoize safely), so the virtualizer was reconciling ~50 rows × 13 cells on every scroll frame — the reported jank. Freezing the gutter adds a sticky element *and* a stacking context per rendered row, which measured at ~6ms of p95 frame time; a frozen gutter is worth doing only as one sticky overlay column outside the row markup.
- Cell text could not be selected or copied at all: `DesktopPanelTreeLayout` sets `select-none` so its hand-rolled pane drags don't paint a selection, and that inherits into every panel — reading surfaces have to opt back in the way `TerminalPanel` already did. `.markdown-preview` carried the same latent bug and was fixed in the same pass.
- Column widths in `ch` are why react-table's `columnSizing` is unused: it is px-only and would need the auto-widths converted to seed values.

**Key files:** `app/ui/src/workspace/{DelimitedPreview.tsx,delimitedTable.ts,WorkspaceEditorArea.tsx,WorkspaceEditorColumn.tsx}`, `app/ui/src/lib/binaryFiles.ts`, `app/ui/src/index.css`
**Verification:** `scripts/verify.sh` green (one CLI `project move` timeout on the first run was a flaky 5s limit under load — 20/20 in isolation, and the diff touches no CLI file). 1161 app/ui unit tests, `npx tsc -b` clean. 7 e2e: sorting spans the whole file (asserts the file's *last* line surfaces first, so a window-only sort fails), real header-grip drag + double-click reset, wrap re-measurement (a row must move below a grown one), and selection in both previews — the markdown one was confirmed to FAIL without its fix. Scroll measured with a scripted-scroll harness at 4× CPU throttle, 5 trials on 3000×12: p50 25.8 → 17.0ms, p95 37.3 → 25.8ms, frames over 32ms 12/90 → 2/90.
**Commit:** 651a2ec7
**Next:** Wrap mode and column widths are component-local view state; carrying them on the tab means extending `GroupTab` alongside `previewMode`. A frozen row-number column, if wanted, needs the single-sticky-overlay restructure. Cell editing was scoped out — the cost there is the state contract (`Papa.unparse` back into the shared text draft, which normalizes quoting), not the widget.
**Blockers:** None

## 2026-07-26: Switching a terminal tab stops costing a second

**What changed:**
- `PanelGroup` keeps recently visited TERMINAL tabs mounted (MRU, cap 6 bodies/group) and renders the inactive ones `invisible` + `inert`; only the active wrapper carries `data-instance-id` / `data-panel-leaf` / the focus markers. Editors still mount only when active. Desktop only by construction — mobile goes through `MobilePanelProjection`.
- `Terminal` gained a `visible` flag (published on `PanelInstance` by `PanelHost`): the visible edge takes focus, sends the size the pane reached while hidden, and resumes a dropped socket; while hidden it refits locally but sends no resize, and `createWs` refuses to attach at all.
- `attachSession()` batches its tmux commands into one invocation each (`;` separates commands in argv) and no longer awaits the post-spawn resize. The startup buffer from 89d43ea4 and `AttachedSession.initialData` are gone — with nothing awaited between the spawn and the return, the caller's subscription (a microtask later) already precedes every PTY I/O turn.

**Why:**
- A group mounted only its active tab, so switching disposed the xterm, closed the WebSocket, and let the server kill the PTY and detach tmux. Switching back paid ~3 RTT of wss handshake — the browser is 107ms away over Tailscale — plus a ~110ms attach. Measured decomposition of the ~1s: 330ms handshake + 110ms attach + 55ms for the paint to come back + xterm rebuild.
- Every tmux CLI call costs ~30ms whatever it carries (client startup + server round trip), and five of them sat on the attach path.
- Two hazards the keep-alive introduced, both found by the codex reviewer and both reproduced before fixing: Chromium keeps a focused descendant focused (and keeps delivering `keydown`) when an ancestor merely turns `visibility:hidden`, so a hidden terminal swallowed keystrokes into a live PTY; and a hidden pane's resize or re-attach ran `tmux resize-window`, resizing the window under another device viewing the same session (reviewer measured 120x39 → 90x29 on tmux 3.5a).

**Key files:** `app/ui/src/workspace/{PanelGroup,PanelHost,panelInstance,panelLayoutModel}.*`, `app/ui/src/components/Terminal.tsx`, `app/ui/src/workspace/panels/TerminalPanel.tsx`, `app/server/src/lib/terminal.ts`, `app/server/src/index.ts`
**Verification:** Server WS-open-to-first-byte against the restarted live server: 103–124ms → 39–68ms (agent sessions), ~80ms for shell sessions. `tests/e2e/terminal-keepalive.spec.ts` pins that a switch opens NO new WebSocket, keeps the scrollback, moves focus, and leaks no keystroke into a hidden pane. Every added test was verified to FAIL without its fix (including one first-draft test that was vacuous and got fixed). Full Playwright suite 187 passed / 1 flaky / 4 failed — the same 4 fail on the pre-change source, so they predate this work. `scripts/verify.sh` green.
**Commits:** d48df0f1, 211fa680
**Next:** A socket the server accepts in the same instant its pane hides has already sized the window; the client detaches immediately and tmux restores the visible client's geometry. Removing that transient needs the server to defer tmux sizing until the first client resize. Separately: the 4 pre-existing e2e failures on main are unowned.
**Blockers:** None

## 2026-07-26: Terminal tabs paint on attach instead of 5s later

**What changed:**
- `attachSession()` subscribes to the PTY in the same tick as `pty.spawn()`, buffers what tmux emits while the `resize-window` / `set-option` round-trips are in flight, and returns it as `initialData` — disposing that subscription synchronously with the `return` so the caller's own subscription takes over without a gap.
- The WS handler routes `initialData` through the same `forward()` as live output (OSC responder included) right after registering `proc.onData`, instead of `ws.send()`-ing it raw further down.

**Why:**
- Opening or switching to a terminal tab showed a blank pane for ~5s — only the regions the running TUI repainted itself were visible. Measured at the WS: nothing but 15-byte incremental writes until a 1.4 KB full repaint at **+5072ms**.
- Cause: node-pty emits data whether or not anyone is listening, and `proc.onData` was registered only after `await attachSession(...)` returned — two tmux subprocess round-trips later. tmux's attach burst lands at **~30ms** and carries both the full repaint and its capability queries (`\e[c`, `\e[>c`, `\e[>q`, `\e]10;?`, `\e]11;?`); all of it was dropped. With the queries lost, tmux then sat out its 5s query timeout before repainting on its own — that timeout, not any app logic, was what eventually filled the screen.
- Routing the buffer through the OSC responder (rather than raw) keeps the server the one answering tmux's color queries for Codex sessions, as it already is for live output.

**Key files:** `app/server/src/lib/terminal.ts`, `app/server/src/index.ts`, `app/server/src/lib/__tests__/terminal.test.ts`
**Verification:** Same WS probe against the restarted live server: full 4523-byte repaint at **+95ms** (was +5072ms). Isolated the mechanism first with a bare node-pty attach — subscribing immediately captures the burst at +32ms, subscribing 100ms late loses it entirely. New regression test drives a fake pty with real "no listener → dropped" semantics and asserts the burst is captured once and live output exactly once. `app/server` 778/778, `tsc` at its 77-error baseline (unchanged).
**Commit:** 89d43ea4
**Next:** tmux still issues a redundant repaint at its 5s timeout when a query goes unanswered (harmless — the screen is already correct). Worth checking whether xterm.js answers DA2/XTVERSION if it ever matters.
**Blockers:** None

## 2026-07-26: Fix the WeChat turn-off deadlock

**What changed:**
- `resetLoginState()` now always succeeds. It bumps a generation counter and drops `inflight`; the abandoned SDK login keeps running but a stale generation stops it writing state, calling `initWeChat()`, or restoring the `console.log` interceptor a newer flow installed over it.
- `POST /api/wechat/enabled {false}` and `POST /api/wechat/logout` cancel an in-flight login instead of returning 409. `isLoginInflight()` had no remaining callers and was deleted.

**Why:**
- Turning WeChat off while its QR was on screen returned `409 login flow in progress; cancel it first` — and there was no way to cancel: `resetLoginState()` opened with `if (inflight) return`, so `POST /login/reset` was a no-op in exactly the state it was needed. `sdkLogin()` resolves only when the user scans, so an unscanned QR held `inflight` forever. The channel could not be stopped by any route.
- The guard was inverted in principle, not just incomplete. A stop action is the user's explicit instruction to end what is running; gating it on "something is running" can only ever produce a trap. `/logout` carried the same guard before this work — the new `/enabled` inherited it by being modelled on it.

**Key files:** `app/server/src/lib/wechat/login-flow.ts`, `app/server/src/routes/wechat.ts`
**Verification:** Reproduced against the live server — with `phase=awaiting-qr` and a QR present, turn-off previously returned 409 and now returns `enabled=false, phase=idle` and persists; logout likewise; re-enabling and logging in again reaches `awaiting-qr`, proving the slot is released rather than wedged. 6 new unit tests drive a `sdkLogin` that never settles (the real unscanned-QR state); 4 of them were confirmed to **fail against the old `resetLoginState`** and pass after, so they discriminate. `app/server` 777/777, `tsc` at its 18-error baseline.
**Commit:** pending
**Next:** The primary button still renders as a disabled "Re-scan" while a QR is live, so abandoning a login in place (without toggling the channel off and on) has no affordance. `/wechat/login/reset` now works and could back one; WhatsApp has no equivalent route, so doing it symmetrically needs a decision first.
**Blockers:** None

## 2026-07-26: Messaging channels switch on and off from the UI

**What changed:**
- `channels/enabled.ts` persists `{ wechat, whatsapp }` to `${YACO_HOME}/channels/enabled.json`. Absent/unreadable/malformed reads as every channel OFF, and only a literal `true` enables one; writes are read-modify-write + temp/rename.
- `POST /api/{wechat,whatsapp}/enabled` takes `{enabled}`, persists it, then boots the channel or shuts it down. `WHATSAPP_ENABLED` / `WECHAT_ENABLED` are gone — the file is the only source of truth, and boot reads it too.
- The channel dialog gained the switch, and now separates two operations that were previously conflated by having only one: **Turn off** stops the channel and frees its memory while keeping the pairing on disk, **Unlink** (was "Logout") drops the pairing and forces a fresh QR. Both carry hover text saying which is which.
- `ChannelsHeaderButton` now always renders. It used to return null when no channel was enabled, which — once the switch moved into the dialog — would have left no way to turn one back on.

**Why:**
- Toggling a channel meant editing `app/server/.env` and restarting the backend. The cost is worth managing at runtime: WhatsApp's puppeteer Chrome is 12 processes and **452 MB of the server cgroup's anonymous memory** (measured 772 MB → 320 MB), and it is charged against `yaco-server`'s `MemoryMax` because those processes are its children.
- Off had to mean "release resources", not "log out". The existing `logoutWhatsApp()` does `rm -rf` on the session dir, so reusing it would have forced a QR scan on every re-enable; `shutdownWhatsApp()` destroys the client and leaves the pairing, which is what a switch should do.

**Key files:** `app/server/src/lib/channels/enabled.ts`, `app/server/src/routes/{whatsapp,wechat}.ts`, `app/server/src/index.ts`, `app/ui/src/components/WeChatLoginDialog.tsx`, `app/ui/playwright.config.ts`

**Verification:** Full cycle against the live server: off → 12 Chrome processes to 0, cgroup anon 772 MB → 320 MB, `channels/whatsapp/session/` intact, file reads `{"wechat":true,"whatsapp":false}`; on → back to `phase=ready` with **no QR at any point** and the same `boundChat`. 7 new unit tests (one deliberately anchors the others by proving the reader looks where the fixture writes, since "off" is also what a not-found file returns). `app/server` 771/771, `app/ui` 1126/1126, both typechecks clean, all doc links and anchors resolve.
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-07-26: Service memory limits resized from cgroup peaks, swap forbidden

**What changed:**
- Raised the `SERVICES` bounds — `server` and `ui-build` to 2G/3G, `ui` to 1G/2G — and added `MemorySwapMax=0` to the unit template.
- Documented in `doc/dev/app/workflow.md` how to size these (cgroup `memory.peak` + `memory.stat` anon/file split, not `ps` RSS) and that they bound only the three units, never agent sessions.

**Why:**
- The first pass sized the limits from the Node process's RSS, but `MemoryMax` governs the whole cgroup. `yaco-server`'s cgroup also holds the WhatsApp puppeteer Chrome fleet (~950 MB RSS across 7 processes; 639 MB of the cgroup's anon), and `ui-build`'s observed peak was **1283 MB against a 1024 MB ceiling** — the next full rebuild would have been OOM-killed, and since vite empties `dist/` per rebuild that could have left `/` serving nothing. No kill had happened yet (`memory.events` all zero), so this was caught before it bit.
- `MemorySwapMax=0` is the right way to spend a 62 GB box's headroom: the stall being fixed was a major GC faulting ~900 MB back from a swap *file*, so forbidding swap for these units makes GC always RAM-speed regardless of heap size. Raising the ceiling instead would have made the failure worse, not better — a bigger allowance is a bigger stall. `vm.swappiness` is already 10, so the eviction came from a genuine pressure episode, not kernel policy; swap is sticky, which is why 6.5 GB stayed occupied with 43 GB free.

**Key files:** `app/scripts/services.sh`, `doc/dev/app/workflow.md`
**Verification:** Applied live by `services.sh install` + `daemon-reload` with **no restart** — `yaco-server` kept pid 4066578, 9 tmux sessions intact, `/api/health` 1-30ms. Headroom over observed peak is now 3.3x (`server`, 943 MB) and 2.4x (`ui-build`, 1283 MB); `memory.swap.max=0` on both. Confirmed agents are unaffected: a running `w-fr-hxz-implementation` sits in the tmux transient scope with `memory.max=max`, and every parent slice up to `user.slice` is also `max`.
**Commit:** doc + script only
**Next:** None
**Blockers:** None

## 2026-07-26: Service memory limits rolled out from the SERVICES table

**What changed:**
- Ran `app/scripts/services.sh install`, so the generated systemd units now carry `MemoryHigh`/`MemoryMax` themselves, and deleted the hand-written `~/.config/systemd/user/yaco-{server,ui-build}.service.d/memory.conf` drop-ins that had been holding the values since the fix landed. Supersedes the **Next** of the entry below.
- `yaco-ui` came through `install` still `disabled` + `inactive`, confirming the new `autostart=no` path both skips enabling and actively disables a demoted unit.

**Why:**
- Two sources for the same limit is one that drifts. The table is the owner; the drop-ins were only a stopgap so the ceiling existed before `install` could be run safely.

**Key files:** `~/.config/systemd/user/yaco-*.service` (generated, untracked)
**Verification:** `DropInPaths=` empty and the live cgroups read `memory.max=2516582400` / `memory.high=1887436800` (server) and `1073741824` / `734003200` (ui-build) — `daemon-reload` applied them **without a restart**, so `yaco-server` kept pid 4066578 and no WebSocket dropped. Tailnet mapping, 9 tmux sessions, and `/api/health` (0.5-3.8ms) all unaffected.
**Commit:** doc-only; the code that generates this shipped in e0104d17
**Next:** None
**Blockers:** None

## 2026-07-26: Backend event-loop stalls — bound the watcher, the heap, and the services

**What changed:**
- Worktree contents are no longer walked by their parent project's chokidar watcher. `hardVerdict` prunes below `.worktrees/<slug>` (the container and slug dirs stay, so the `worktrees` channel still sees checkouts appear and disappear), and `withProject` arms a watcher for the checkout a request actually resolves via `?worktree=`, capped at 3 with LRU eviction that never unwatches a registered project. The middleware does not await the arm.
- Every tmux invocation in `app/server` moved from `spawnSync` to `spawn`; `attachSession`, `listShellSessions`, `startShellSession`, `closeShellSession`, `reconcileShellSessionExit`, and `pasteTextToSession` became async, and the WS connection handler now releases the PTY if the socket closes mid-attach. Text pastes joined the per-session paste queue that image pastes already used.
- `app/server` starts under `--max-old-space-size=1536`; the `SERVICES` table in `app/scripts/services.sh` gained `MemoryHigh`/`MemoryMax` and an `autostart` column, and `install` now enables only the autostart services (and actively disables a demoted one, so install is declarative rather than additive).
- `yaco-ui` (Vite dev) was demoted to on-demand. It is not on any serving path — `/` is `dist` from `yaco-server`, kept current by `yaco-ui-build`.
- Four dead doc anchors found by an anchor sweep were repaired (`hooks.md#uselayoutstatets`, `libs.md#ttsts`, `libs.md#worktreets`, `workflow.md#desktop-serves-the-production-build`). `check-docs.py` validates links but not heading anchors.

**Why:**
- Terminals froze for seconds and the session list took 10s+. An empty `/api/health` — a `return {ok:true}` route — measured **12.1s**, which is the whole Node process stopped, not a network or route problem; Tailscale TTFB was 40ms throughout. The process held **108,760 inotify watches** and 1.68GB RSS with 907MB paged out, and had already hard-OOMed twice. `.worktrees` was 16,374 of 21,032 watched directories (51 checkouts of `quant`), and chokidar v3 watches every *file* too, which is where the other ~88k went.
- Synchronous tmux spawns cost 39-135ms each on this box, and each one is dead time for every other terminal and request, since they share one event loop.
- Vite dev had been resident and idle for 16 days at 400MB RSS + 384MB swap on a box that shares memory with agent fleets.

**Key files:** `app/server/src/lib/project-watcher.ts`, `app/server/src/middleware/project.ts`, `app/server/src/lib/terminal.ts`, `app/server/src/index.ts`, `app/server/src/routes/sessions.ts`, `app/server/package.json`, `app/scripts/services.sh`, `doc/dev/app/workflow.md`, `doc/main/app/backend/libs.md`, `doc/main/app/README.md`

**Verification:** watches 108,760 -> 17,188; RSS 1.68GB -> 330MB; swap 907MB -> 0. `/api/health` over a 90s 4Hz probe went from p99 multi-second / max 12.1s (~36% of wall clock stalled) to p99 0.583s / max 0.709s. On-demand worktree watching verified live: the request returned in 41ms, watches rose by 1,930, and a write inside that checkout produced `filetree` SSE. `app/server` 764/764 vitest, `cli` 1135/1135 bun test, `tsc` at its 18-error baseline, all doc links and anchors resolve.

**Commit:** efc27e41..HEAD
**Next:** run `app/scripts/services.sh install` at a quiet moment to fold the hand-written systemd drop-ins into the generated units, then delete `~/.config/systemd/user/yaco-{server,ui-build}.service.d/memory.conf`.
**Blockers:** None

## 2026-07-26: Mobile usage indicator

**What changed:**
- Mobile chrome gained a usage icon carrying a tone-colored badge with the peak percent across providers: portrait header left of the bell, landscape right margin between the bell and the theme toggle. Tapping it opens a single-column bottom sheet with the per-provider cards and the same one global refresh.
- The desktop rail's data shaping (`usageModel.ts`) and card rendering (`UsageCards.tsx`) were extracted so the popover (two columns) and the sheet (one) render the same windows from the same `useUsage()` state.
- `DialogShell` gained a `sheet` animation (`panel-slide-up` / new `panel-slide-down`) so the bottom sheet reuses the house dialog — overlay, Escape, focus trap, animated close.
- The portrait `PaneSwitch` became label-only with tighter spacing and truncation.

**Why:**
- Quotas were desktop-only, so the phone — the surface most used to check on running agents — could not see them.
- Sharing the model and cards makes the two surfaces identical by construction rather than by convention.
- The portrait header already overflowed at 390px (the mute icon overlapped the "Terminal" label); a fourth chrome icon forced the fix, and dropping the four pane glyphs bought the room without truncating labels.

**Key files:** `app/ui/src/components/MobileUsageIndicator.tsx`, `app/ui/src/components/usageModel.ts`, `app/ui/src/components/UsageCards.tsx`, `app/ui/src/components/UsageQuotaRail.tsx`, `app/ui/src/components/DialogShell.tsx`, `app/ui/src/workspace/MobilePanelProjection.tsx`, `app/ui/tests/e2e/usage-quota.spec.ts`.
**Verification:** `npx tsc -b` and `npx eslint src tests` clean; `npx vitest run src/` 1126 passed (89 files) including 3 new `MobileUsageIndicator` tests; mobile/landscape/persistence e2e specs 31 passed, including a new 390×844 case asserting the badge peak, both providers in the sheet, equal-width single-column cards, refresh, and close. Visually checked at 390×844 and 667×375 in light and dark. Three full-suite e2e failures (`session-search.spec.ts:103`, `session-search.spec.ts:178`, `workspace.spec.ts:158`) reproduce on a clean tree and are unrelated.
**Commit:** 4973e80c
**Next:** None.
**Blockers:** None.

## 2026-07-25: Provider quota rail in the desktop app header

**What changed:**
- Added validated `GET /api/usage` and forced `POST /api/usage/refresh` proxies over `yaco agent usage --json`, including CLI failure-to-HTTP mapping and a 25-second probe timeout.
- Added a single-line desktop quota rail: Claude Session/Weekly/Fable and Codex Weekly stay visible as percentage-filled cells; all provider windows, including Fable and Codex Spark, remain available in the details popover with exact reset/check times and partial errors.
- Added 60-second cached polling plus one global fresh refresh; refresh sequencing prevents an overlapping poll from replacing the fresh result or blanking the previous data.

**Why:**
- Subscription limits are operational state that should be visible without opening each provider TUI, while still preserving the provider-owned window/scope contract rather than inventing common buckets.

**Key files:** `app/server/src/routes/usage.ts`, `app/ui/src/components/UsageQuotaRail.tsx`, `app/ui/src/hooks/useApi.ts`, `app/ui/tests/e2e/usage-quota.spec.ts`.
**Verification:** `bash scripts/verify.sh` passed (CLI 1122, server 762, UI lint, production build); focused UI unit tests and the Chromium usage refresh flow passed; responsive inspection at 1100/1280/1440px showed no clipping.
**Commit:** 62680ee9
**Next:** None.
**Blockers:** None.

## 2026-07-25: Backend OOM recovery and worktree watcher pruning

**What changed:**
- Long-running systemd/launchd backend services now use `npm start`; foreground development keeps `npm run dev:server` and `tsx watch`.
- Recursive project watching now applies root `.gitignore` rules inside `.worktrees/<slug>/`, preserving source/worktree refresh while pruning repeated ignored data and virtualenv trees.
- The systemd restart-limit keys now live in `[Unit]`, where systemd recognizes them.

**Why:**
- The desktop Node child exhausted its roughly 4.1 GB V8 heap while the `tsx watch` parent stayed alive, leaving Tailscale Serve returning 502 and preventing `Restart=on-failure`.
- The server held about 163,801 inotify watches because `.worktrees` bypassed normal ignore matching; Chokidar's in-memory index drove most of the heap pressure.

**Key files:** `app/scripts/services.sh`, `app/server/src/lib/project-watcher.ts`, `app/server/src/lib/__tests__/project-watcher.test.ts`, `doc/dev/app/workflow.md`, `doc/main/app/backend/libs.md`.
**Verification:** server 758/758; project-watcher 12/12; UI lint and production build green; shell syntax, doc links, and `git diff --check` green; live watch count fell from 163,801 to about 73,820 and Node RSS from 3.5–3.8 GB to about 1.4 GB; Tailnet `/`, built JS, and `/api/health` returned HTTP 200. The unified `scripts/verify.sh` remains red on two pre-existing CLI Stop-debounce timing tests (`hook-event.test.ts`), reproduced unchanged in isolation and unrelated to these app/service files.
**Commit:** pending.
**Next:** None.
**Blockers:** None.

## 2026-07-25: `yaco agent usage` — normalized Claude + Codex subscription quota

**What changed:**
- New `yaco agent usage [provider] [--fresh] [--json]`. Codex quota comes from the local `codex app-server` JSON-RPC (`account/rateLimits/read`), Claude's from `GET https://api.anthropic.com/api/oauth/usage`. Both providers probe concurrently and render side by side, most-exhausted window first.
- New `cli/src/lib/core/agent/providers/usage.ts` holds both probes plus normalization and the cache, following the per-capability layout of `history.ts` / `output.ts` rather than one file per provider. New `RATE_LIMIT` error code; new `usageCacheFile(provider)` in `yaco-home.ts`.
- Per-provider 120s cache under `${YACO_HOME}/cache/`, bound to the mtime of that provider's credential file and skipped entirely when there is no file to bind to.

**Why:**
- Reading quota meant opening a TUI and running `/status` or `/usage` by hand, once per tool.
- Both APIs were probed live before design, and two of the research note's assumptions turned out false. Codex's `primary`/`secondary` do **not** mean session/weekly — on a prolite account `primary` is the 7-day window and `secondary` is null. And the binding limit is often a *scoped* one: Claude reported `five_hour` 4% / `seven_day` 89% while its `limits[]` array carried a model-scoped weekly limit at **98%**, invisible to the note's field list. So each probe reads the richest source its provider offers (Claude `limits[]`, Codex `rateLimitsByLimitId`).
- Windows carry the provider's own identity instead of a `session|weekly` enum. Codex publishes a duration and no name, Claude a name and no duration, and neither is derivable from the other — so any two-bucket mapping is a guess about a number the user plans around, and a 1-day and a 30-day window would both land under "weekly".
- Codex stays on `app-server` rather than calling `chatgpt.com/backend-api/wham/usage` directly: the direct call works and returns the same data, but the Codex access token has a 10-day lifetime, and `app-server` is what refreshes it. Claude needs no subprocess because its endpoint takes the stored OAuth token directly.

**Key files:** `cli/src/lib/core/agent/providers/usage.ts`, `cli/src/commands/agent/usage.ts`, `cli/src/commands/agent/index.ts`, `cli/src/lib/core/errors.ts`, `cli/src/lib/core/paths/yaco-home.ts`
**Verification:** `scripts/verify.sh` green; 1122 cli unit tests (4 new `usage-*` suites: normalization against recorded live payloads, hermetic cache contract, subprocess lifecycle against a fake `codex` on PATH, command parse/exit/render) plus registration in both dispatcher sweeps; `npx tsc --noEmit` clean — it caught type errors that `bun test` and lint both passed. Live runs against the real account for both providers, and adversarial fake-`codex` runs for premature exit, stderr flood, and a TERM-ignoring child.
**Review:** 3 rounds by an independent cross-provider reviewer (`codex`), all Critical/High resolved — see `plan/all/usage-monitor/review.md`. It caught an invented 1970 reset timestamp, a `RangeError` on malformed timestamps, a child process that could outlive the command, a 16 MiB stderr buffer, and a cache that could serve another account's numbers.
**Commit:** 8f6a2919
**Next:** Nothing consumes `--json` yet; a status-bar or app surface is the obvious follow-up. Two test gaps are recorded as accepted limitations in the review artifact (the 22s timeout path and a peak-memory assertion for the stderr flood).
**Blockers:** None

## 2026-07-22: Build-serving setup becomes canonical in services.sh

**What changed:**
- `app/scripts/services.sh` gained a `SERVICES` table (`name|dir|npm script|description`); unit names, plist labels, log paths, and `logs` arguments all derive from it. The two duplicated systemd heredocs and the parallel macOS arrays collapsed into one loop per platform.
- `yaco-ui-build` is now a first-class third service on both platforms, running the new `npm run build:watch` (`vite build --watch`).
- `install` now also applies the tailnet mapping (`/` → `:3001`, `:8741` → `:5173`) via a `configure_serve` step that skips cleanly when tailscale is absent.

**Why:**
- The build-serving setup was desktop-only and hand-installed, so a fresh `services.sh install` would silently produce the old single-service shape and leave `/` pointing at Vite.

**Key files:** `app/scripts/services.sh`, `app/ui/package.json`, `doc/dev/app/workflow.md`
**Verification:** `bash -n`; `services.sh install` on desktop regenerated all three units and re-applied the serve mapping; `yaco-ui-build` restarted onto `npm run build:watch` and was observed rebuilding + compressing; `logs` argument construction checked with a stubbed `journalctl`; the macOS branch exercised with stubbed `uname`/`launchctl` against a temp `$HOME` — all three plists parse under `plistlib` and carry the right `ProgramArguments`.
**Commit:** (this commit)
**Next:** Laptop still has the pre-canonical mapping (`/` → Vite); it adopts the new shape on its next `services.sh install`.
**Blockers:** None

## 2026-07-22: Desktop serves the production build over the tailnet

**What changed:**
- `tailscale serve` on desktop now maps `/` → `:3001` (Hono serving `app/ui/dist`) and `:8741` → `:5173` (Vite dev, HMR intact). Laptop keeps `/` → Vite.
- New `yaco-ui-build.service` runs `npx vite build --watch` so `dist` tracks source. Not covered by `services.sh` (which only knows `yaco-server`/`yaco-ui`).
- Dist compression moved from a post-build npm step into a `closeBundle` vite plugin; `scripts/compress-dist.mjs` → `.ts` so `vite.config.ts` can import it under its typed build. `ui/package.json` build is now `tsc -b && vite build`.

**Why:**
- Laptop→desktop RTT is ~110 ms and Vite dev pays it per waterfall level. Measured from the laptop in real Chrome, cold cache: Vite dev 208 requests / 2.4 MB / 2.5 s to first paint vs 31 requests / 643 KB / 1.0 s for the built bundle.
- The compression move was forced by the first change: a step chained after `vite build` in the npm script never runs under `--watch`, so watch rebuilds were leaving no `.br`/`.gz` siblings and silently degrading `pickEncoding` to identity — 337 KB brotli became 1264 KB raw for the main chunk.
- Investigation note: the sluggishness that prompted this is dominated by per-interaction RTT (`/api/files` is 40 ms locally, 110–128 ms from the laptop), not by desktop compute (PSI memory/IO stall 0) nor by terminal streaming (~400 KB/s arriving as 12 segments/s of ~32 KB — already coalesced, so server-side batching would buy nothing). The build-serving change fixes page load only; typing latency is RTT-bound with no local echo.

**Key files:** `app/ui/vite.config.ts`, `app/ui/scripts/compress-dist.ts`, `app/ui/package.json`, `doc/dev/app/workflow.md`, `doc/main/app/backend/server.md`, `~/.config/systemd/user/yaco-ui-build.service`
**Verification:** `npx tsc -b`, `npm run build`, `npm run lint` all pass; watcher observed rebuilding + compressing on a source touch; from the laptop the main URL serves the 337 KB brotli bundle, `/api` and the terminal WebSocket (101 Switching Protocols) work through the new path, and `:8741` still reports `[vite] connected` + `hot updated`.
**Commit:** 4e4eb9f4
**Next:** Optionally fold `yaco-ui-build.service` into `services.sh`, and consider a build-id signal so a page open on `/` learns it is stale.
**Blockers:** None

## 2026-07-16: Hourly Claude Haiku usage keepalive

**What changed:**
- Added a one-shot `tools/claude-usage-keepalive.sh` that uses `yaco agent` to
  send `hi` to a uniquely named Haiku session, bounds the wait to two minutes,
  and always kills only that handle.
- Added hermetic success/start-failure/kill-failure coverage, wired it into the
  root verify entry, and classified `tools/` changes as code in the exit gate.

**Why:**
- An external hourly scheduler can trigger the Claude usage window without a
  resident process or leaked agent sessions.

**Key files:** `tools/claude-usage-keepalive.sh`,
`tools/claude-usage-keepalive.test.sh`, `scripts/verify.sh`, `scripts/gate.sh`,
`scripts/gate.test.sh`, `doc/dev/cli/workflow.md`
**Verification:** keepalive lifecycle test passed; gate tests 26/26; root verify
passed (CLI 1077, server 755, UI lint, production build); independent Claude
review approved with zero unresolved critical/high findings.
**Commit:** `0c355575`, `12076da2`
**Next:** Add the documented cron entry on any machine that should run it.
**Blockers:** None

## 2026-07-07: Per-tab editor view mode (edit/split/preview)

**What changed:**
- The md/html view mode, split direction, and split size moved from the **global**
  `WorkspaceLayout`/`PanelState.editor` onto the **editor `GroupTab`** (optional
  `previewMode`/`splitDirection`/`splitSize`, omitted when default) — so two tabs
  hold independent views (preview an HTML while split-editing a Markdown). The mode
  travels with the tab on a move and survives reload; `normalizeTab` validates +
  strips defaults, `editorTabView(tab)` reads with defaults.
- New `setTabView(instanceId, patch)` command + `SET_TAB_VIEW` reducer action; the old
  `setEditorPrefs` split into `setTabView` (per-tab) + `setAutocomplete` (global).
  Body/tab-bar/mobile, voice eligibility, and the `Cmd+Shift+V` cycle all read/write
  the tab's own mode; voice + keyboard key on the **active-group** editor tab (not the
  global-MRU editor) so they stay consistent with `canTogglePreview`.
- `PanelState` slimmed to `{ files, separateKinds? }`; `autocompleteEnabled` stays the
  lone global editor pref in `WorkspaceLayout`. Deleted dead `WorkspaceTabBar` (legacy
  renderer, unrendered since T8).

**Why:**
- The mode was global, so previewing one file forced every editor into the same mode —
  you couldn't preview an HTML while split-editing a Markdown. The view is a property
  of the *tab* (Obsidian-style per-pane), so it belongs on the `GroupTab` beside the
  existing per-tab `preview`/`pinned`, riding their persist + travel-on-move rails.

**Key files:** `hooks/workspaceTypes.ts`, `workspace/panelLayoutModel.ts`,
`hooks/useLayoutState.ts`, `workspace/context.ts`, `workspace/WorkspaceProvider.tsx`,
`panels/EditorPanel.tsx`, `WorkspaceEditorColumn.tsx`, `EditorActions.tsx`,
`GroupTabBar.tsx`, `PanelGroup.tsx`, `MobilePanelProjection.tsx`, `useWorkspaceVoice.ts`,
`components/GlobalVoiceControl.tsx`, `WorkspaceScreen.tsx`, `useWorkspaceKeyboard.ts`,
`hooks/usePersistence.ts`; design/review/qa in `plan/all/20260707_per-tab-view-mode/`.
**Verification:** `tsc -b` clean · `eslint` clean · `vitest run src/` 1119 passed ·
Playwright (per-tab-view-mode + html-preview + mi-qa-editor-split + voice-target +
workspace-persistence) green. Codex cross-provider review: SHIP-WITH-FIXES → 1 HIGH
(active-editor identity in voice/keyboard) + 1 LOW (SET_TAB_VIEW no-op guard) fixed.
**Commit:** `b75af67b`..`2747353d` (branch `feat/per-tab-view-mode`)
**Next:** optional per-file-type default (e.g. `.html` opens in preview) — deferred.
**Blockers:** None

## 2026-07-07: Sessions-list cursor jitter — composite the status pulse (opacity, not box-shadow)

**What changed:**
- `status-glow` (`index.css`, class `.status-pulse`) now animates **opacity** instead
  of **box-shadow**, plus `will-change: opacity`.

**Why:**
- `.status-pulse` is on `processing` / `starting` session dots (and the history live
  dot) — i.e. it runs exactly while agents are active. The old keyframes pulsed
  `box-shadow` (0→3px), a **non-composited** property: it repaints on the main thread
  every frame, and the shadow spread reaches into the dot's row, so the row under the
  pointer repainted continuously → the cursor flickered over the sessions list. Opacity
  animates on the compositor without repainting neighbours (the `blocked` dot already
  used opacity via `animate-pulse` and never jittered). Third distinct source in the
  "cursor jitter over the UI" thread, after the editor-bar phantom scrollbar
  (`3683c063`) and the file-icon repaint churn (`173798b5`).
  The common mechanism (CORRECTION — earlier entries wrongly blamed a NoMachine remote
  display): the user views the desktop's yaco server from a **laptop browser over
  Tailscale HTTPS** (`https://desktop.tailnet-example.ts.net/`), a normal local browser —
  NOT a remote desktop. The flicker is **browser-level**: any continuous/frequent
  repaint of the region under the pointer makes Chromium re-assert/re-hit-test the
  cursor there and it jitters. So each fix cuts the repaint (kill the phantom scrollbar
  / memoize / composite), and all three help every user on any display.

**Key files:** `app/ui/src/index.css`
**Verification:** Vite serves the opacity keyframes + `will-change`; `tsc -b` clean. CSS mechanism is textbook (box-shadow = main-thread paint that spreads into the row; opacity = GPU composite, no neighbour repaint), corroborated by the non-jittery opacity-based `blocked` dot. Final visual confirmation pending on the user's NoMachine display.
**Next:** Remaining main-thread-paint infinite animation is `skeleton-shimmer` (animates `background-position`) but it only runs during loading (transient). Wholesale option for the remote display: enable `prefers-reduced-motion` — the app already honours it (the reduced-motion `@media` block zeroes all animation durations).
**Blockers:** None

## 2026-07-04: File-tree repaint churn — memoize the Seti/folder icons

**What changed:**
- `FileTypeIcon` and `FolderIcon` (`fileExplorerIcons.tsx`) are now wrapped in
  `React.memo`, keyed on their primitive props (`name` / `open`).

**Why:**
- The file tree's data reference churns on every git/session poll (see the
  `FilesPanel` note: the tree ref changes each poll/SSE cycle). Un-memoized,
  every poll re-rendered every visible row and re-applied `FileTypeIcon`'s
  `dangerouslySetInnerHTML`, tearing down and rebuilding a **byte-identical**
  `<svg>` per row — measured live as bursts of 8 icon-node swaps per poll
  (`childList` add/remove on `span.shrink-0.inline-flex`, old/new outerHTML
  identical). That repaint flickers the pointer over the file explorer (and the
  editor tab strip / breadcrumb, which reuse `FileTypeIcon`), visible on the
  remote/NoMachine desktop. It presented as **project-specific**: a project with
  active sessions / git changes (quant) polls constantly and churns; an idle,
  clean project (yaco) showed 0 tree mutations, so it looked fixed. This is the
  second, distinct cause behind the "cursor jitter over file paths" report — the
  first was the phantom vertical scrollbar on the editor bars (commit `3683c063`).

**Key files:** `app/ui/src/components/fileExplorerIcons.tsx`
**Verification:** Live DOM on quant: pre-fix ~8 icon-swaps/poll (24 in 5s); post-fix, with polling still live (fetches firing), tree icon-swaps and body mutations both 0 over 7s. `tsc -b` clean; `eslint` clean; `FilesPanel` + `EditorPanel` tests 44/44. Final visual confirmation pending on the user's real (classic-scrollbar / remote) display.
**Next:** If any tree repaint churn remains, stabilize the `useFileTree` data reference so react-arborist doesn't re-render at all when nothing changed (deeper than this leaf-memo).
**Blockers:** None

## 2026-07-03: Cursor jitter over editor tab/breadcrumb bars — phantom vertical scrollbar

**What changed:**
- The editor's horizontal-scroll strips — group tab strip (`GroupTabBar.tsx`),
  legacy tab bar (`WorkspaceTabBar.tsx`), breadcrumb path bar
  (`WorkspaceBreadcrumbs.tsx`), and the mobile tab list (`MobilePanelProjection.tsx`)
  — now pair `overflow-x-auto` with `overflow-y-hidden`.

**Why:**
- Tailwind's `overflow-x-auto` sets only `overflow-x: auto`; per the CSS spec, when
  one overflow axis is non-`visible` the other computes to `auto`, so each strip
  silently ran `overflow-y: auto` too. Each is a fixed-height bar (28px minus a 1px
  border → a 27px content box) whose single line renders 1px taller — measured live
  on the tab strip as `clientHeight 27 / scrollHeight 28`. That 1px overflow spawns a
  vertical scrollbar in a bar too short to scroll; with classic space-reserving
  scrollbars (the user's Linux Chromium) the appear→relayout→disappear loop makes the
  strip and the `cursor: pointer` over it jitter continuously. Headless Chromium uses
  overlay scrollbars (no reserved space), so `elementFromPoint`/mutation/size probes
  showed zero oscillation and never reproduced it — which pinned the cause to
  scrollbar reservation, not a JS/React loop. The file-explorer tree tested clean
  (rows are `width:100%`+`truncate`; a simulated reserved scrollbar gave `hOver: 0`).

**Key files:** `app/ui/src/workspace/{GroupTabBar,WorkspaceTabBar,WorkspaceBreadcrumbs,MobilePanelProjection}.tsx`
**Verification:** Live DOM: post-fix both strips compute `overflow-y: hidden`, `phantomVScroll: false`, whole-page bug-signature scan empty; user visually confirmed the jitter is gone. `tsc -b` clean; `eslint` clean on all four files; `MobilePanelProjection` tests 9/9 (the `overflow-x-auto` substring assertion still holds). Self-review: context menus are cursor-positioned overlays outside the scroll container, so `overflow-y-hidden` clips nothing new.
**Commit:** `3683c063` (fix) + docs follow-up
**Next:** If jitter is ever reported specifically inside the file-tree rows (tested clean here), capture a screen recording of that exact region.
**Blockers:** None

## 2026-07-03: Image-paste "Pasting…" hang — keep the agent on the X11 read path

**What changed:**
- `writeImageToClipboard` (`clipboard-write.ts`) now resolves only after re-reading
  the selection with the agent's own `xclip -o` and confirming it returns the whole
  image (bounded, per-read timeout-guarded retry); MIME set narrowed to `image/png`
  only.
- The `image-paste` WS handler (`index.ts`) serializes pastes per session and holds
  the queue for a short read window (~500ms) after Ctrl+V; the settled chain entry is
  dropped if still current.
- Docs: `libs.md` clipboard-write.ts section + `server.md` image-paste step.

**Why:**
- On the GNOME/Wayland desktop the TUI agent reads a pasted image with
  `xclip -o 2>/dev/null || wl-paste`. A re-paste's xclip ownership churn made
  `xclip -o` fail, dropping the agent onto `wl-paste`, which hangs forever on
  Mutter's X11→Wayland image bridge — the intermittent "Pasting…" freeze. Verifying
  the X11 owner is live+serving before Ctrl+V (plus serialization) keeps the agent's
  first-choice `xclip -o` succeeding, so the hanging `wl-paste` branch is unreachable.
  `image/png` only because it is the sole agent-xclip-readable target (a non-PNG
  selection would still fall through to `wl-paste`). Reconfirmed environmental
  prerequisite: the feature needs an active GNOME login on the desktop (breaks after
  any reboot that lands on the GDM greeter).

**Key files:** `app/server/src/lib/clipboard-write.ts`, `app/server/src/index.ts`, `doc/main/app/backend/{libs.md,server.md}`
**Verification:** server `npm test` 755 passed; `tsc` clean on both touched files; end-to-end validation against the real module (Claude's exact `xclip -o` returns the full latest image after every write incl. 2MB + rapid churn; non-PNG rejected cleanly with `unsupported-mime`); Codex review, 2 rounds — all 3 findings resolved (the 500ms window documented as a bounded, non-guaranteed mitigation). Deployed via `systemctl --user restart yaco-server`, fresh `YACO server running` boot line confirmed.
**Commit:** `f230d67e` (fix) + docs follow-up
**Next:** Optional — client-side transcode-to-PNG to support non-PNG clipboard sources; a real read-completion signal stronger than the fixed read window.
**Blockers:** None

## 2026-07-03: Clear orphaned mermaid error node in markdown preview

**What changed:**
- `MarkdownPreview`'s mermaid render loop (`WorkspaceEditorArea.tsx`) now sweeps
  `body > [id^="dmermaid-"]` orphans at the start of each render pass and drops
  `#d<id>` immediately on a failed render.
- Regression test `MarkdownPreviewMermaid.test.tsx` drives the failed → valid
  transition (a mocked mermaid mimicking the orphan side effect) and asserts no
  orphan survives; documented the landmine on the mermaid line of
  `doc/main/app/ui/workspace/editor-and-preview.md`.

**Why:**
- A valid saved doc still showed a mermaid "Syntax error" bomb. Root cause:
  `mermaid.render()` appends its error diagram as a direct `document.body` child
  on a parse failure and throws **without removing it**. The loop's catch only
  swapped the diagram cell for an inline red `<pre>`, so any transient broken
  edit while typing a mermaid block left a bomb floating over the preview that
  survived every later valid render (until page reload).

**Key files:** `app/ui/src/workspace/WorkspaceEditorArea.tsx`, `app/ui/src/workspace/__tests__/MarkdownPreviewMermaid.test.tsx`, `doc/main/app/ui/workspace/editor-and-preview.md`
**Verification:** `tsc -b` · `eslint` · `vitest run src/` (1106 tests) green; real-chrome puppeteer repro confirmed the orphan mechanism and the sweep fix; Codex cross-provider review approve-with-nits (nit applied — sweep scoped to direct body children).
**Commit:** `93b933b5` (fix) + docs follow-up
**Next:** None
**Blockers:** None

## 2026-06-30: Laptop Vite entry + robust Accept Disk conflict handling

**What changed:**
- Laptop Tailscale Serve was confirmed and reset to proxy `https://laptop.tailnet-example.ts.net/` to Vite dev (`127.0.0.1:5173`) so the Tailnet URL hot-loads the same UI as `http://localhost:5173/`.
- Project watcher hard-prunes high-volume runtime log subtrees (`logs/traffic`, `logs/usage`) and `.git/**/index.lock`, preventing cproxy traffic logs and Git transient locks from triggering `filetree`/`git` refresh storms.
- File state now tracks `serverRevision` separately from `baseRevision`, so conflict state can remember the disk revision while keeping the stale save token that prevents unsafe plain saves.
- `acceptDisk()` now clears immediately only when conflict state already holds a freshly-refetched disk revision; save-time 409 conflicts wait for the follow-up content fetch before discarding a draft. Background accept refreshes cannot overwrite edits/saves that land after the click, stale revisions are ignored, and missing files clear stale clean bytes.

**Why:**
- `resume/qiguo_resume.tex` was Git-clean, but Chrome held a stale local draft; clicking Accept Disk looked ineffective because the UI path depended on a follow-up fetch and could be disturbed by laptop-only refresh churn.
- Laptop tailnet access caused cproxy traffic logs under a registered workspace parent to be observed as project file changes, producing repeated `filetree`/`git` refreshes and UI flicker.

**Key files:** `app/server/src/lib/project-watcher.ts`, `app/server/src/lib/__tests__/project-watcher.test.ts`, `app/ui/src/hooks/{useFileState,fileStateMachine,workspaceTypes}.ts`, `app/ui/src/hooks/__tests__/{useFileStateWorktree,fileStateMachine}.test.ts`, `doc/dev/app/workflow.md`, `doc/main/app/{backend/libs.md,frontend/hooks.md,frontend/state.md,ui/workspace/editor-and-preview.md}`, `plan/all/laptop-vite-accept-disk/`.
**Verification:** `scripts/verify.sh` passed; `python3 agent-config/global/skills/update-doc/scripts/check-docs.py` passed; live HTTP checks confirmed Tailnet Vite HTML, resume git status clean, and laptop SSE sample without `filetree`/`git`; independent final review approved with 0 critical/high; QA artifact [plan/all/laptop-vite-accept-disk/qa-0a84045edaf0.md](../plan/all/laptop-vite-accept-disk/qa-0a84045edaf0.md).
**Commit:** pending.
**Next:** None.
**Blockers:** None.

## 2026-06-28: Agent starts use installed yaco plus managed wrapper fallback

**What changed:**
- `app/server/src/lib/constants.ts` now resolves `YACO_PATH` to explicit `YACO_PATH`, then executable `${YACO_BIN_DIR:-$HOME/.local/bin}/yaco`, then `which yaco`. This prevents npm-run services from picking the workspace `node_modules/.bin/yaco` source shim.
- `cli/src/lib/core/agent/lifecycle.ts` now treats `${YACO_HOME}/agent-wrapper.sh` as the deployed runtime artifact: it refreshes from source when a YACO checkout is discoverable, but compiled `yaco` can start agents from non-YACO project directories by reusing the already-installed managed wrapper.
- Added `constants.test.ts` coverage for explicit override, installed binary preference over a PATH shim, and `YACO_BIN_DIR`.
- Added wrapper fallback tests and fixed project-registry tests to expect the production `realpath` canonical path on macOS `/var` → `/private/var`.
- Updated app backend/dev docs with the installed-binary contract for live Claude/Codex behavior, plus an implementation plan and review artifact under `plan/all/20260628_agent-start-runtime/`.

**Why:**
- On laptop launchd, the server ran under npm scripts, so `which yaco` resolved the workspace shim whose shebang requires `bun`; launchd did not expose bun, causing `env: bun: No such file or directory`.
- After the server correctly preferred the compiled binary, a second runtime edge surfaced: the installed binary still tried to discover `cli/scripts/agent-wrapper.sh` from the current project cwd. That worked in the `yaco` checkout but failed in projects such as `resume`, making the UI's `Starting...` row disappear.

**Key files:** `app/server/src/lib/constants.ts`, `app/server/src/lib/__tests__/constants.test.ts`, `cli/src/lib/core/agent/lifecycle.ts`, `cli/test/wrapper-resolve.test.ts`, `cli/test/unit/commands/project/{current,registry}.test.ts`, `app/server/src/lib/__tests__/projects.test.ts`, `doc/main/app/backend/libs.md`, `doc/dev/app/workflow.md`.
**Verification:** `./scripts/verify.sh` green (CLI 1077/1077, server 754/754, UI lint, build); `tools/install.sh --cli-only`; `yaco doctor` 12/12; direct CLI start from `/Users/moonkey/Dropbox/JobHunting/resume` succeeded and was killed; local app API `POST /api/sessions/start` for `resume` succeeded and was closed; independent Claude `/code-review` artifact approved with 0 critical/high; QA artifact [plan/all/20260628_agent-start-runtime/qa-e595e094.md](../plan/all/20260628_agent-start-runtime/qa-e595e094.md).
**Commit:** `e595e094`.
**Next:** Optional hardening: add a compiled-binary integration test from a non-YACO git directory; unify server/CLI executable predicates.
**Blockers:** None.

## 2026-06-25: gate.sh — review/qa freshness = "no code since reviewed_sha", not exact-HEAD-sha (codify-process-gate v1 follow-up · F0)

**What changed:**
- `scripts/gate.sh`: the `review`/`qa` freshness rule no longer requires a `plan/` artifact to literally contain the **current HEAD short sha** (the deleted `artifact_refs_head`). It now reads `reviewed_sha` **from** the artifact and treats the review as fresh iff `git diff <reviewed_sha>..HEAD --no-renames --name-only` touches **no code root** `^(src|cli|app)/`; `qa` is the same against `^app/ui/`. So a review stays valid through docs/plan-only commits stacked on reviewed code (the **docs-tail footgun** — a docs commit moved HEAD and false-staled the review), while a code commit landing after the review correctly goes stale. The code-touch predicate is now **one definition** (`code_roots_re` / `ui_root_re`) reused by both the floor mapping and the freshness check, so they can never diverge.
- New helpers: `extract_reviewed_sha` (field-anchored parse — `(^|[^a-z0-9_])reviewed_sha[:=]…` so a substring like `unreviewed_sha:` is **not** mistaken for the field; handles `reviewed_sha:` headers, the `reviewed_sha=` verdict-line form, markdown `**reviewed_sha:**`, backtick-wrapped, and 7- to 40-char shas) and `artifact_is_fresh <touch-regex> <glob>` (the sha must be a known commit **and** an ancestor of HEAD — a missing / unknown / rebased-orphaned sha can't prove the review covers HEAD's history → stale; **any one** fresh artifact passes).
- `scripts/gate.test.sh`: +10 cases (15 → **25**). F0 freshness: docs-tail stays `review=pass` (the footgun fix), code-after-review → stale, non-ancestor reviewed_sha → stale, missing `reviewed_sha` line → not fresh, multiple artifacts → any-fresh-wins, qa-vs-review predicate divergence (a `cli/` commit staling review while `qa` stays fresh), 40-char sha; plus the parser-format guards from review (verdict-line `=`, markdown+backtick, and the `unreviewed_sha:` substring rejection).

**Why:**
- The v1 gate keyed `review` freshness on an **exact HEAD short-sha match** inside the artifact. A docs-only tail commit (the standard "stamp the review artifact, then commit a docs tail" flow this very project uses) moves HEAD, so the artifact — referencing the reviewed **code** sha — no longer matched and the review reported a false `stale`, blocking `yaco task set <leaf> done` / the `/implement` self-check on work that was actually reviewed. Freshness should ask "is there unreviewed **code** since the review?", not "does the artifact name today's HEAD?".

**Key files:** `scripts/gate.sh`, `scripts/gate.test.sh`.
**Verification:** `scripts/gate.test.sh` **25/25**; `scripts/verify.sh` green (cli 1077/0, server 751/751, ui lint clean, build ok); `extract_reviewed_sha` validated against the repo's real artifact prose (short, full-40, markdown-bold+backtick, inline `=`) and rejecting `unreviewed_sha:` / `pre_reviewed_sha:`. Independent cross-provider review (Codex, default model, two rounds): R1 caught a real **HIGH** — the parser matched `reviewed_sha` as a bare substring, so `unreviewed_sha: <fresh-sha>` forged freshness (reproduced `review=pass`) — plus a MEDIUM (formats untested); the fix anchored the field boundary + added the three format/rejection cases; R2 (fresh context) re-reviewed → **0 critical / 0 high**. `gate.sh` is interpreted by path, so the change is live on merge with no re-install.
**Design:** [plan/all/codify-some-process/cn/design.md §11](../plan/all/codify-some-process/cn/design.md) (F0 row); review artifact [plan/all/codify-some-process/review_codex_gate-freshness-backfill.md](../plan/all/codify-some-process/review_codex_gate-freshness-backfill.md).
**Next:** v2 `T5 gate-memo` (content-hash memo over the working tree) builds on this freshness rule; T6 Stop hook stays DEFERRED (design §11.1). Do **not** mark the task done or merge — orchestrate gatekeeps + merges.
**Blockers:** None.

## 2026-06-24: Worktree picker renders INLINE in the panel body (drops the floating dropdown), matching Compare-ref's box (worktree-explorer-view P2e)

**What changed:**
- `app/ui/src/components/WorktreePicker.tsx`: the worktree list no longer floats. It now renders **INLINE in the Files panel body** as an accent box (`borderTop: 2px var(--sol-accent)`, tinted bg, `mx-1 mt-1 rounded-md`) styled exactly like Changes' `CompareRefPicker`, pushing the file tree down. Three states: **CLOSED + primary → nothing**; **CLOSED + non-primary → the persistent indicator box** (branch + dirty/ahead-behind + an `X` that calls `selectWorktree(null)` → primary); **OPEN → the accent box wraps the full `role="listbox"` of git-sourced worktree rows** (mono branch, `primary` chip, dirty dot, ahead/behind, `Check` on the canonical active row), a click selecting `onSelect(id|null)` + closing. For a non-primary worktree the indicator row STAYS above the list while open, so its region/chevron is always a non-select close path — the only one in search mode (no header toggle, no DialogShell Escape). The component is now pure — `DialogShell`, the floating `WorktreeDropdown` sub-component, the `position:fixed` anchor-rect effect, `autoFocusRef`/`restoreFocus`, the `focusIdx` state, and the `useEffect`/`useRef`/`useState` imports are all deleted. Inline rendering never restores focus to the header button on close, so the P2d stray-Enter-reopen regression cannot occur — the focus hacks are dropped, not ported.
- `app/ui/src/workspace/panels/FilesPanel.tsx`: no structural change — the body still renders `<WorktreePicker>` atop the tree/search swap and the header keeps the `GitBranch` toggle (aria-pressed, branch in title) flipping the module store. Only the comments that described a "floating dropdown" are retitled to the inline box (§P2e). The module store, `useWorktreePickerOpen`, and `resetWorktreePickerForTests` are unchanged.
- Tests: `FilesPanel.test.tsx` retitled to the inline model — the open path now asserts the listbox is a sibling of the explorer's flex-fill root inside the flex-column body **and there is no `role="dialog"` overlay**; the P2d-only autofocus/`restoreFocus` test is removed (DialogShell is gone); two tests added from the review (the indicator stays a non-select close path while open in search mode; opening with a stale selection marks PRIMARY active). `worktree.spec.ts` adds a `getByRole('dialog')` count-0 check while the picker is open. `worktree-external` / `worktree-persist` helpers are unchanged (listbox + option still resolve inline); their comments are retitled to §P2e.
- `doc/main/app/frontend/components.md`: WorktreePicker row + §P2 references updated to §P2e (inline box, no DialogShell/floating/focus-restore).

**Why:**
- A final consistency pass: the user compared two screenshots and saw that Changes' "Compare ref" renders its picker as an inline accent box in the panel body, while the worktree picker opened a floating `DialogShell` popup. Make them consistent — render the worktree list inline, like `CompareRefPicker`. This is also a simplification: dropping the floating dropdown removes the `position:fixed`/anchor/focus-restore machinery the P2d iteration only needed *because* the list floated (and a worktree switch does not remount the workspace).

**Key files:** `app/ui/src/components/WorktreePicker.tsx`, `app/ui/src/workspace/panels/FilesPanel.tsx`, `app/ui/src/workspace/panels/__tests__/FilesPanel.test.tsx`, `app/ui/tests/e2e/worktree{,-external,-persist}.spec.ts`, `doc/main/app/frontend/components.md`.
**Verification:** `tsc -b` + `app/ui` lint green; `npm test` **1096 passed** (26 FilesPanel; one DialogShell-specific autofocus test removed, two review-driven tests added). Isolated static-build e2e — the full worktree trio → **10 passed**. Cross-provider Codex review (round 1 REQUEST CHANGES → round 2 APPROVE) + `/qa` artifacts under `plan/all/worktree-explorer-view/`.
**Design:** [plan/all/worktree-explorer-view/plan_p2e-picker-inline.md](../plan/all/worktree-explorer-view/plan_p2e-picker-inline.md).
**Next:** None — picker refinement complete; do not mark the task done or merge (per the contract).

## 2026-06-24: Worktree picker becomes a floating dropdown + persistent non-default indicator, mirroring Compare-ref (worktree-explorer-view P2d)

**What changed:**
- `app/ui/src/components/WorktreePicker.tsx`: reworked from the P2c inline list into the faithful Compare-ref analogue. The non-default state is APP state (`activeWorktree`), not a UI mode: **PRIMARY active → nothing persistent renders** (a zero-height anchor host); **a NON-PRIMARY worktree active → a persistent indicator box** renders atop the Files body AT ALL TIMES (tree AND search mode), showing the branch + dirty/ahead-behind, with an `X` button that REMOVES the worktree (`onSelect(null)` → primary, like Compare ref's exit-to-default). The picker itself is now a real floating **`DialogShell` dropdown** (`WorktreeDropdown`, position:fixed, anchored to the indicator box / the primary anchor host; RefSearchDropdown idiom rows — git-sourced worktrees by branch, `primary` chip, dirty dot, ahead/behind, `Check` on active; no search input). The indicator's clickable region is a real `<button aria-expanded>`; the dropdown `autoFocus`es the active option and sets **`restoreFocus={false}`**. `currentWorktreeEntry` moved here (exported) so the indicator and the header title agree.
- `app/ui/src/workspace/panels/FilesPanel.tsx`: the header `GitBranch` toggle now opens/closes the floating dropdown (module store `worktreePickerOpen` unchanged, still bridging the PanelFrame header/body split); the header `X` is removed; `<WorktreePicker>` renders ABOVE the tree/search swap so the indicator persists in BOTH modes; the close-on-search-entry effect is dropped (the dropdown is transient/self-closing and the indicator must survive a mode switch).
- Tests: `FilesPanel.test.tsx` rewritten to the new model — primary→no indicator; toggle opens a floating dropdown (listbox in body DOM); select binds id/null + closes; toggle relabels + closes (no header X); non-primary→indicator visible in tree AND search; indicator X→`selectWorktree(null)`; indicator click opens the dropdown; the indicator is a real `<button>`; opening autofocuses the active option (not the trigger). `worktree.spec.ts` gains a non-default-indicator + X-returns-to-primary flow and closes via the relabeled toggle; `worktree-external` / `worktree-persist` comments updated to §P2d.
- `doc/main/app/frontend/components.md`: WorktreePicker row + §P2 references updated to §P2d.

**Why:**
- The user asked for two things, read from their own words: (1) the in-panel SHORT LIST should be a real DROPDOWN; (2) mirror Changes' Compare-ref — main/primary needs no display, a non-default worktree must be shown in the panel at all times to remind, and removing it returns to main/primary. The P2c inline list satisfied neither cleanly. P2d makes the picker a floating dropdown and adds a persistent non-default indicator whose X is the exit-to-default, so the worktree selector now behaves as the precise analogue of compare-ref. `restoreFocus={false}` + autofocus fix a real reopen bug: a worktree switch does NOT remount the workspace, so the dropdown was restoring focus to the header *button* after a select, and a later quick-open Enter re-activated it (caught by `worktree-persist.spec.ts`).

**Key files:** `app/ui/src/components/WorktreePicker.tsx`, `app/ui/src/workspace/panels/FilesPanel.tsx`, `app/ui/src/workspace/panels/__tests__/FilesPanel.test.tsx`, `app/ui/tests/e2e/worktree{,-external,-persist}.spec.ts`, `doc/main/app/frontend/components.md`.
**Verification:** `scripts/verify.sh` green (cli test · server test · ui lint · root build = `tsc -b` + vite build). `app/ui` `npm test` **1095 passed** (25 FilesPanel). Isolated static-build e2e — the full worktree trio → **10 passed**. Cross-provider Codex review (2 rounds: REQUEST CHANGES → APPROVE) + `/qa` artifacts under `plan/all/worktree-explorer-view/` (reviewed_sha 821f4515).
**Commit:** 8bc4ce7b (feat) · 821f4515 (review fix) + docs tail.
**Design:** [plan/all/worktree-explorer-view/plan_p2d-picker-dropdown.md](../plan/all/worktree-explorer-view/plan_p2d-picker-dropdown.md).
**Next:** None — picker refinement complete; do not mark the task done or merge (per the contract).

## 2026-06-24: Worktree picker becomes a header-toggled in-panel dropdown, mirroring Compare-ref mode (worktree-explorer-view P2c)

**What changed:**
- `app/ui/src/workspace/panels/FilesPanel.tsx`: the worktree picker is now HIDDEN by default and revealed by a header toggle, EXACTLY mirroring ChangesPanel's "Compare ref" mode. A module-scoped open store (`worktreePickerOpen` Map keyed by project + listeners + `setWorktreePickerOpen` + `useWorktreePickerOpen` via `useSyncExternalStore`) bridges the header/body split (PanelFrame renders them as siblings, so they can't share `useState` — same reason as ChangesPanel's `compareSlot`). `useFilesHeader` (tree mode) gains a `GitBranch` `section-header-icon-btn` at the FRONT of the actions row (`aria-pressed`, aria-label "Select worktree"/"Hide worktree picker", title carries the active branch); when open, an `X` (aria-label "Close worktree picker") renders next to it. Both render only when `env.worktrees.length > 0`. The body renders `<WorktreePicker>` only when `pickerOpen && !showTextSearch`; its `onSelect` calls `env.selectWorktree(id)` AND closes the picker. `currentWorktreeEntry` (fall back to primary when the selected id is gone) lives here now, feeding the toggle's title tooltip. A `resetWorktreePickerForTests` seam clears the module store between unit tests.
- `app/ui/src/components/WorktreePicker.tsx`: reworked from a trigger-row + floating `DialogShell` dropdown into the INLINE in-panel box. Same Compare-ref container (`mx-1 mt-1 rounded-md`, accent top-border, `color-mix` accent-3% bg) now renders the worktree LIST INLINE (rows directly, pushing the tree down) — no trigger, no overlay, no `ChevronDown`. Rows keep the RefSearchDropdown idiom (`h-[24px]`, blue-12% focus bg, mouseEnter focus, mono branch, primary chip, dirty dot, ahead/behind, `Check` on active), `role="listbox" aria-label="Worktrees"`, `data-worktree-id`, the `worktrees.length === 0` null guard. No search input. ~190 → ~95 lines.
- Tests: `FilesPanel.test.tsx` rewritten to the toggle model (hidden by default; toggle reveals the in-body list; tree-mode-only; title shows the active branch with primary fallback; selecting binds id/null AND closes; the header X closes). `worktree.spec.ts` asserts hidden-by-default + the header X exit + close-on-select; `worktree-external.spec.ts` / `worktree-persist.spec.ts` drive the header toggle and assert close-on-select.
- `doc/main/app/frontend/components.md`: WorktreePicker + ProjectList rows updated to the header-toggled model (§P2c).

**Why:**
- The always-visible picker box took permanent vertical space atop the Files body and read differently from Changes' Compare-ref selector, which is header-toggled. Giving the worktree picker the SAME interaction (a header toggle that reveals an in-panel box, an X to exit) makes the two ref/worktree selectors behave identically and reclaims the body space by default.

**Key files:** `app/ui/src/workspace/panels/FilesPanel.tsx`, `app/ui/src/components/WorktreePicker.tsx`, `app/ui/src/workspace/panels/__tests__/FilesPanel.test.tsx`, `app/ui/tests/e2e/worktree{,-external,-persist}.spec.ts`, `doc/main/app/frontend/components.md`.
**Verification:** `scripts/verify.sh` green (cli test · server test · ui lint · root build = `tsc -b` + vite build). `app/ui` `npm test` **1089 passed** (19 FilesPanel). Isolated static-build e2e — the full worktree trio → **9 passed**. Cross-provider Codex review + `/qa` artifacts under `plan/all/worktree-explorer-view/`.
**Design:** [plan/all/worktree-explorer-view/plan_p2c-picker-toggle.md](../plan/all/worktree-explorer-view/plan_p2c-picker-toggle.md).
**Next:** none for this change.
**Blockers:** None.

## 2026-06-24: Worktree selector restyled to the Compare-ref box, moved into the Files panel body (worktree-explorer-view P2b)

**What changed:**
- `app/ui/src/components/WorktreePicker.tsx`: restyled to the Changes "Compare ref" idiom. The bare `GitBranch` + branch chip is replaced by a boxed selector — `mx-1 mt-1 rounded-md`, `borderTop: 2px solid var(--sol-accent)`, tinted bg `color-mix(in srgb, var(--sol-accent) 3%, var(--sol-bg))` — whose trigger is a Compare-ref row: a small uppercase `worktree` label column, the current branch in mono (`var(--font-mono)`, letterSpacing -0.01em, `var(--sol-text-dark)`), and a `ChevronDown` (size 10) that rotates 180° + turns `var(--sol-accent)` when open. The trigger stays a `<button>` (so the `aria-label="Select worktree"` selector remains a stable form control). The floating `DialogShell` dropdown is kept (anchored to the trigger) but its rows now follow the `RefSearchDropdown` idiom — `h-[24px] text-ui-md`, focus bg `color-mix(in srgb, var(--sol-blue) 12%, transparent)` + `var(--sol-blue)`, `onMouseEnter` sets focus (initialised on the active row). All behaviour preserved: git-sourced list, `primary` chip, dirty dot, ahead/behind, `Check` on the active row, `role="option"` + `data-worktree-id`, listbox `aria-label="Worktrees"`, the `worktrees.length === 0` null guard. No search input / filter tabs (the list is short).
- `app/ui/src/workspace/panels/FilesPanel.tsx`: the picker moved OUT of the framed header (`useFilesHeader`) and into the panel BODY — rendered at the top of `<div className="h-full min-h-0 flex flex-col">`, above the explorer/text-search swap, mirroring how `CompareRefPicker` sits atop the Changes body. It now scopes BOTH the tree and the text-search views (the old header chip showed in tree mode only).
- Tests: `app/ui/src/workspace/panels/__tests__/FilesPanel.test.tsx` — the worktree-picker block now asserts the in-body placement (the trigger is inside the explorer's flex-col body wrapper, not the header subtree) and that the picker also shows in search mode; existing trigger/list/select assertions unchanged (stable selectors). `app/ui/tests/e2e/worktree{,-external,-persist}.spec.ts` — comments/titles updated from "header" to the in-panel picker; selectors (`getByLabel('Select worktree')`, listbox, `data-worktree-id`) unchanged.

**Why:**
- The worktree selector and the Changes "Compare ref" selector do the same kind of job — pick the ref/worktree that scopes the panel below — so they should read the same. Hiding the worktree picker as a header chip made it easy to miss and inconsistent with Compare ref; moving it into the body atop the tree/search swap (where Compare ref lives in the Changes body) makes the "this scopes everything below" relationship visible and uniform.

**Key files:** `app/ui/src/components/WorktreePicker.tsx`, `app/ui/src/workspace/panels/FilesPanel.tsx`, `app/ui/src/workspace/panels/__tests__/FilesPanel.test.tsx`, `app/ui/tests/e2e/worktree{,-external,-persist}.spec.ts`, `doc/main/app/frontend/components.md`.
**Verification:** `app/ui` `npx tsc -b` (clean) + `npm run lint` (clean) + `npm test` (**1087 passed**, +2 in-body placement tests). Isolated static-build e2e — the full worktree trio `worktree.spec.ts` + `worktree-persist.spec.ts` + `worktree-external.spec.ts` → **9 passed**. Visual confirmation via a throwaway screenshot spec (accent-bordered box atop the Files body, rotating chevron, mono value; dropdown rows with primary chip + dirty dot + ahead/behind + active Check). Cross-provider Codex review + `/qa` artifacts under `plan/all/worktree-explorer-view/`.
**Design:** [plan/all/worktree-explorer-view/impl-plan_p2b-picker-inpanel.md](../plan/all/worktree-explorer-view/impl-plan_p2b-picker-inpanel.md).
**Next:** none for this change; worktree-explorer-view follow-ups (external-path session labels, "open terminal in this worktree") remain as design Non-goals.
**Blockers:** None.

## 2026-06-24: External-worktree end-to-end capstone (worktree-explorer-view P3 e2e-verify, the final leaf)

**What changed:**
- `app/ui/tests/e2e/worktree-external.spec.ts` (new): ONE integration test that registers a git worktree at an **external** path (OUTSIDE `.worktrees/` — the P1 path-identity dimension), selects it in the Files-header picker, and proves the whole worktree-as-view contract in a single live session. **File views FOLLOW** the selected worktree — explorer tree, Changes/diff (the diff body carries the worktree-only edit), open-editor content (the same open tab re-fetches the worktree's bytes), unsaved-draft round-trip (proven from **both** the primary and the worktree bucket across three switches), binary/raw preview (a worktree-only PNG whose `/raw?worktree=` resolves), text search (ripgrep in the worktree root), quick-open. **The shell HOLDS STILL** across each switch — the open-tab set is identical, the terminal does **not** remount (its `/ws/terminal/<s>` socket stays `{opens:1, closes:0}` and the xterm node keeps its identity), and the session-list row count is unchanged. Selecting primary returns to the main tree.
- `app/ui/tests/e2e/helpers/workspace.ts`: added `createExternalWorktreeFixture` (+ `ExternalWorktreeFixture`) — git-inits a repo, `git worktree add`s an external sibling temp dir, seeds the worktree-only shape (committed `src/index.js` divergence, an uncommitted README diff, an untracked token-carrying `wip.txt`, an untracked `asset.png`), registers the project, and disposes both dirs. The external checkout's marker-bearing parent is swept by global cleanup while the checkout itself stays git-clean.
- `doc/dev/app/workflow.md`: documented the new fixture in the e2e self-provision list.

**Why:**
- P1+P2+P3 were verified per-task; this leaf is the integration capstone the design's §7.3 calls for — the one flow that exercises an *external* worktree (the path-identity P1 unlocked) and asserts the shell-holds-still invariant (the P3 drop-remount payoff) end to end, driving the real affordances (header picker, session row, the tab the user clicks) and asserting user-observable bytes, not selector presence.

**Key files:** `app/ui/tests/e2e/worktree-external.spec.ts`, `app/ui/tests/e2e/helpers/workspace.ts`, `doc/dev/app/workflow.md`.
**Verification:** isolated static-build e2e — `worktree-external.spec.ts` green (stable across `--repeat-each`), and the full worktree trio `worktree.spec.ts` + `worktree-persist.spec.ts` + `worktree-external.spec.ts` → **9 passed**. Gate: `cd app/server && npm test` (751) · `app/ui` `npx tsc -b` (clean) + `npm run lint` (clean) + `npm test` (1085). Cross-provider Codex review (`codex-wt-e2e-reviewer`): **APPROVE, 0 critical/high**; 2 MEDIUM (worktree-bucket draft round-trip, session-list count identity) + 2 LOW (diff content, untracked-file commit reminder) all folded into the spec. Artifacts under `plan/all/worktree-explorer-view/{plan,REVIEW_REQUEST,code-review,qa}_p3-e2e-verify.md`.
**Design:** [plan/all/worktree-explorer-view/design.md](../plan/all/worktree-explorer-view/design.md) §7 Verification plan.
**Next:** worktree-explorer-view is fully implemented and verified end to end. Design Non-goals remain as follow-ups: external-path session labels; an optional "open terminal in this worktree" affordance.
**Blockers:** None.

## 2026-06-24: Drop the worktree remount — switching worktree re-points views, holds the shell (worktree-explorer-view P3 drop-remount, THE FLIP)

**What changed:**
- `app/ui/src/App.tsx`: the `<Workspace>` remount key dropped `activeWorktree` (`` `${project}:${worktree}` `` → `project`). Switching worktree **no longer remounts** the workspace — open tabs, terminals, layout, and session bindings hold still (the durable shell); the file views (explorer, Changes, open-editor content, drafts) follow the selected worktree (the IDE branch-switch feel). Worktree now flows as a live prop `App → Workspace → WorkspaceProvider → hooks`.
- `app/ui/src/hooks/useFileState.ts`: buckets keyed by `worktree ?? projectPath` (was `?? projectName`) — matching the persisted record exactly, so no remap. **Seeds EVERY persisted bucket up front** from the full `initialDraftsByWorktree` record, so a switched-to worktree restores its drafts **live without a reload** — a partially-hydrated bucket can no longer serialize `{}` and prune an unopened-path base draft (**#3b**). `acceptDisk` rides a **mount-lifetime** `AbortController` (not the per-worktree epoch) and drops its captured-key guard, so an explicit accept completes into its captured bucket even after a worktree switch (**#3a**). Exposes the reactive `filesByWorktree`.
- `app/ui/src/hooks/usePersistence.ts`: dropped the now-unused `worktree` arg; returns the full `initialDraftsByWorktree` (the migrated base) as the all-bucket seed. Removed the dead single-bucket `activeDraftsProjection`/`initialDrafts`.
- `app/ui/src/hooks/useWorkspaceState.ts`: threads `projectPath` + the full record into `useFileState`; `snapshotDrafts` drops the `projectName`→`projectPath` remap (keys already match); the drafts-save debounce keys on **`filesByWorktree`** (the whole store) not the active `files`, so a save/accept landing in a now-background bucket is still scheduled (durable side of #3a — a crash can't resurrect a draft the user saved away).
- `app/ui/src/hooks/workspaceTypes.ts`: removed the now-dead `PersistedDrafts` type + `worktreeDraftKey` helper.
- **No-remount correctness (scope extension, from the cross-provider review — all data-loss-adjacent under no-remount):**
  - `app/ui/src/hooks/useApi.ts` (`useFileTree`): the load effect is now a `useLayoutEffect` that **clears `data` + `loadedDirs` pre-paint** on a worktree switch, so the explorer never renders the old worktree's rows — a destructive op (delete/move/rename) armed on a stale row would otherwise execute against the newly selected worktree.
  - `app/ui/src/components/FileExplorer.tsx`: a `useLayoutEffect` **resets the armed interaction state** (context menu, pending create, delete confirm) on a worktree switch, so a confirm carried across the switch can't target the new worktree.
  - `app/ui/src/workspace/useWorkspaceDiff.ts`: the diff cache key now includes `worktree`, so the diff view re-points on a switch instead of showing the previous worktree's parsed diff (and never collides across worktrees on one path).
  - `app/ui/src/components/WorktreePicker.tsx`: the dropdown's `DialogShell` uses `restoreFocus={false}` — with the trigger surviving the switch (no remount), returning focus to it left a focused toggle that a later stray Enter (confirming quick-open) re-activated, reopening the dropdown (caught by the `worktree-persist` e2e).
- Tests: `useFileStateWorktree.test.ts` (+ #3a acceptDisk-survives-switch), `persistenceSchema.test.ts` (no-remount shell-holds-still + #3b restore + #3b partial-hydration prune guard + HIGH-2 background-save persists via debounce), `useFileTreeWorktree.test.ts` (+ stale-tree-cleared-on-switch). Signature updates in `sharedBufferGc.test.ts`, `inlineSuggestionsDefault.test.ts`.

**Why:**
- A git worktree is a *view* (which working directory am I looking at), not a workspace-identity dimension. The remount made every switch destroy the editor tabs/terminals/layout — the opposite of "a worktree is just a directory." Dropping the remount makes the file views re-point while the shell holds still. The persistence-schema task already made layout/drafts project-keyed and forward-compatible; this task is the activation flip. The two no-remount-only items its review deferred (#3a/#3b) became live here and are handled; the review additionally surfaced that, without a remount to reset them, a stale explorer tree and an armed delete dialog could fire against the wrong worktree — fixed pre-paint.

**Key files:** `app/ui/src/App.tsx`, `app/ui/src/hooks/{useFileState,usePersistence,useWorkspaceState,workspaceTypes,useApi}.ts`, `app/ui/src/components/{FileExplorer,WorktreePicker}.tsx`, `app/ui/src/workspace/useWorkspaceDiff.ts`, tests under `app/ui/src/hooks/__tests__/`.
**Verification:** `app/ui` `npx tsc -b` + `npm run lint` + `npm test` (1085 passed, incl. the new no-remount / #3a / #3b / HIGH-2 regressions). e2e `worktree.spec.ts` + `worktree-persist.spec.ts` → **8 passed** (incl. the previously-failing "layout is project-global" that the flip fixes, and "unsaved drafts do not bleed" after the WorktreePicker focus fix). Cross-provider Codex review (4 rounds → APPROVE, 0 unresolved critical/high): r1 SEND_BACK (2 HIGH: stale-explorer destructive write, background-save not scheduled) → r2 (1 HIGH: passive resets leave a stale frame) → r3 APPROVE (useLayoutEffect) → r4 APPROVE (WorktreePicker focus fix). Artifacts under `plan/all/worktree-explorer-view/`.
**Design:** [plan/all/worktree-explorer-view/design.md](../plan/all/worktree-explorer-view/design.md) §P3 sever-1/sever-2.
**Next:** P3 is complete (P1 git-source + P2 header picker + filestate-projection + persistence-schema + decouple-sessions + drop-remount all landed). Follow-ups noted in the design's Non-goals: external-path session labels; an optional explicit "open terminal in this worktree" affordance.
**Blockers:** None.

## 2026-06-24: Project-level multi-bucket draft schema + lossless worktree migration (worktree-explorer-view P3 persistence-schema)

**What changed:**
- `app/ui/src/hooks/workspaceTypes.ts`: added `PersistedDraftsByWorktree = Record<worktreeKey, Record<relpath, entry>>` — the on-disk drafts record, one bucket per worktree (key = abspath; primary = `projectPath`). `PersistedDrafts = { files }` stays as the **active-bucket projection** `useFileState` consumes (kept out of scope). `draftsKey(project)` / `layoutKey(project)` drop the worktree arg (layout + open-tabs are project-global). New `worktreeDraftKey(projectPath, worktree) = worktree || projectPath`.
- `app/ui/src/hooks/usePersistence.ts`: `usePersistence(projectName, projectPath, worktree)`. New `loadDraftsByWorktree(project, projectPath)` migration — folds legacy primary `yaco-drafts:${project}` **and** legacy `yaco-drafts:${project}:wt:<suffix>` blobs into the abspath-keyed record (the `:wt:` suffix is the raw worktree id: an abspath post-P1 is the key verbatim, a bare slug pre-P1 resolves to `${projectPath}/.worktrees/<slug>`), a newer multi-bucket bucket winning over a stale legacy fold. Runs synchronously at mount into a base ref; `flushDrafts` overlays the live snapshot onto that base so a background / migrated-but-unvisited bucket is never clobbered by an active-only save (the r2 first-save data-loss gate is structural). A one-shot `commitDraftMigration` mount effect persists the merged base and **retires the legacy `:wt:` keys** so an emptied-then-pruned bucket can never resurrect from a stale key. `saveDrafts` writes the multi-bucket record, prunes empty buckets, and evicts the oldest `(bucket, path)` entries across all worktrees on quota. `loadPersistedState` / `saveLayout` are project-only.
- `app/ui/src/hooks/useFileState.ts`: exposes the whole per-worktree store as `filesByWorktreeRef` (design §4 "useFileState — persistence reads all buckets"). This is the all-bucket flush surface — it reflects background-bucket mutations too, so a `save`/`acceptDisk` that completes into a now-background worktree after a switch never gets a stale draft written back. (Additive: the active `files`/`filesRef` projection is unchanged.)
- `app/ui/src/hooks/useWorkspaceState.ts`: `useWorkspaceState(projectName, projectPath, worktree)`. The drafts flush snapshot serializes EVERY live bucket from `filesByWorktreeRef` (not just the active projection), remapping useFileState's `projectName`-keyed primary bucket to the persistence `projectPath` key. So a dirty draft in a background worktree is flushed ("all buckets serialized"); an unvisited worktree (absent from the store) leaves its persisted draft in the base; a present-but-empty bucket prunes (a genuine clear).
- `app/ui/src/workspace/WorkspaceProvider.tsx`: threads `projectPath` into `useWorkspaceState` (one-line glue — the only edit outside the three persistence hooks; `projectPath` was already in scope there).
- Tests: new `hooks/__tests__/persistenceSchema.test.ts` (legacy `:wt:<slug>` + primary migrate with no loss; multi-bucket-wins precedence; corrupt-blob resilience; active-bucket projection; all-bucket flush; base-overlay preserves an unvisited bucket; A→B→A round-trip through persistence; empty-bucket prune). Updated `layoutMigration.test.ts` (project-global layout contract; old per-worktree layout key ignored), `inlineSuggestionsDefault.test.ts`, `routingWire.test.ts` for the new signatures.

**Why:**
- Once a worktree stops remounting the workspace (the P3 decouple), drafts can no longer live under per-worktree localStorage keys: open tabs and layout are a single durable project shell, while each worktree keeps its own unsaved edits. The schema moves the worktree dimension *inside* one `yaco-drafts:${project}` record keyed by abspath, mirroring the already-merged `filesByWorktree` store in `useFileState`. Migrating the legacy slug-keyed keys before the first save is mandatory or existing unsaved edits would be lost (design review §2 / r2 §B).

**Key files:** `app/ui/src/hooks/{workspaceTypes,usePersistence,useWorkspaceState,useFileState}.ts`, `app/ui/src/workspace/WorkspaceProvider.tsx`, `app/ui/src/hooks/__tests__/persistenceSchema.test.ts`, `app/ui/tests/e2e/worktree-persist.spec.ts`
**Verification:** `scripts/verify.sh` green (cli test + server test + ui lint + root build/tsc -b); `app/ui` `npx tsc -b` + `npm run lint` + `npm test` (1080 passed, incl. 15 P3 persistence-schema tests) + `worktree-persist` e2e (4 passed). Cross-provider codex review (7 rounds → APPROVE, 0 unresolved critical/high in scope) + `/qa` evidence under `plan/all/worktree-explorer-view/`.
**Design:** [plan/all/worktree-explorer-view/design.md](../plan/all/worktree-explorer-view/design.md) §P3 "Persistence schema + migration".
**Next:** The P3 decouple task drops `activeWorktree` from the `App.tsx` remount key; this schema is forward-compatible (the flush already reads the whole `filesByWorktreeRef`). That task OWNS full no-remount draft fidelity — `useFileState` restoring ALL persisted buckets up front + hydrating a switched-to worktree (so a partially-hydrated bucket can't serialize `{}` and prune a base draft), and revisiting `acceptDisk`'s switch-abort. Under the current remount model each switch reloads the complete bucket, so the flush serializes complete buckets.
**Blockers:** None.

## 2026-06-24: Sessions decoupled from the selected worktree (worktree-explorer-view P3 sever-3)

**What changed:**
- `app/ui/src/workspace/WorkspaceProvider.tsx`: threads the **base** `projectPath` (not `effectivePath`) into `useWorkspaceData`. The `projectPath` slot feeds only the sessions resource; git follows the worktree via the separate `worktree` (abspath) arg. New sessions now spawn at the project root regardless of the selected worktree.
- `app/ui/src/workspace/panels/SessionsPanel.tsx`: history resume uses `env.project.path` (base root), not `effectivePath`.
- `app/ui/src/workspace/resources.ts` + `useWorkspaceSessions.ts`: comments narrowed — `WorkspaceSessionsResourceOptions.projectPath` is the new-session cwd (base root), decoupled from the worktree.
- Tests: `__tests__/resources.test.ts` (data layer — list fetches `?project=` with no `worktree=`, git status carries `worktree=<wt>`, new-session POST `cwd = base`), `panels/__tests__/SessionsPanel.test.tsx` (resume cwd = base with a worktree selected; list parity).
- Doc: `doc/main/app/frontend/components.md` — corrected the drifted claim that session cwd resolves against `effectivePath`; it now uses the base `projectPath`.

**Why:**
- A git worktree is a *view*, not a workspace-identity dimension (design §2). Conflating "which worktree am I viewing" with "where a new terminal spawns" re-introduces the category error. Worktree-bound agent runs go through the task/orchestration layer with an explicit cwd; an interactive session always starts at the project root. The session **list** was already projectName-keyed, so it was identical across worktrees already. `effectivePath` now narrows to file/git views only. Sever-1/sever-2 (no-remount + per-project layout/persistence) and the per-worktree editor-content keying are separate P3 slices, not in this task.

**Key files:** `app/ui/src/workspace/{WorkspaceProvider.tsx,resources.ts,useWorkspaceSessions.ts,panels/SessionsPanel.tsx}`, tests `__tests__/resources.test.ts` + `panels/__tests__/SessionsPanel.test.tsx`, `doc/main/app/frontend/components.md`.
**Verification:** `scripts/verify.sh` green (cli · server · ui lint · build=`tsc -b`). `app/ui`: `tsc -b` + `npm run lint` clean, full vitest 1049 passed (incl. 4 new P3 tests). Cross-provider review (Codex `codex-hasty-frank-delta-301d2d`): APPROVE, 0 critical/high; 2 LOW (data-layer test gap + comment accuracy) resolved in the code commit. QA: 4 flows PASS; e2e worktree view-following 7 passed; `worktree-persist.spec.ts:89` (per-worktree *layout* persistence) is a **pre-existing** failure for sever-1/2, reproduced at base with the P3 source reverted — out of scope. Artifacts: `plan/all/worktree-explorer-view/{impl-plan,code-review,qa}_p3-decouple-sessions.md`.
**Commit:** `713ac3f3` (code) + docs tail.
**Next:** P3 sever-1/sever-2 (drop `activeWorktree` from the `App.tsx` remount key + `useWorkspaceState`/`usePersistence` worktree arg; layout/drafts project-keyed) and the per-worktree file-content keying.
**Blockers:** None.


## 2026-06-24: Worktree picker in the Files header; drop the ProjectList sub-list (worktree-explorer-view P2 frontend)

**What changed:**
- New `app/ui/src/components/WorktreePicker.tsx`: the worktree selector now lives in the File Explorer header. Trigger = `GitBranch` + the current branch, composed INSIDE `useFilesHeader`'s existing `flex items-center` actions row (the header-actions-one-row constraint — appending after the actions div wraps a control into the resize-handle hit zone). Body-anchored, fixed-position dropdown (the `RefSearchDropdown`/`DialogShell` technique — anchor ref + `position:fixed`, so it escapes the header) lists every git-sourced worktree by **branch**, tags the main working tree with a `primary` chip, and shows a dirty dot + ahead/behind per row. Select → `env.selectWorktree(id | null)`; the primary maps to `null`. Current-entry resolution is active-match → primary → first (so a stale selection never shows a linked branch).
- `components/ProjectList.tsx`: renders **projects only**. The worktree sub-list and the active-click worktree reset are gone; `activeWorktree`/`worktrees`/`onWorktreeSelect` props removed; `isMainActive` collapses to `isActive` (the active project always gets the full highlight). `ProjectsPanel.tsx` drops the three props at the one call site.
- `components/FileExplorer.tsx`: unchanged — copy/reveal/mutations already thread the selected worktree **abspath** (`worktree ?? projectPath`) from P1; now covered by the e2e re-root flow.

**Why:**
- P2 of the worktree-as-explorer-view design (§P2): a worktree is "which working directory am I looking at", so its selector belongs in the file-view header next to Compare-refs, not as a workspace-identity sub-list under the project. Git-sourced (P1) means manual/external worktrees now appear. The decouple (no remount, per-worktree editor content/drafts, persistence schema) stays **P3** — P2 changes only where the selector lives and what ProjectList renders.

**Key files:** `app/ui/src/components/WorktreePicker.tsx` (new), `workspace/panels/FilesPanel.tsx`, `components/ProjectList.tsx`, `workspace/panels/ProjectsPanel.tsx`.
**Verification:** `cd app/ui && npx tsc -b && npm run lint && npm test` → 82 files, 1056 tests pass (incl. new FilesPanel picker tests that click the real trigger/dropdown and assert the bound id, and ProjectList "projects only" tests). e2e `worktree.spec.ts` rewritten to the header picker: 4/4 pass (lists worktrees by branch + primary chip; selecting one re-roots the explorer to its tree; primary returns to main). Cross-provider review (Codex, independent context): APPROVE, 0 critical/high; 1 LOW (stale-selection fallback order) fixed in `c5ba6d6`. Artifacts: `plan/all/worktree-explorer-view/{code-review_p2-frontend,qa_p2-frontend}.md`.
**Commit:** `62ab000a` (feat) · `c5ba6d6e` (LOW fix) · `37e9ff88` (e2e) (+ docs).
**Next:** P3 — filestate projection, session decouple, persistence schema (abspath `:wt:` keys + migration; `worktree-persist.spec.ts` rewrite rides here), drop-remount.
**Blockers:** None.
## 2026-06-24: Per-worktree file-state store + active projection + race guards (worktree-explorer-view P3)

**What changed:**
- `app/ui/src/hooks/useFileState.ts`: moved the per-worktree dimension INSIDE the hook as `filesByWorktree: Record<worktreeKey, Record<relpath, FileState>>` (`worktreeKey = activeWorktree ?? projectName`). `files` and `filesRef.current` project the **active** bucket, so every relpath consumer (EditorPanel / WorkspaceEditorColumn / GroupTabBar / PanelGroup / MobilePanelProjection / useWorkspaceState) is unchanged. Open tabs re-fetch on worktree switch; drafts are per-worktree and restored on return; `gcBuffers`/retarget/remove act on the active bucket only (background drafts survive). Saves/force-save/accept-disk land in their **captured** worktree bucket. Dirty/conflict signatures switched from a NUL char-join to `JSON.stringify(sorted)` (collision-free, same identity-stability).
- `app/ui/src/hooks/useApi.ts` (`useFileTree`): captured-worktree + per-worktree-epoch AbortController guards on `loadRoot`, `expandDir` child loads, and the SSE refresh, on **both** success and failure paths (a stale failure never `setError`s on the new worktree nor deletes its `loadedDirs`); the current-worktree ref moved to `useLayoutEffect` so it is current before any fetch callback runs.
- Tests: `__tests__/useFileStateWorktree.test.ts` + `__tests__/useFileTreeWorktree.test.ts` — active-projection identity, per-worktree draft isolation/restore, stale content-fetch drop, stale SSE-refetch drop via the captured-key check alone, stale `loadRoot` (success + failure) drop, stale `expandDir` child-fetch drop.

**Why:**
- The load-bearing piece of the worktree-as-view redesign: once the workspace stops remounting per worktree, a stale fetch from worktree A could resolve into worktree B's view. Keeping the per-worktree dimension inside `useFileState` (relpath public contract intact, CLAUDE.md "keep v1 mechanical") plus captured-worktree + abort guards on every file/tree fetch makes worktree switching re-point editor content with **no cross-worktree leak**. Cross-provider codex review (3 rounds) drove the `loadRoot` captured check + the layout-effect ref + the failure-path guards. **Not yet UI-reachable**: `App.tsx` still remounts `<Workspace>` on a worktree switch — the no-remount projection is unit-tested, awaiting the later `drop-remount` task.

**Key files:** `app/ui/src/hooks/useFileState.ts`, `app/ui/src/hooks/useApi.ts`, `app/ui/src/hooks/__tests__/useFileStateWorktree.test.ts`, `app/ui/src/hooks/__tests__/useFileTreeWorktree.test.ts`; docs `doc/main/app/frontend/hooks.md`, `state.md`; evidence `plan/all/worktree-explorer-view/{code-review,qa}_p3-filestate-projection.md`
**Verification:** `scripts/verify.sh` green (cli + server tests, ui lint, root build w/ `tsc -b`); `cd app/ui && npx tsc -b` + `npm run lint` + `npm test` → 84 files / 1053 tests; focused Playwright e2e (worktree / multi-instance-editors / file-create / empty-editor) → 12 passed; cross-provider codex review APPROVE (0 unresolved critical/high).
**Commit:** code `100ec21d`; this doc/evidence commit is a docs-only tail (no code change).
**Next:** `drop-remount` (App.tsx remount key drops `activeWorktree`) + `persistence-schema` (all-bucket draft flush + legacy migration) make this projection UI-reachable.
**Blockers:** None

## 2026-06-24: Frontend worktrees — git-sourced list + abspath identity (worktree-explorer-view P1 frontend)

**What changed:**
- `app/ui/src/hooks/useProjectWorktrees.ts`: fetches `GET /api/worktrees/:project` (git-sourced — primary + manual/external worktrees) instead of deriving the list from `/api/tasks` (active-task-linked only). New `WorktreeInfo` shape `{ id, name, branch, head, isPrimary, dirty, ahead, behind }`; `id` is the worktree's **absolute path**, replacing the `.worktrees/<slug>` slug. SSE `filetree`/`worktrees` refresh, 60s poll, and the `currentProject` stale-guard preserved.
- Worktree identity threaded through `env.project.worktree` is now that abspath, so every `?worktree=` caller carries it url-encoded with no further change: `appendWorktree` (`useApi.ts`, doc-only), the quick-open (`quickOpenIndex.ts`) and text-search (`WorkspaceTextSearch.tsx`) builders were already abspath-safe. `effectivePath = activeWorktree ?? projectPath` (was `${projectPath}/.worktrees/${worktree}`).
- `App.tsx`: localStorage selection (`yaco-worktree:<project>`) stores a path; the stale-selection-clear effect drops any value not in the loaded git list, guarded on a **non-empty** list so a valid restored path isn't clobbered while `useProjectWorktrees` reloads on a project switch.
- Forced consequences of the shape/semantics flip (not P2 UX work): `ProjectList` sub-list keys/labels by `wt.id`/`wt.name` and filters the primary; `FileExplorer` copy-absolute-path uses `worktree ?? projectPath` (the twin `.worktrees/<slug>` reconstruction); `ProjectsPanel` test fixture updated.

**Why:**
- The task-derived list only surfaced worktrees a live task pointed at, so manual / archived-task / external worktrees were invisible — the core visibility bug. Git is the real source of truth. Abspath identity matches the already-merged server contract (the realpath-allowlisted `?worktree=` middleware) and unlocks worktrees at arbitrary locations. The session decouple, no-remount-on-switch, and per-worktree editor content/drafts are deliberately **P3** — P1 changes only the source + identity and preserves prior session/remount behavior (no regression).

**Key files:** `app/ui/src/hooks/useProjectWorktrees.ts`, `App.tsx`, `workspace/WorkspaceProvider.tsx`, `workspace/context.ts`, `hooks/useApi.ts`, `components/ProjectList.tsx`, `components/FileExplorer.tsx`.
**Verification:** `cd app/ui && npx tsc -b && npm run lint && npm test` → 82 files, 1047 tests pass. Cross-provider review (Codex, 2 rounds): R1 SEND_BACK (1 high = session-still-uses-effectivePath, accepted as P3-deferred; 1 medium = stale-selection over-clear, fixed `23c160f6`); R2 APPROVE for P1 scope (0 unresolved critical/high). QA (5/5 flows, real handlers + a real external worktree): git-sourced list incl. primary, `?worktree=<abspath>` re-roots file reads (internal + external), garbage → 404. Artifacts: `plan/all/worktree-explorer-view/{impl-plan_p1-frontend,code-review_p1-frontend,qa_p1-frontend}.md`.
**Commit:** `d522840d`..`23c160f6` (+ docs).
**Next:** P2 (File-Explorer header worktree dropdown; remove the ProjectList sub-list) and P3 (filestate projection, session decouple, persistence schema, drop-remount), coordinated by the orchestrator.
**Blockers:** None.

## 2026-06-24: `withProject` `?worktree=` — slug contract → realpath-allowlisted abspath (worktree-explorer-view P1 middleware)

**What changed:**
- `app/server/src/middleware/project.ts`: the `?worktree=` query param is now an **absolute path**, not a slug. Validation builds an allowlist from the configured project root's `git worktree list --porcelain` (reusing `listRegisteredWorktrees`), `realpath`-canonicalizes both the registered paths and the candidate, and requires the candidate to exist and **exactly equal** an allowlisted realpath — git is never run inside the submitted path. Anything else → **404** (replacing the old slug-regex 400 + `.worktrees/<slug>` prefix check). Gated on **presence**, not truthiness, so a bare/empty `?worktree` also 404s instead of silently resolving the primary. A passed-primary abspath collapses back to the base `project.path`.
- Tests: new `middleware/__tests__/project.test.ts` (listed internal/external abspath resolve; primary collapse; unlisted / stale / raw-`..` traversal / symlink-escape / non-absolute / empty / bare → 404); `routes/__tests__/git-status.test.ts` worktree-isolation test rewritten onto a real `git worktree add` + abspath.

**Why:**
- The slug + string-prefix check assumed `.worktrees/<slug>` and could be defeated by a symlink under `.worktrees/` escaping the repo. Using git as the allowlist with realpath on both sides closes that hole and unlocks worktrees at arbitrary locations (the P1 source-of-truth change identifies worktrees by abspath). Edge → canonical: a passed-primary collapses to base so the git-status/colocated caches keep one identity per worktree (no cross-worktree stale state).

**Key files:** `app/server/src/middleware/project.ts`, `app/server/src/middleware/__tests__/project.test.ts`, `app/server/src/routes/__tests__/git-status.test.ts`.
**Verification:** `cd app/server && npm test` → 42 files, 751 tests pass. Cross-provider review (Codex, 2 rounds): R1 SEND_BACK (0 critical / 1 high — present-but-empty `?worktree` bypass + a false-green traversal test) fixed at `20df18dd`; R2 APPROVE (0/0). Artifacts: `plan/all/worktree-explorer-view/{code-review_p1-middleware,qa_p1-middleware}.md`.
**Commit:** `3d1e511d`..`20df18dd` (+ docs).
**Next:** P1 frontend (`appendWorktree`/`useProjectWorktrees`/`effectivePath` → abspath) and P2/P3, coordinated by the orchestrator. Frontend still sends slugs on this branch.
**Blockers:** None.

## 2026-06-24: gate.sh — a doc-only diff no longer false-fails the `doc` check (codify-process-gate v1 follow-up)

**What changed:**
- `scripts/gate.sh`: the `doc` check is owed on *any* change, and previously passed only via a `doc/**`/`PROGRESS.md` path or a `docs:`-prefixed commit. A pure-documentation diff — a design doc or task-graph under `plan/` — committed with a natural non-`docs:` prefix (`design:`, `plan:`, `chore:`) wrongly reported `doc=fail`, blocking `yaco task set <leaf> done` / the `/implement` self-check on work that *is* documentation.
- Fix: a `doc_only` floor — a diff with no code (`src|cli|app`), no `app/ui`, and *every* changed file under the `doc/` or `plan/` trees — short-circuits `doc=pass`. A diff confined to those trees is its own doc-sync. Any path outside them flips `doc_only` off, so a mixed diff still owes `doc/PROGRESS` or a `docs:` commit exactly as before.
- Two leaks closed during independent review (below): the floor now uses `git diff --name-only --no-renames` so a `git mv cli/x.ts plan/x.md` can't hide the code source behind the doc destination; and `doc_only` is scoped to the `doc/`/`plan/` trees (not a bare `*.md` match), so behavior-bearing markdown — agent-config skill prompts, `CLAUDE.md`/`AGENTS.md` — still owes doc evidence rather than being auto-passed.

**Why:**
- The `doc` check conflated "a code change is accompanied by docs" with "this change *is* docs." For a diff confined to the doc trees there is no separate code to record, so requiring `doc/`/`PROGRESS`/`docs:` evidence was a false positive on design/planning tasks. Edge case turned canonical (a doc-tree-only change owes no separate doc evidence) rather than special-cased — while keeping behavior-bearing markdown and relocated code on the hook.

**Key files:** `scripts/gate.sh`, `scripts/gate.test.sh`.
**Verification:** `scripts/gate.test.sh` 15/15 — case 2 flipped to `doc-only plan/ -> doc pass`; new cases: `behavior .md outside doc trees not doc_only -> doc fail` (skill prompt), `mixed non-doc+plan, no evidence -> doc fail` (anti-leak guard), `renamed code->plan is not doc_only -> verify+review owed` (rename guard); case 3c reworked to a mixed diff so the `docs:`-subject detection (and its pipefail/SIGPIPE guard) stays covered. Independent cross-provider review (Codex), three rounds, each a real catch: R1 rename leak → `--no-renames`; R2 bare-`*.md` admitting behavior markdown → scoped to `doc/`/`plan/`; R3 clean. `gate.sh` is interpreted by path, so the fix is live on merge with no re-install.


## 2026-06-24: Gate skill-wiring — point /implement, /verify, /qa, /orchestrate at the built gate (codify-process-gate v1 · T4, final leaf)

**What changed:**
- **/verify**: execution entry is the repo's single `scripts/verify.sh` (source of truth — `/verify`, `yaco gate`, and any hook run the identical checks); the Stack Detection + Verification Phases are reframed as a *guide* to the dimensions verification covers, not a per-stack copy of build/lint/test commands.
- **/implement**: the *Finish* section runs `yaco gate` as the self-check and finishes only all-green (a red check → keep going); the *Code Review* artifact path moved off "design-doc folder or project root" onto the `/yaco-paths`-resolved bundle home and its header now also carries the **reviewed sha** (HEAD) the gate keys freshness on; Usage + Step 1 record the convention that a manual /implement opens a task into the **active** set (its contract/visibility home), auto-archived on completion.
- **/qa**: emits a **sha-stamped artifact** (`reviewed_sha = <exercised tree sha>`) to the `/yaco-paths` bundle home, not just stdout — closing the one floor-evidence gap the gate couldn't read (review artifacts already self-stamp; qa didn't).
- **/orchestrate**: the *Gatekeep* step collapses the former multi-path evidence read (re-run `/verify`, hunt the review artifact, re-derive qa flows) into reading **one `yaco gate` result** (`data.checks` + `data.dirty`). The two things a diff-only gate can't see stay orchestrate's own overlays — acceptCriteria (gate never reads the task) and review **independence** (v1 gate `review` check is existence-only, so a self-authored review would otherwise pass). Merge-up / worktree model unchanged.
- SOTA sync: `doc/main/agent-config/architecture.md` (orchestrate gatekeep now "one `yaco gate` result + two overlays"), `doc/dev/README.md` (gate verb + skill wiring now landed, not "later tasks").

**Why:**
- Final leaf of codify-process-gate v1: the mechanism (`scripts/{verify,gate}.sh`, `yaco gate`, the set-done guard) shipped in T1–T3; T4 makes the skills *call* it, so the "silent skipped-step" failure mode is wired shut from the prose side too. Pure SKILL.md prose — no runtime change. Per the no-rationale-in-artifact rule, the "why" lives here, not in the skills.

**Key files:** `agent-config/global/skills/{implement,verify,qa,orchestrate}/SKILL.md`, `doc/main/agent-config/architecture.md`, `doc/dev/README.md`, `plan/all/codify-some-process/{gate-skill-wiring-plan,review_codex_gate-skill-wiring}.md`.
**Verification:** Prose-only diff touching `agent-config/` + `plan/` — no `(src|cli|app)/` paths, so the repo gate's `verify`/`review`/`qa` checks skip and only `doc` applies (satisfied by these `docs(...)` commits); no build/lint/test surface affected. Acceptance re-confirmed by reading the edited files: `/implement` Finish references `yaco gate` and finishes all-green + review path uses `/yaco-paths`; `/verify` points at `scripts/verify.sh`; `/qa` writes a sha-stamped artifact; `/orchestrate` Gatekeep reads one `yaco gate` result. Independent cross-provider review (Codex), two rounds: round 1 (`w-review-gsw`, base `b585728`) → fail / 0 critical / 3 high — two HIGH (verify phases overstated the script's steps; implement review header lacked reviewed_sha) + one MEDIUM (path under-specified) fixed at `2c2ddd2`; the third HIGH (drop the orchestrate independence overlay) was contested with its design basis (v1 gate `review` check is existence-only, so dropping it would let a self-authored review pass; `design.md` §6.2/§9, `tasks.md` §非目标). Round 2 (fresh agent `w-review-gsw-r2`, current tree) re-reviewed the four files, confirmed both fixes RESOLVED, and adjudicated the overlay (AGREE — additive, not a regression), issuing a **reviewer-issued** `VERDICT: pass  unresolved_critical=0  unresolved_high=0  reviewed_sha=2c2ddd2`. Review artifact: `plan/all/codify-some-process/review_codex_gate-skill-wiring.md` (codex round-2 output quoted verbatim).
**Commit:** `b585728` (wiring) + `2c2ddd2` (review fixes) + this docs commit
**Next:** v1 complete (T1–T4). v2 (T5 sha-cache, T6 Stop-hook loop) adds the teeth; v3 (T7–T8) makes review/qa verdict sections parseable.
**Blockers:** None.


## 2026-06-24: Set-done gate guard — leaf-→-done runs the exit gate (codify-process-gate v1 · T3)

**What changed:**
- `yaco task set` now refuses to mark a *leaf* `done` when the repo's exit gate is red or the session's worktree is dirty. Inside `runSet`'s locked block — after `validateState`/`rollup`/`stateEnteredAt`, before `saveTaskStore` — `guardLeafSetDone` runs `runGate(process.cwd())` and throws `CliError(INVALID)` (exit 1) listing the gaps (`failing checks: …` and/or `worktree has uncommitted changes`) when any check is `fail` or `dirty`, so a red gate persists nothing.
- The guard fires on *exactly* a leaf transition into `done` (`state==="done" && oldState!=="done" && !hasChildren`). A milestone reaching `done` by `rollup()` is a different id the guard never inspects, so rollup-to-done is not gated.
- Added `findGateScript(cwd): string | null` to `cli/src/lib/core/gate/index.ts`: the guard is **dormant** (returns early) unless the worktree has `scripts/gate.sh`, so projects that haven't adopted the gate keep marking leaves done. `runGate` itself stays fail-closed for the explicit `yaco gate` verb.
- gitignored `*.lock.d/`: the task-store lock dir is held *inside* the repo while the guard runs, so without this the untracked lock would read as a dirty tree and spuriously refuse every leaf-→-done.

**Why:**
- v1 of codify-process-gate makes "silently skipping the verify floor" impossible: the gate is enforced at the moment a leaf is declared done, against the session's own diff (design §7④), reusing the same `runGate` the `yaco gate` verb (T2) exposes.
- **`--json` envelope discipline (review HIGH):** the guard first inherited `gate.sh`'s verify-heavy stderr, so a red gate streamed progress *before* the one-line `{ok:false,error}` envelope; app/server's `runYacoTask` JSON.parses the whole stderr, turning a clean 400 INVALID into a 500 INTERNAL. Fixed by `runGate(cwd,{stderr})` — `"ignore"` under `--json` (discarded, never captured, so no spawnSync/ENOBUFS regression), `"inherit"` in text mode for live progress; `yaco gate` keeps the inherit default.

**Key files:** `cli/src/commands/task/set.ts` (guardLeafSetDone), `cli/src/lib/core/gate/index.ts` (findGateScript, RunGateOptions.stderr), `cli/test/gate.test.ts` (5 guard tests), `.gitignore`.
**Verification:** `cd cli && bun run test` → 1077 pass / 0 fail (guard suite 22/0); `bunx tsc --noEmit` clean. Guard tests drive the real CLI subprocess against a stub `scripts/gate.sh`: RED→exit 1 naming the failing check (write not persisted); GREEN+clean→done; GREEN+dirty→refused; milestone rollup→done not gated under a red gate; no `scripts/gate.sh`→dormant. Independent cross-provider review (Codex) found one HIGH (the `--json` stderr envelope pollution above); fixed at 4443ec50 + a whole-stderr-parse regression assertion; re-review verdict APPROVE / 0 unresolved. Review artifact: `plan/all/codify-some-process/review_codex_set-done-gate-guard.md`.
**Commit:** eef61b38 (guard) + 4443ec50 (review fix) + this docs commit
**Next:** T4 gate-skill-wiring (point /implement, /verify, /qa, /orchestrate at `yaco gate` / `scripts/verify.sh`).
**Blockers:** None.


## 2026-06-24: Thin `yaco gate` verb over scripts/gate.sh (codify-process-gate v1 · T2)

**What changed:**
- Added `yaco gate [--base <ref>] [--json]` — a thin verb wrapping the repo's `scripts/gate.sh` (T1). `runGate(cwd,{base?})` resolves the session's working-tree root (`git rev-parse --show-toplevel`), computes the default base as `merge-base(HEAD, main)`, runs `<root>/scripts/gate.sh <base>`, parses its last stdout line as the `{verify,doc,review,qa}` checks JSON, detects a dirty worktree, and returns `{ok, data:{base, sha, checks, dirty}}`. `ok=false` iff some check is `fail`.
- Added `getMergeBase(repoRoot, head, base)` to `cli/src/lib/core/worktree/git.ts` (thin `git merge-base` wrapper; exported + re-exported from the worktree index).
- Registered the `gate` area in `cli/src/main.ts` (AREAS + help + handler), and added `cli/test/gate.test.ts` to the `test:unit` allowlist.

**Why:**
- v1 of codify-process-gate keeps the mechanism in the CLI and the checks in `scripts/*.sh`. The verb is the ~10-line shell-wrapper agents call as `yaco gate --json` to self-check; the SAME `runGate` is what the later set-done guard (T3) and Stop hook (T6) call directly, so the lib is the contract and the command is one caller.
- **Root = `show-toplevel`, not the common-dir primary:** `gate.sh` self-locates and diffs its own tree, so a linked worktree must run its own checked-out `scripts/gate.sh` to gate its own diff (design pillar: "gate sees the session's diff").
- **Doctor-style status envelope:** a red gate is a status, not a CLI error — `{ok,data}` on stdout, exit 0/1 by verdict; `dirty` is a separate signal (does not flip `ok`) so a set-done guard can refuse on it. Hard "couldn't run" conditions still throw → `{ok:false,error}` on stderr, exit 3.
- **Stateless in v1:** no sha-cache (that lands when a loop re-running verify makes it earn its keep).

**Key files:** `cli/src/commands/gate.ts`, `cli/src/lib/core/gate/index.ts`, `cli/src/lib/core/worktree/git.ts`, `cli/src/main.ts`, `cli/test/gate.test.ts`, `cli/package.json`; docs `doc/main/cli/gate.md` (+ README/command-surface).
**Verification:** `cd cli && bun run test` → 1072 pass / 0 fail (incl. 17 gate tests, confirmed in the allowlist); `bunx tsc --noEmit` clean. QA — compiled `yaco gate` real-binary sweep (21 assertions): clean→`{ok:true}` all-skip exit 0; verify-red→`{ok:false}` exit 1; dirty→`dirty:true`; default base==`merge-base(HEAD,main)`; usage→exit 2; non-git/missing-script→`ENV` exit 3. Independent cross-provider review (Codex) found one HIGH (spawnSync buffered gate.sh stderr → ENOBUFS on verify-heavy runs); fixed by inheriting/streaming stderr + a multi-MB regression test; re-review verdict pass / 0 unresolved.
**Commit:** b496a383 (verb) + 668a7f70 (review fix) + this docs commit
**Next:** T3 set-done-gate-guard (call `runGate` before a leaf flips to done), then T4 skill wiring.
**Blockers:** None.


## 2026-06-23: Per-repo verify + floor-from-diff gate scripts (codify-process-gate v1 · T1)

**What changed:**
- Added `scripts/verify.sh` — the repo's single verify entry: `cli` bun test → `app/server` test → `app/ui` lint → root build, in fixed order; names the failing step; exits non-zero on the first failure, 0 when all pass.
- Added `scripts/gate.sh <base>` — floor-from-diff aggregator. Computes `git diff <base>..HEAD` itself and maps touched paths to owed checks: code (`src|cli|app`)→`verify` (runs `verify.sh`)+`review`; `app/ui`→`qa`; any change→`doc`. Runs every owed check (no short-circuit), routes all progress to stderr, and prints `{"verify","doc","review","qa": pass|fail|skip}` as the sole/last stdout line. Any `fail` → non-zero exit; not-owed → `skip`.
- `review`/`qa` are existence-only in v1: a `plan/` file (`*review*`/`*qa*`) referencing the current HEAD short sha. `doc` = a `doc/**`/`PROGRESS.md` change or a `docs:` commit since base. No verdict parsing (v3).
- Added `scripts/gate.test.sh` — hermetic 12-case test of the floor mapping; builds throwaway git repos with a stub `verify.sh`, and hard-asserts every fixture op targets the temp root so it can never touch the real repo.
- Documented both scripts in `doc/dev/README.md` (Repo-wide gates).

**Why:**
- v1 of codify-process-gate: make the verify floor a code-enforced exit gate keyed off the session diff, not a per-task declaration — pure shell with no CLI/TS dependency so it is independently testable and callable from a skill, a hook, or a human shell identically.

**Key files:** `scripts/verify.sh`, `scripts/gate.sh`, `scripts/gate.test.sh`, `doc/dev/README.md`
**Verification:** `bash scripts/gate.test.sh` → 12/12; `shellcheck` clean (0 findings); live acceptance — `verify.sh` exits 0 on the green repo (cli + 730 server tests + ui lint + build), non-zero naming `ui lint` on an injected lint error; `gate.sh HEAD` → all-skip JSON exit 0; a committed code change with failing tests → `{"verify":"fail",...}` exit 1. Independent cross-provider review (Codex) found one [high] doc-check SIGPIPE-under-pipefail bug; fixed (capture subjects, grep here-string); re-review verdict pass / 0 unresolved.
**Commit:** 50f885f0 (scripts) + this docs commit
**Next:** T2 `yaco gate` verb (stateless v1), then T3 set-done guard and T4 skill wiring.
**Blockers:** None.


## 2026-06-23: Agent interrupt status heals from transcripts

**What changed:**
- Replaced stale `processing` reconciliation's primary signal with provider transcript-tail classification: Claude interrupt markers / terminal turns and Codex `task_started` / `task_complete` / `turn_aborted(reason:"interrupted")`.
- Lowered active-state recheck latency (`processing`/`blocked`) to ~15s, kept `starting` on the long startup threshold, and made app reconciliation adaptive (~8s while processing, 60s otherwise).
- Added `idleReason:"interrupted"` and threaded it through CLI/app session projection so user-interrupted idle corrections suppress `session_idle` attention edges, boot reconciliation, Ready, Recent, and progress scanner surfaces for that exact generation.
- Added a reconcile mtime/inode guard so an async stale correction cannot overwrite a fresh prompt.

**Why:**
- Claude and Codex do not fire terminating hooks when the user presses ESC, so hook-only status could stay stuck on `processing` or `blocked` until the old 5-minute PTY scrape fallback. Provider transcripts are the durable signal that records interrupts.

**Key files:** `cli/src/lib/core/agent/providers/output.ts`, `cli/src/commands/agent/status.ts`, `cli/src/lib/core/agent/{model,session-state,projection}.ts`, `app/server/src/lib/{attention-engine,attention-projection,attention-runtime,scanner,session-reconciler}.ts`
**Verification:** `cd cli && bun run test:unit` (1055 passed); `cd cli && bun run build && npx tsc -b`; `cd app/server && npm test` (730 passed); `cd app/ui && npm run lint`; QA CLI smoke for interrupt heal + trust-block exclusion passed; independent code review APPROVE. `cd app/server && npx tsc -b` still has pre-existing unrelated baseline errors outside this change.
**Commit:** 1c20425b
**Next:** Optional live manual smoke with real Claude/Codex ESC interrupts after reinstalling the CLI.
**Blockers:** None for this change; app-server project typecheck has unrelated existing failures.

## 2026-06-23: Terminal grid clipped to its own panel box (overflow follow-up)

**What changed:**
- Added `overflow-hidden` on the terminal's private wrapper (`Terminal.tsx`) so the xterm grid can't paint over a neighbouring panel.

**Why:**
- The "terminal text spilling into SESSIONS" symptom was **not** a separate stale-fit bug (the earlier entry's `Next:` guess). Hardware testing (monitor unplug; drag sidebar narrow) showed no overflow — the terminal re-fits every animation frame, so it tracks continuous resizes. The screenshot caught a **single-frame transient** on a one-shot viewport jump (old wide cols for the one frame before the next-rAF re-fit), made large by the then-uncorrected proportions. The proportions fix already removed the visible spill; this clip is belt-and-suspenders for a big one-shot jump / distorted layout. Placed on the terminal wrapper (not the shared group body → would clip panel popovers; not xterm rows → would re-break the right-edge glyph cushion); the fit reserves the per-row cushion so the clip can never eat a glyph.

**Key files:** `app/ui/src/components/Terminal.tsx`
**Verification:** `tsc -b` + eslint clean; glyph-clip safety proven structurally (content ends ≥1 cell inside the wrapper); right-edge eyeball left to the user on live terminals.
**Commit:** 42520e4f
**Blockers:** None

## 2026-06-23: Panel layout keeps relative proportions across viewport changes

**What changed:**
- `WorkspacePanelLayout` gains `refSize:{w,h}` (the viewport its fixed `basis` px were sized for). New pure model fn `relayoutToViewport(layout,w,h)` rescales the tree to a new viewport via `scaleFixedBases` — a uniform per-axis multiply of every fixed `basis` (visible OR hidden, min-clamped).
- A provider `useLayoutEffect` drives it: a rAF-coalesced `ResizeObserver` on the root split applies it pre-paint on mount/project-switch and on every live resize; re-attaches across the mobile/desktop breakpoint (`isMobile` dep) and skips on mobile.
- Removed the per-handle window-resize re-clamp in `usePanelResize` (`maxBasis` still clamps an active drag).

**Why:**
- Sidebars stored absolute px and nothing rescaled on viewport change, so disconnecting an external monitor (or any window shrink) nearly doubled the sidebars' *share* of the screen and collapsed the center (measured left 9.5%→16.8%). Mainstream IDEs are proportional (JetBrains stores 0..1 `weight`; VS Code stores px + reference size and restores proportionally). Adopted the VS Code shape because it reuses absolute `basis` and adds one field.

**Key files:** `app/ui/src/workspace/panelLayoutModel.ts`, `app/ui/src/hooks/workspaceTypes.ts`, `app/ui/src/workspace/WorkspaceProvider.tsx`, `app/ui/src/workspace/usePanelResize.ts`
**Verification:** `tsc -b` + eslint clean; vitest 1047 src tests; Playwright /qa — region shares held 15.3%/19.4% across 2327↔1309 resize, cross-size reopen, mobile↔desktop re-attach, drag-resize. Codex review GO (design + both phases) under `plan/all/20260623_layout-proportions/`.
**Commit:** 69ec03c5, 19f03f46
**Next:** Adjacent (not done): terminal content overflows the SESSIONS panel after a cross-display/DPR change (xterm cols not re-narrowing + no overflow clip) — separate root cause, gated on a hardware discriminating test before designing the fix.
**Blockers:** None

## 2026-06-22: CLI integration tests reinstall the hook binary first

**What changed:**
- Added `cd cli && bun run reinstall` as the explicit CLI reinstall shortcut
  (`../tools/install.sh --cli-only`), and made `bun run test:integration` run it
  before any live tmux/agent tests.
- Documented the installed-binary boundary in CLI dev docs, install SOTA docs,
  README, and `cli/CLAUDE.md`: `bun run build` writes only `cli/yaco`; provider
  hooks call the installed `${YACO_BIN_DIR:-~/.local/bin}/yaco`.

**Why:**
- Live Claude/Codex hooks can silently keep running an old installed binary after
  a local source build. The Codex idle-notice smoke exposed this exact failure
  mode; integration tests now converge the installed binary before exercising
  hook-driven behavior.

**Key files:** `cli/package.json`, `doc/dev/cli/workflow.md`, `doc/main/cli/install.md`, `cli/CLAUDE.md`, `README.md`
**Verification:** `cd cli && bun run reinstall`; `cd cli && bun test ./test/integration/lifecycle-guards.integration.ts --test-name-pattern "Codex hook cycle"`; `python3 agent-config/global/skills/update-doc/scripts/check-docs.py doc`
**Commit:** pending
**Next:** None.
**Blockers:** None

## 2026-06-22: Codex idle notifications carry final message text

**What changed:**
- Codex `Stop` now fills `SessionState.notice` for `session_idle` notifications by
  resolving the session's rollout log from `sessionId` and reading the last
  `final_answer`. Claude keeps its hook-provided transcript-tail path.
- The existing attention pipeline is unchanged: server/app still consume the same
  state-file `notice`, so toast, bell, OS notification, and read-back all get the
  Codex final message through the stable message path.

**Why:**
- Notification message transport is now stable, and Codex already had a rollout-log
  final parser for `agent output` / `wait`; the missing piece was wiring that parser
  into the idle hook notice fill.

**Key files:** `cli/src/lib/core/agent/hook-event.ts`, `cli/test/hook-event.test.ts`, `cli/test/integration/lifecycle-guards.integration.ts`, `doc/main/app/ui/notifications.md`, `doc/main/cli/providers.md`
**Verification:** `cd cli && bun run test` (1038 passed); `python3 agent-config/global/skills/update-doc/scripts/check-docs.py doc`; `bash tools/install.sh` + Codex lifecycle smoke passed; QA recorded in `plan/all/codex-idle-notice/qa.md`
**Commit:** 20f19529
**Next:** None.
**Blockers:** None

## 2026-06-22: HTML preview works for large files; oversize editor shows a notice

**What changed:**
- Files over the `/content` 1 MB cap (HTTP 413) no longer spin forever: a failed
  content fetch is recorded on `FileState.loadError` (the three `useFileState`
  `.catch`es stopped swallowing it), so the editor pane shows a `FileTooLarge`
  notice. The error blanks a stale buffer only on a clean 413 — transient errors
  never wipe an open file, and drafts are always kept.
- Large `.html` still previews: `HtmlPreview` fetches `/raw` (20 MB) **as text**
  into the same sandboxed srcdoc iframe. Sandbox widened to
  `allow-scripts allow-modals allow-popups allow-forms` (still no
  `allow-same-origin`).

**Why:**
- The in-editor preview is for previewing source files; a 3 MB self-contained page
  (e.g. a base64 audio gallery) exceeded the editor's text cap and hung. Routing the
  preview through `/raw`-as-text lifts the limit without raising the editor cap.
- Kept the iframe on `srcdoc` (not `src={rawUrl}`) and deliberately left `.html`
  out of the raw MIME map (octet-stream), so the opaque-origin boundary holds and
  `GET /raw?path=…html` can't render attacker HTML on the app origin.

**Key files:** `app/ui/src/hooks/{workspaceTypes,fileStateMachine,useFileState}.ts`, `app/ui/src/workspace/{HtmlPreview,WorkspaceEditorArea,WorkspaceEditorColumn}.tsx`, `app/server` (test only), `doc/main/app/ui/workspace/editor-and-preview.md`, `doc/main/app/backend/routes.md`
**Verification:** `app/ui` lint + `tsc -b` clean; `vitest src/` 1037 passed; `app/server` `files.test.ts` 24 passed (incl. 413-vs-raw + octet-stream guard); Playwright `html-preview.spec.ts` 2 passed (oversize: edit-notice + `/raw` 200 + rendered marker). Cross-provider codex review APPROVE after one fix round (`plan/all/html-preview-large-file/review.md`).
**Commit:** d1bac184, bd93e7be
**Next:** Optional — extend the raw-as-text fallback to large Markdown (out of scope here).
**Blockers:** None

## 2026-06-22: voice read-back now fires for hidden/background tabs

**What changed:**
- `useAttention.surfaceInterrupts` no longer gates `onSpeak(items)` behind
  `document.visibilityState === 'visible'`. Read-back now speaks in **both** the
  visible and hidden branches; the visible/hidden split still governs only the
  VISUAL surface (in-app toast vs OS notification).

**Why:**
- A hidden/background tab is exactly when hearing the reply matters most — gating
  audio to the foreground defeated the purpose of an audio notification. Audio
  plays in a background tab once the engine is primed (unprimed → browser-TTS tier
  or silent until the next interaction unlocks it).

**Key files:** `app/ui/src/hooks/useAttention.ts`, `app/ui/src/hooks/useSpeech.ts` (comment), `app/ui/src/hooks/__tests__/useAttention.test.tsx`, `doc/main/app/{ui/notifications.md, frontend/hooks.md}`
**Verification:** useAttention suite incl. new hidden-read-back guard (fails with the gate, passes without) 26/26; `tsc -b` clean.
**Commit:** bd50b971
**Next:** If background read-back is silent, harden audio priming (prime on more gesture types) — currently relies on a prior gesture having unlocked the engine.
**Blockers:** None

## 2026-06-22: voice read-back silence fixed (StrictMode); idle min-processing 15s → 1.5s

**What changed:**
- `useSpeech` unmount cleanup no longer sets `enabledRef.current = false`. Under React
  StrictMode (dev) that cleanup runs once at mount, so when `enabled` was restored from
  `localStorage` (speaker icon on, no fresh toggle click) `enabledRef` was stranded `false`
  and `speak()` silently no-op'd — total read-back silence with the icon on. Teardown now
  relies on the `speakIdRef` bump (invalidates in-flight `current()` checks) + `preempt()`.
- `MIN_PROCESSING_MS` 15_000 → 1_500. The `session_idle` notification (toast + read-back)
  fired only after ≥15s of agent work, so a quick foreground reply appeared on screen with
  no notif/read-back at all. Kept a separate constant from `EDGE_DEBOUNCE_MS` — they gate
  adjacent intervals (work span before idle vs idle dwell after), not the same quantity.
- Doc accuracy: idle detection is now hook-driven for BOTH Claude and Codex (Codex installs a
  Stop hook); the min-processing + debounce gate is the shared, provider-agnostic engine
  decision, not a codex-only polling heuristic (`types.md`, `persistence.md`).

**Why:**
- The silence was a StrictMode ref-vs-state desync — NOT autoplay or tab-visibility (both
  ruled out by evidence: an in-app toast showed, so `visible` was true and `onSpeak` ran, yet
  zero `/voice/speak` server hits → `speak()` bailed at its `enabledRef` gate). Codex GO.
- 15s was tuned for visual-notification noise but over-suppressed the audio read-back, which
  should surface every real reply.

**Key files:** `app/ui/src/hooks/useSpeech.ts` (+test), `app/server/src/lib/attention-engine.ts` (+test), `doc/main/app/{ui/notifications.md, backend/libs.md, data-model/types.md, data-model/persistence.md}`
**Verification:** useSpeech suite incl. new StrictMode guard (fails with the bug, passes without) green; attention-engine 30/30; `tsc -b` clean; codex review GO on ae12c45a; user confirmed read-back live.
**Commit:** ae12c45a (read-back) + b3a1cfa8 (min-processing)
**Next:** Optional — decouple read-back from the visual-notif gate so it can surface even sub-1.5s turns.
**Blockers:** None

## 2026-06-22: idle/blocked notifications debounce off `statusEnteredAt`, not a poll-streak

**What changed:**
- Replaced the idle-notification mechanism in `attention-engine.ts`. The engine
  required `IDLE_CONFIRM_COUNT=2` consecutive idle *observations*, but the CLI
  `Stop` hook writes `idle` to the state file exactly once — so the 2nd confirm
  only arrived on the 60s safety tick, making idle "your turn" notifications fire
  **0–60s late** (avg ~30s) for a quiet single session.
- `session_blocked` + `session_idle` are now one **debounced session edge**: in
  `detectEdges`, append once the session has held the same `statusEnteredAt`
  generation for ≥ `EDGE_DEBOUNCE_MS` (1.5s), evaluated against the **fresh**
  `readSessions()` snapshot each recompute. A per-session **wake timer** only
  triggers a recompute — it never appends from cache (closes the old blocked-timer
  stale-cache window; a missed fs event self-corrects at the wake). Idle latency:
  up-to-60s → ~1.5s.
- `MIN_PROCESSING` is now a **fixed** work-duration gate (`idleAt − activeSince`,
  both parsed status timestamps), killing a latent drift bug where the old
  `now − activeSince` check let a trivial sub-15s turn fire a late idle edge on a
  later safety tick. `activeSince` is seeded from the active span's parsed
  `statusEnteredAt` (no `0` sentinel), preserved across `processing↔blocked` into
  idle.
- Deleted `idleStreak` / `IDLE_CONFIRM_COUNT` and the `BlockedPending` /
  `scheduleBlockedEdge` / `cancelBlockedEdge` machinery; `BLOCKED_DEBOUNCE_MS` →
  `EDGE_DEBOUNCE_MS`. Future/unparseable `statusEnteredAt` fails open (append now,
  no wake loop); the session cache commits **last** in the loop so an append
  failure retries (no swallowed crash edge).

**Why:**
- `IDLE_CONFIRM_COUNT` was a polling-style debounce bolted onto an event-driven
  trigger that never supplied a 2nd sample. Anchoring the debounce to
  `now − statusEnteredAt` and re-evaluating against the fresh snapshot makes blocked
  and idle one canonical case, removes the streak/blocked-timer special-casing, and
  is self-correcting — net less code, fixed latency.

**Key files:** `app/server/src/lib/attention-engine.ts`,
`app/server/src/lib/__tests__/attention-engine.test.ts`; docs
`doc/main/app/backend/libs.md`, `doc/main/app/ui/notifications.md`,
`doc/main/app/data-model/persistence.md`. Design + reviews:
`plan/all/idle-notif-debounce/`.

**Verification:** app/server 721 unit (engine 30, incl. real-wake-timer + drift +
flap + interrupt-once + crash-retry + future-dated regressions); `tsc -b` 78
pre-existing errors, **0 in scope** (78==78 vs main). Cross-provider review: codex
NO-GO (3 issues: crash-retry-on-append-failure, future-timestamp wake loop, idle
tests not driving the real timer) → all fixed → codex **GO**
(`plan/all/idle-notif-debounce/review-implementation.md`). QA: drove a real Claude
agent through a 22s turn — confirmed the turn-end `idle` is written **once** with a
`statusEnteredAt`, work span 22s ≥ 15s, notice captured (validates the bug premise
+ the fix's inputs).

**Commit:** `87a6d96` (code) + docs
**Next:** Codex idle (its `Stop` hook does not fire) still deferred — unchanged.
**Blockers:** None

## 2026-06-22: actively-viewed terminal now toasts + speaks (read-back un-suppressed)

**What changed:**
- `useAttention.ingest()` no longer diverts an interrupt for the actively-viewed
  target (visible + window-focused + attached) off the surface path. The early
  `continue` is gone; the `isActivelyViewing` branch collapses to just the READY
  auto-ack, then the item falls through to `surfaceInterrupts` like any other — so
  a reply landing in the terminal you are watching now fires a toast **and** a TTS
  read-back.
- Invariants held: READY (`group==='ready'`) auto-ack preserved (bell still clears
  on engage; `engagedAcks` still gates the F3 engage-ack effect against a
  double-POST); ACT (crash/block) rows are never auto-dismissed; `seenInterrupts`
  dedup unchanged, so the ack → `ui-state:changed` → refetch → re-ingest cycle
  cannot re-toast/re-speak a generation.
- Two `useAttention` unit tests flipped from "suppressed" to "surfaces". Fixed a
  pre-existing strict-mode locator collision in `attention.spec.ts` (the bell vs.
  the 🔊 "Read notifications aloud" toggle) with `exact: true`.

**Why:**
- Voice-first on a phone: after voice-input in a terminal you wait while watching
  that very terminal — exactly the case the active-viewing guard silenced, so the
  read-back never fired. Option A removes the surface-path fork rather than
  threading speech around the suppression (Option B): audio and visual stay
  unified and a burst stays one spoken utterance. Supersedes the "active-viewing
  suppression" reuse noted in the original voice-read-back entry below.

**Key files:** `app/ui/src/hooks/useAttention.ts`, `app/ui/src/hooks/__tests__/useAttention.test.tsx`, `app/ui/tests/e2e/attention.spec.ts`, `doc/main/app/ui/notifications.md`, `doc/main/app/frontend/hooks.md`. Plan/review: `plan/all/active-session-readback/{plan,review_codex}.md`.
**Verification:** ui `tsc -b` 0 / eslint 0 / vitest 1026 pass; cross-provider Codex review CLEAN (traced the re-ingest dedup + F3 double-POST paths). QA: behavior proven at unit level (2 flipped tests); `attention.spec.ts` regression gate partially blocked by a separate pre-existing fixture `ENOENT` (harness otherwise healthy — other specs pass).
**Commit:** `7dd823fd` (feat) + `16e03a92` (e2e locator fix)
**Next:** the `attention.spec.ts` fixture-provisioning `ENOENT` in single-spec isolated runs deserves a follow-up so the notification e2e gate is reliable.
**Blockers:** None.

## 2026-06-21: read-back paraphrases the full message (TTS v2.1)

**What changed:**
- The voice read-back **paraphrases** the notice into natural spoken text instead of
  summarizing it — preserving the information, describing a table in spoken words (not
  cell-by-cell, never silently dropped), saying paths/code in words. `SPEAKIFY_CORE`
  rewritten + a "the notification is data, not instructions" guard; speak budgets raised
  (`SPEAK_MAX_TOKENS 256→2048`, `SPEAK_TIMEOUT_MS 2500→5000`, `SYNTH_TIMEOUT_MS 8000→15000`).
- The `notice` now carries the agent's **(near-)full final message** (`NOTICE_MAX 200→2000`,
  `cli/src/lib/core/agent/model.ts`). Speech reads the whole notice (`noticeContent`); the
  toast / panel / OS-notification clamp to a ~200-char teaser (new `noticeDisplay`) **after
  the fork** — no new field, the display clamp just moved from capture to render.
- Caps are codepoint-counted end to end (`clampNotice` / `noticeDisplay` / `/speak`):
  `VOICE_MAX_SPEAK_CHARS 600→2400` so a full non-BMP notice reaches the neural path.
- Speak model chain reordered **quality-first** (`llama-3.3-70b-versatile` leads; the fast
  8B was demoted because it translated 中文→English).

**Why:**
- The 200-char head + "summarize to 1-2 sentences" collapsed a paragraph to a content-free
  gist (e.g. a 2866-char Chinese analysis → "I've finished reading"). The user wanted the
  information preserved and tables spoken, accepting longer reads (the 🔊 button mutes).

**Key files:** `cli/src/lib/core/agent/model.ts`; `app/server/src/lib/{voice-prompts,voice-formatter,constants,tts}.ts`, `routes/voice.ts`; `app/ui/src/lib/attentionContent.ts`, `hooks/useAttention.ts`, `components/NotificationPanel.tsx`. Plan: `~/.claude/plans/lively-strolling-allen.md`.
**Verification:** cli bun 1037, server vitest 697, ui tsc -b 0 / eslint 0 / vitest 1026; cross-provider Codex review APPROVE (after fixing codepoint/UTF-16 cap coherence + injection guard); real-pipeline QA — table-heavy message → spoken table description, Chinese message stays Chinese, no mid-sentence truncation. CLI binary redeployed via `bash tools/install.sh`.
**Commit:** `ad04333b..ddc45a4d`
**Next:** the read-back can be long for a dense message (non-streaming synth → pre-roll latency); streaming synth is the future option if it bites. `NOTICE_MAX` is the dial.
**Blockers:** None.

## 2026-06-21: neural voice read-back + spoken rewrite (TTS v2)

**What changed:**
- Upgraded read-back from browser `speechSynthesis` to a **server-first neural** path
  behind the v1 `speak(text)` seam (attention wiring unchanged): the notice is rewritten
  to a spoken summary (Groq) and synthesized with a neural voice (edge-tts), played via a
  reused `<audio>`; browser TTS is the fallback tier. Three strict tiers — neural+rewrite
  → browser TTS(raw) → silent (toast still shows).
- New `app/server/src/lib/tts.ts` — `synthesizeSpeech(text, voice)` over `msedge-tts@2.0.6`
  (one instance/request, a single timer bounding connect+stream, one cleanup on every
  terminal path), `resolveTtsVoice()`, `escapeForSsml()`.
- `voice-formatter.ts` — extracted `completeWithFallback(models, system, userMessage, opts)`
  with a caller-owned `{maxTokens,timeoutMs,logLabel}` budget; STT `formatWithFallback`
  byte-identical over it; added `rewriteForSpeech` (speakify prompt, fast-first
  `VOICE_SPEAK_MODELS`, 256 tok / 2.5s) + `resolveSpeakModels`. New `buildSpeakifyPrompt` /
  `buildSpeakifyUserMessage` in `voice-prompts.ts`.
- New keyless `POST /api/voice/speak` (204/400/413/502) and nested `tts:{enabled,voice}` on
  `GET /api/voice/status` (top-level STT `enabled` untouched). New `VOICE_MAX_SPEAK_CHARS` (600).
- `useSpeech.ts` rewired server-first + browser fallback with a monotonic `speakIdRef`
  latest-wins guard (AbortError never falls back; toggle-off/unmount bump the generation so
  a re-enable can't resurrect a stale branch), a dual gesture prime (silent-mp3 on the reused
  `<audio>` + a `volume:0` utterance), and `supported` as a pure client audio check
  independent of `/status`.

**Why:**
- Two complaints with v1: OS `speechSynthesis` voices are robotic off iOS, and the raw
  notice is too written (tables/markdown/paths). A neural voice + a spoken rewrite fix both,
  while the fallback tier keeps the feature working with no key and no edge endpoint.
- edge-tts (not Groq TTS): Groq TTS is English+Arabic only — no Mandarin — so it can't read
  the user's mixed 中英文; edge-tts is free, keyless, multilingual.

**Key files:** `app/server/src/lib/{tts,voice-formatter,voice-prompts,constants}.ts`,
`app/server/src/routes/voice.ts`, `app/ui/src/hooks/useSpeech.ts`. Design: `plan/all/voice-tts-neural/`.
**Verification:** server vitest 694, ui vitest 1022 (incl. 15 new useSpeech specs), `tsc -b` +
eslint clean; per-phase cross-provider Codex reviews (`plan/all/voice-tts-neural/review-phase{1..4}.md`);
real-pipeline QA — `POST /api/voice/speak` returns mp3 for English, mixed 中英文, keyed
(Groq rewrite→synth) and keyless (raw synth).
**Commit:** `9bf05f34..65132007`
**Next:** manual device smokes — iPhone gesture unlock; live "kill edge endpoint → browser
fallback". Optional: prefer enhanced `getVoices()` voices in the fallback tier.
**Blockers:** the `zh-CN-*MultilingualNeural` voices return empty audio from the Read Aloud
endpoint (QA finding) — defaulted to `zh-CN-XiaoxiaoNeural` (native Mandarin + embedded
English), overridable via `VOICE_TTS_VOICE`.

## 2026-06-21: voice read-back of foreground notifications (TTS)

**What changed:**
- Added the output half of voice: when an attention interrupt surfaces while the app
  is foreground, the agent's final message (the notice) is read aloud. STT (`useVoice`
  + Groq Whisper) untouched.
- New `ui/src/hooks/useSpeech.ts` (browser **Web Speech API** — no backend/key/dep):
  `{ supported, enabled, setEnabled, speak }`. Opt-in + persisted; latest-wins
  playback (`cancel()` before each utterance); CJK→`zh-CN` else `en-US`; iOS audio
  unlocked by a silent `volume:0` utterance primed from a user gesture; `enabled`
  read via a synchronous ref so a toggle-off silences instantly.
- `speechTextFor(items)` in `ui/src/lib/attentionContent.ts`: single → `"<state>.
  <notice>"`, burst → count summary.
- `useAttention` gained an `onSpeak?` param, called once in `surfaceInterrupts`'
  **visible** branch — spoken set == toasted set, foreground-only by construction.
- A 🔊 read-aloud toggle sits beside the notification bell (desktop top-bar + mobile
  chrome), hidden when `speechSynthesis` is unsupported.

**Why:**
- Wanted bidirectional voice for running yaco on a phone — hear an agent's reply
  without watching the screen. Web Speech keeps it zero-cost / zero-key / no
  self-host; hooking the one `surfaceInterrupts` visible branch reuses the existing
  dedup + active-viewing suppression, so audio never fires for a backgrounded tab.
  Groq's own TTS (now Orpheus) is English/Arabic only, so it can't be the bilingual
  path; the `speak(text)` seam isolates a future edge-tts swap if OS voices disappoint.

**Key files:** `app/ui/src/hooks/useSpeech.ts`, `app/ui/src/hooks/useAttention.ts`, `app/ui/src/lib/attentionContent.ts`, `app/ui/src/App.tsx`, `app/ui/src/components/NotificationBell.tsx`, `plan/all/voice-notif-readback/design.md`
**Verification:** `npx tsc -b` + `npm run lint` clean; vitest 43 passed (attentionContent + NotificationBell + useAttention); real-device smoke on iOS + desktop confirmed by user; codex review (2 MAJOR + 1 MINOR) — fixed the stale-`enabled` closure + toggle ARIA, judged the cold-reload-before-first-gesture audio gap inherent to web audio policy and documented it.
**Commit:** eaf0049f (feat) + c6f4ad38 (codex fixes); docs follow
**Next:** optional — swap to a server edge-tts route behind `speak(text)` if OS voice quality (esp. Android/Linux) disappoints; Codex idle notice still deferred to v1.1.

## 2026-06-21: orchestrate + yaco-worktree → task-DAG ≅ worktree/branch-DAG model

**What changed:**
- Rewrote the two scheduling skills (`agent-config/global/skills/{orchestrate,yaco-worktree}/SKILL.md`)
  to replace the shared-worktree + scope-overlap model with a 1:1 isomorphism: **every runnable
  leaf is its own worktree/branch**, merged **up** the DAG into its target.
- orchestrate: ordering keys on `depends` only; scope-overlap demoted from a dispatch blocker to a
  scarce-slot tiebreak; two-level parallelism retired; cross-target `depends` not reachable from the
  target → refuse dispatch (authoring error); terminal semantics = gate pass is *ready-to-merge*,
  `done` only after merge-up. Evidence-gate criteria table kept intact (enforcement red line).
- yaco-worktree: merge-up target rule (nearest integration-acceptCriteria ancestor, else main);
  native git for child→parent vs `yaco worktree merge` for →main (+ primary-checkout constraint);
  per-target write serialization; conflict resolver protocol + resolver gate; per-leaf +
  integration-milestone completion; target-aware cleanup; generic provision hook + repo-policy guide.
- Synced the implement↔orchestrate contract in `doc/main/agent-config/architecture.md`.

**Why:**
- The worktree scheduler was orchestrate's most baroque part (CWD resolution, two-level parallelism,
  scope-overlap serialization). Making the worktree/branch DAG mirror the task DAG turns those
  special cases into one canonical shape: wider parallelism (independent leaves no longer blocked by
  a scope-overlap heuristic), explicit `depends` ordering instead of inferred scope, and integration
  still happening at the milestone layer so `main` stays clean. Zero CLI/schema change — leans on the
  existing `resources` task field and `yaco worktree create --base`.

**Key files:** `agent-config/global/skills/orchestrate/SKILL.md`, `agent-config/global/skills/yaco-worktree/SKILL.md`, `doc/main/agent-config/architecture.md`, `plan/all/orchestrate-worktree-strategy/final/design.md`
**Verification:** design aligned Claude⇄Codex (8 turns, both APPROVE); cross-provider review (codex) APPROVE after one CHANGES round (3 HIGH + 1 MED + 1 LOW fixed), 0 unresolved critical/high; CLI surface + markdown structure + cross-refs checked; orchestration scenario traced end-to-end. No code touched.
**Commit:** 83685b8c (skills + design record); docs follow
**Next:** `/yaco-worktree` provision-hook guide already landed; optional v1.1 — envelope-unified merge primitive, `yaco task validate` rule for duplicate runnable-leaf slug.
**Blockers:** None

## 2026-06-20: Drop the dead `project · key` notice fallback (server source)

**What changed:**
- Removed the server projector's empty-notice location template (the old `lineTwo`
  fallback to `${project} · ${key}`). `noticeText(notice)` now sets the row `message`
  to the trimmed notice or `''`, and `session_crashed` is always `''` (the exit code
  is in the title). The web client dropped its matching client-side suppression —
  `noticeContent` renders `message` verbatim; an empty `message` → the row shows just
  its state label.

**Why:**
- Completes the panel/toast redesign (above) end-to-end. The scan line already shows
  identity + project, so the location template was dead weight the client was merely
  suppressing. Deleting it at the source leaves one contract and no client guard.

**Key files:** `app/server/src/lib/attention-projection.ts`, `app/server/src/lib/__tests__/attention-projection.test.ts`, `app/ui/src/lib/attentionContent.ts`, `doc/main/app/ui/notifications.md`
**Verification:** app/server `npm test` 675/675 (attention-projection 73/73); app/ui `tsc -b` + vitest 36/36 + eslint — all green.
**Commit:** 8bfe1875
**Blockers:** None

## 2026-06-20: Notification panel + toast redesign (information density)

**What changed:**
- Inverted the row hierarchy so the captured `notice` is the hero. Each row is now
  a **scan line** (identity + faint `project · time` + a kind glyph: `SquareTerminal`
  = agent session, `ListChecks` = task-graph node) over a **content line** (the
  tier-colored state label leads, then the notice on its own ≤2 lines; toast ≤3).
  The toast + burst mirror the panel.
- The web client **suppresses the server's redundant `${project} · ${key}` fallback**
  (`noticeContent`) and maps id-bearing task titles to a bare verb (`stateLabel` →
  `Done`/`Blocked`), so a no-notice row collapses to just its state label
  (crashed → `Crashed (exit 1)`). New shared `ui/src/lib/attentionContent.ts`
  (`identityKey`/`stateLabel`/`noticeContent`); `tierColor` moved to `attentionColors.ts`.

**Why:**
- The notif-content milestone (2026-06-19, below) gave rows real content, but the
  layout still led with the generic state word ("Your turn") on a bold full-width
  line and flattened project/session/response onto one truncating line — the
  response died at ~2 words. Task and session rows were also visually identical
  despite routing to different places on click.

**Key files:** `app/ui/src/components/NotificationPanel.tsx`, `app/ui/src/hooks/useAttention.ts`, `app/ui/src/lib/attentionContent.ts`, `app/ui/src/lib/attentionColors.ts`
**Verification:** app/ui `tsc -b` clean; vitest NotificationBell + useAttention 36/36; eslint clean. Visual reviewed via a static Solarized preview (light/dark, all states: blocked/crashed/idle/done, count, no-notice, recent).
**Commit:** d2cb600f
**Next:** optional — drop the now-client-suppressed `${project} · ${key}` fallback at the server source (`attention-projection.ts`) so the dead template is gone end-to-end.
**Blockers:** None

## 2026-06-19: Notification line-2 carries content, not a location template

**What changed:**
- Every bell + toast notification's line-2 was `${project} · ${name}` — a verbatim
  repeat of the location already on the title row. It now carries the
  highest-information content **for the attention state**: the question
  (`tool_input.questions[0]`), the permission request (`Bash: <cmd>` from
  `tool_input`), the Claude idle "Your turn" final-message opening (`Stop`
  transcript tail), or the task title (`Task.title || id`). Crashed keeps the
  location (exit code is already in the title).
- One transient field, `SessionState.notice` (CLI-owned). Captured in
  `applyHookEvent` (question/permission, pure) + the hook wrapper (Claude idle,
  impure); `setStatus` now uses **one edge predicate** (status OR blocked-reason
  change) for both `statusEnteredAt` re-stamp and `notice` clear, so a
  `question → permission` switch mints a fresh generation and never leaks stale
  text. Sanitized + clamped to ≤200 chars by `clampNotice` (re-exported from
  `@yaco/cli/core/agent`). Flows through the existing session-state read →
  `LiveSession.notice` → a `lineTwo()` projector helper at all 5 message sites;
  `needsYou` reads the live notice, `ready`/`recent` read the event-payload notice.
- Engine: `notice` rides into the `events.jsonl` payload (bounded content
  retention). The blocked debounce is now **generation-aware** — it refreshes the
  latest snapshot each recompute and appends the freshest at fire time (captures a
  notice that fills mid-window), reschedules a re-block instead of stranding it,
  and no longer re-appends/rebroadcasts a settled blocked edge every 1.5s.
  `openAndReviewGenerations` keys edge meta by `project::name` (latent
  cross-project leak fixed).
- UI: toast body clamped to 2 lines; bell row keeps its single-line truncate
  (`location — content`). Codex idle deferred to v1.1 (no reliable `Stop` hook).

**Why:**
- Two lines, zero new information. The title already shows `project / name` + the
  state; the second line should be the densest content that fits the state, so the
  user can triage from the bell/toast without opening the session.

**Key files:** cli/src/lib/core/agent/{model,hook-event,projection,index,providers/output}.ts, app/server/src/lib/{attention-projection,attention-engine,attention-runtime,agent}.ts, app/ui/src/hooks/useAttention.ts, doc/main/app/ui/notifications.md, doc/main/app/data-model/persistence.md
**Verification:** cli 1037, app/server 674, app/ui 1000 unit + attention e2e (4) green; tsc/lint clean; codex review T1+T2 (1 High each: Stop async-read race re-confirmed against the debounce baseline; settled-blocked re-append loop closed) — both resolved. QA: state-file notice → real `toSessionRow` → projected row, and seeded blocked session → rendered bell line-2, both verified end-to-end.
**Commit:** 41c03b83 · 2d1060aa · b21cf2fc · 89d1686a
**Blockers:** None

## 2026-06-19: Watcher inotify-exhaustion fix (chokidar prune) + server as a service

**What changed:**
- `project-watcher.ts` per-project watcher moved from `fs.watch({recursive:true})` to **chokidar v3** with an `ignored` predicate that prunes `node_modules`, `.git/{objects,logs}` (by path segment), and gitignored trees during the walk — those dirs never get an inotify watch. Gitignore loads before the watcher; `.worktrees` + immediate children stay watched (worktrees channel); `watchProject` awaits chokidar `ready` (bounded) and guards watch/unwatch races with a per-path generation token. Added `chokidar` to `app/server` deps (root lockfile).
- Root `npm` scripts now wrap `app/scripts/services.sh` (`dev`/`restart`/`stop`/`status`/`logs`) so server+UI run as the existing `yaco-{server,ui}` systemd/launchd services, not a tmux-hosted dev process; `dev:local` keeps the foreground path. Corrected stale `workflow-*` unit names in docs (real units are `yaco-*`).

**Why:**
- Recursive `fs.watch` over 14 projects installed an inotify watch per subdir incl. `node_modules` + gitignored churn (cproxy `logs/` alone = 138k dirs), hitting the ~1M `max_user_watches` ceiling → `ENOSPC` → wedged event loop → white screen (recurred 3×). Pruned: ~976k → ~15k watches.
- The server had been run manually inside a tmux session sharing the default socket with agent tmux sessions, so a `tmux kill-server`/restart took down every agent. Agents inherit the spawner’s `$TMUX`; running the server as a service (no `$TMUX`) keeps agents on the default socket — terminal-accessible and decoupled.

**Key files:** app/server/src/lib/project-watcher.ts, app/server/package.json, package.json, package-lock.json, doc/main/app/backend/libs.md, doc/dev/app/workflow.md
**Verification:** app/server 653/653 tests; codex review (2 rounds) — all MAJOR/MINOR resolved; live 14-project workspace (incl. cproxy+quant) at ~15k watches, health 200, no ENOSPC; `npm run restart` via services.sh → health 200.
**Commit:** f33d9872 (+ this docs commit)
**Blockers:** None

## 2026-06-17: `agent history` — windowed contract, origin enrichment, token size signal

**What changed:**
- `yaco agent history` got a **strict subcommand parser** (unknown flag / bad value / stray positional → `USAGE`), **`--since <iso>`** (ISO-8601 only; filters after the provider merge, before the limit slice) and **`--limit <n>`** (default 200, replaces the old `HISTORY_CAP` magic constant). `--json` now **always returns a windowed object** `{rows, returned, truncated, oldestUpdatedAt}` — never a bare array; `truncated` is a real machine-readable signal. App-side `fetchHistory` reads `data.rows` in the same patch (route/UI keep the array shape).
- **Origin (G5):** rows carry `spawnedBy`/`parentSession` from the existing sessionId live-tag join, plus a durable per-sessionId index at `${YACO_HOME}/agent/origins/<id>.json` (exclusive-create first-write-wins, written on first real-id resolution from `start`/`hook-event`/`reconcileSession` — never at spawn or on `--resume`); `null` when unknowable.
- **Replaced always-null `messageCount` with `tokens`** — last-turn total token count read from the log tail (Claude sums `input+cache_creation+cache_read+output` of the last `message.usage`; Codex reads `last_token_usage.total_tokens` from the `rollout_path` tail). UI shows `· N tok`.

**Why:**
- The `self-improve` scan needs a complete 30-day cross-project window; the old silent 200-cap + ignored `--since` lost data, and untagged agent fan-out inflated "repeated workflow" counts. `messageCount` was 100% null in practice (no Claude `sessions-index.json` exists anywhere; Codex hardcoded null), so it became a real cheap session-size signal instead.

**Key files:** cli/src/commands/agent/history.ts, cli/src/lib/core/agent/providers/{history,types}.ts, cli/src/lib/core/agent/origin.ts, cli/src/lib/core/paths/yaco-home.ts, app/server/src/lib/{agent,history}.ts, app/ui/src/workspace/WorkspaceHistoryList.tsx
**Verification:** cli 1004 unit + `tsc -b`; app/server 614; app/ui `tsc -b` + sessionSearch 15 + eslint; design via codex `eng-plan-review` ×4 + claude code-review (impl); live smoke (Claude/Codex rows carry real `tokens`). Binary rebuilt + deployed via the build step.
**Commit:** 341334f..0b57dae
**Next:** G3 (`messageCount` cheap-populate — superseded by `tokens`) and G4 (`history --all` cross-project) remain deferred; the skill's per-project loop covers G4.
**Blockers:** None

## 2026-06-17: self-improve skill activated

**What changed:**
- Activated the **`self-improve`** skill (`agent-config/global/skills/`): scans `yaco agent history` across all registered projects, clusters first user prompts to find repeated manual workflows, emits a **shortlist first** (shortlist-before-build), and creates only greenlit assets.
- Refined against the live history CLI — uses `--since`/`--limit` + the windowed object and reads `spawnedBy` off rows directly, dropping the old client-side workarounds.

**Why:** harvest repeated manual work into reusable skills/subagents/automations; the discipline is restraint (most candidates are skipped).
**Key files:** agent-config/global/skills/self-improve/SKILL.md
**Verification:** ran once end-to-end — produced a clean shortlist, correctly dropped orchestrator fan-out and cross-checked existing skills.
**Commit:** 9283bbe
**Next:** re-scan now that the window is complete (yaco/quant history was previously cap-truncated inside the 30-day window).
**Blockers:** None

## 2026-06-15: Voice target selector moved into the compose tray

**What changed:**
- **The target selector left the top nav bar for the `ComposeTray` header.** The desktop
  nav now holds only the **mic** (`GlobalVoiceControl` slimmed to mic-only); the new
  `TargetSelector` (icon + instance label + dropdown) renders in the tray header, replacing
  the static `Compose → Terminal/Editor` label.
- **The target now binds at Insert, not at record.** A new `RETARGET` reducer event
  (`voiceStateMachine`) re-points the open run; `useVoice.retarget(ctx)` exposes it, and the
  tray selector drives it via `WorkspaceScreen.retargetVoice` → `targetContextOf`.
  `handleVoiceConfirm` still routes through `voice.target`, which `RETARGET` updates.
  The selector is re-pointable for the whole open lifecycle — even while recording,
  since routing only binds at Insert — and picking a valid instance also recovers a
  lost target (recoverable → composing).
- **Removed the nav-side override + focus-epoch machinery** (`advanceFocusEpoch`,
  `FocusEpochState`, `VoiceTargetOverride`, the `override` arg on `resolveVoiceTarget`, and
  the `voiceSurface` mirror in `useWorkspaceVoice`) — its only consumer was the nav dropdown.
- **Tests:** `RETARGET` reducer cases (change target, recover, ignored while idle / in
  flight); split `TargetSelector.test.tsx` (dropdown) out of `GlobalVoiceControl.test.tsx`
  (mic-only); rewrote the `voice-target` e2e to drive the real tray (fake capture, dev-only)
  and assert a terminal-recorded take lands in the editor once retargeted.

**Why:** The target picker belongs next to the draft it routes, not in distant top-bar
chrome — the tray is where the user reads the draft and decides where it goes. Because the
transcript only routes to an editor/terminal at **Insert** (recording just fills the draft
buffer), the frozen-at-record binding was stricter than needed; re-pointing the run is a
small, well-contained state-machine addition. Decisions confirmed with the user (mic stays
in nav; selector re-routes Insert). Codex review flagged an in-flight-retarget lock as
bypassable through a lingering open menu — resolved by dropping the lock entirely: since
the draft only routes at Insert, re-pointing mid-take is harmless, so there is nothing to
guard. `tsc -b` + eslint clean, UI unit tests pass, retarget→Insert + Esc-while-recording
e2e green.

## 2026-06-15: Editor render isolation — smooth typing in large files

**What changed:**
- **Split editor state out of `WorkspaceSelectionContext`** into two dedicated contexts:
  `editorBuffers` (`{files, jumpRequest}`, per-keystroke — only the editor body subtree
  subscribes) and `editorTabs` (`{dirtyTabs, conflictTabs}`, membership-only — the
  `GroupTabBar`/`MobileEditorTabs` leaves subscribe). The `selection` memo no longer
  depends on `files`, so a keystroke no longer re-renders terminals/sessions/tree (9 of
  12 selection consumers were re-rendering for nothing). Tab-bar save handlers read the
  live `filesRef` (mirrored via `useLayoutEffect`) in the click handler — no render
  subscription, no registry; `draft` stays live every keystroke.
- **Preview switched from throttle to debounce.** New `useDebouncedValue` (180ms,
  render-on-pause) feeds the markdown/HTML preview; the editor diff gutter keeps
  `useThrottledValue` (120ms). Both keyed on the file path (immediate adopt on tab
  switch) and memoize `renderMarkdown` (kills a double-parse). The preview re-parses +
  re-lays-out the whole document, so a throttle (which still fires mid-burst) left a
  420KB file laggy with the preview open; a debounce does zero preview work while typing.
- `editorContextIsolation.test.tsx` locks the invariant (a keystroke re-renders the
  editor body but the terminal/tab-bar stand-ins 0×); throttle/debounce hooks unit-tested.

**Why:** Typing in a 420KB markdown file was laggy and stalled the adjacent terminal —
purely client-side React: the hot `files` state sat in the shared selection context, and
the preview re-rendered the whole document on every keystroke. Measurement (preview
closed = smooth, open = laggy) localized the residual to the preview pipeline, so the
deferred document-out-of-React **model extraction** (a live-buffer registry, designed in
`plan/all/20260615_editor-render-isolation/`) was NOT needed — the preview debounce was
the right, KISS lever (mirrors how VSCode throttles its preview). No save / conflict /
persistence change. Reviewed by Codex (3 design rounds + 1 implementation round; the
file-switch throttle reset and `filesRef` `useLayoutEffect` came from that review).

**Key files:** `app/ui/src/workspace/context.ts`, `WorkspaceProvider.tsx`,
`{EditorPanel,PanelGroup,GroupTabBar,MobilePanelProjection,WorkspaceEditorArea}.tsx`,
`useWorkspaceDiff.ts`, `hooks/{useThrottledValue,useDebouncedValue,useFileState,useWorkspaceState}.ts`
**Verification:** `tsc -b` + eslint clean; 988 unit tests pass (scoped `src/`); manual —
420KB split-mode with a terminal open: terminal unaffected, typing much improved.
**Commit:** 335268a, 22e65e0 (design bundle: feef-era `plan/all/20260615_editor-render-isolation/`)
**Next:** Optional, measurement-gated — if huge-file editing stays bothersome, the
single-parse cost per pause remains; incremental/virtualized preview or the model
extraction would be the next lever.
**Blockers:** None

## 2026-06-15: Editor file-sync — no lost edits, no phantom disk-conflict banner

**What changed:**
- **`SAVE_SUCCESS` no longer discards the live buffer.** Saving is async; keystrokes
  typed between `Cmd+S` and the response were being cleared when the draft was reset to
  the saved snapshot (deterministic data loss — "typed text disappeared"). It now goes
  `clean` only when the buffer still equals the persisted bytes; otherwise the newer
  draft stays `dirty` over the freshly-written revision.
- **Conflict detection is content-based, not mtime-based.** `SERVER_SYNC` previously
  raised `conflict` whenever the refetched file mtime differed from `baseRevision` — so
  the editor's *own* save, echoed back through the fs watcher with a new mtime, was
  flagged as an external disk change ("disk version ≠ my version" banner after save).
  Now it conflicts only when disk **content** actually diverges; a same-content mtime
  echo is absorbed, and when disk converges to the live buffer the file returns to
  `clean`. In `conflict` state a same-content echo never refreshes the save token, so a
  plain `Cmd+S` can't silently overwrite disk before an explicit Keep-Mine/Accept-Disk.
- **Unsaved drafts survive deletion.** `dirtyTabs` and the shared-buffer GC now key off
  `draft != null`, so a `missing` file (deleted on disk while dirty) can't have its
  draft silently GC'd on tab close.
- **Halved the refetch storm.** Dropped the editor's duplicate `git` SSE subscription;
  working-tree content changes always arrive on `filetree`. Drafts persist to
  localStorage, so typing never hits disk — the lag was the double full-tab refetch on
  every watched write (frequent under agent activity).

**Why:** Editing felt laggy, typed text vanished, and saves raised a false
disk-conflict banner — all from using file mtime as the sync signal and clearing the
draft on every save (cf. VSCode: version-id/etag dirty tracking, own-write suppression,
never clobber the unsaved buffer).

**Key files:** `app/ui/src/hooks/fileStateMachine.ts`, `app/ui/src/hooks/useFileState.ts`,
`app/ui/src/hooks/__tests__/fileStateMachine.test.ts` (new)
**Verification:** `fileStateMachine.test.ts` (10) + `sharedBufferGc` + `EditorPanel`
regression (20) pass; `tsc -b` and eslint clean. Reviewed by Codex — conflict-token
guard, conflict→clean convergence, and the `SERVER_MISSING` data-loss edge are
review-driven additions.
**Commit:** 41d82be (+ docs)
**Next:** Optional follow-up — targeted SSE refresh (carry the changed path in the
event so only the affected tab refetches) and a content-hash/monotonic revision token
to replace mtime entirely.
**Blockers:** None

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
