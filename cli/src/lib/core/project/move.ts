/** Project-move orchestrator.
 *
 *  When a project moves on disk from `<old>` to `<new>`, cwd-keyed metadata
 *  must be rekeyed so its history still resolves. This module owns only the
 *  YACO-owned stores:
 *
 *   1. `${YACO_HOME}/sessions/*.json` — `sessionPath` field
 *   2. `${YACO_HOME}/projects.json`   — `{id, path}` entries
 *
 *  Provider-native stores (Claude's encoded project dirs and JSONL, Codex's
 *  rollout files, config sections, and SQLite threads) are owned by each
 *  provider adapter's `projectMove` capability. The orchestrator iterates the
 *  provider registry, collects each provider's opaque `ProviderMovePlan`, and
 *  passes the payload back to the same adapter for apply/render — it never
 *  inspects a provider payload's shape.
 *
 *  The rekey is plan-then-apply: `planMove()` returns a serializable plan that
 *  lists every YACO file/registry-entry plus each provider's opaque plan.
 *  `applyPlan()` performs the mutations. Dry-run is "return the plan without
 *  applying".
 *
 *  Matching modes (see `./match.ts`):
 *   - exact (default): rewrite paths equal to `oldPath`.
 *   - prefix (`--prefix`): also rewrite paths under `oldPath + "/"`.
 *
 *  All operations are idempotent: re-running `planMove()` against a tree that
 *  has already been rekeyed returns an empty plan.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  readProjects,
  writeProjects,
  type Project,
} from "../paths/index.ts";
import { stateDir } from "../agent/session-state.ts";
import { getProvider, listProviders } from "../agent/providers/index.ts";
import type {
  ProjectMoveInputs,
  ProviderMovePlan,
} from "../agent/providers/types.ts";
import {
  normalizePath,
  translatePath,
  type MatchMode,
} from "./match.ts";

export { isPathOrChild, normalizePath, resolveMoveArg, translatePath, type MatchMode } from "./match.ts";

/** Shared move inputs: identical to the provider-facing `ProjectMoveInputs`,
 *  so the orchestrator forwards them to each adapter verbatim. */
export type MoveInputs = ProjectMoveInputs;

export interface SessionPlanItem {
  /** Absolute path to the JSON state file. */
  file: string;
  /** Handle (filename without `.json`). */
  handle: string;
  oldSessionPath: string;
  newSessionPath: string;
}

export interface RegistryPlanItem {
  id: string;
  oldPath: string;
  newPath: string;
}

export interface MovePlan {
  oldPath: string;
  newPath: string;
  mode: MatchMode;
  sessions: SessionPlanItem[];
  registry: RegistryPlanItem[];
  /** Opaque per-provider plans, one bucket per provider that has a hit. */
  providers: ProviderMovePlan[];
}

export interface MoveCounts {
  sessions: number;
  registry: number;
  /** Flat provider rewrite counts (e.g. `claudeProjects`, `codexSessions`).
   *  The key set is contributed by each provider's `projectMove.countRows`, so
   *  the legacy flat JSON `rewrote` shape is preserved without the mover knowing
   *  any provider's storage schema. */
  [providerCountKey: string]: number;
}

/** One row of the move command's count table. */
export interface MoveCountRow {
  label: string;
  count: number;
}

export function emptyCounts(): MoveCounts {
  const counts: MoveCounts = { sessions: 0, registry: 0 };
  for (const provider of listProviders()) {
    for (const row of provider.projectMove?.countRows ?? []) {
      counts[row.key] = 0;
    }
  }
  return counts;
}

export function countsFor(plan: MovePlan): MoveCounts {
  const counts = emptyCounts();
  counts.sessions = plan.sessions.length;
  counts.registry = plan.registry.length;
  for (const providerPlan of plan.providers) {
    for (const [key, n] of Object.entries(providerPlan.counts)) counts[key] = n;
  }
  return counts;
}

/** Ordered count-table rows for a move report: generic YACO rows followed by
 *  each provider's declared rows (zero when the provider had no hits). Labels
 *  and keys are provider-owned; the mover only iterates the registry. */
export function moveCountRows(counts: MoveCounts): MoveCountRow[] {
  const rows: MoveCountRow[] = [
    { label: "yaco sessions", count: counts.sessions },
    { label: "yaco registry", count: counts.registry },
  ];
  for (const provider of listProviders()) {
    for (const row of provider.projectMove?.countRows ?? []) {
      rows.push({ label: row.label, count: counts[row.key] ?? 0 });
    }
  }
  return rows;
}

function safeReaddir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// --- planners (pure: no fs writes) ---------------------------------------

function planSessions(inputs: MoveInputs): SessionPlanItem[] {
  const dir = stateDir();
  const items: SessionPlanItem[] = [];
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith(".json")) continue;
    const abs = join(dir, file);
    let parsed: { sessionPath?: unknown };
    try {
      parsed = JSON.parse(readFileSync(abs, "utf-8"));
    } catch {
      continue;
    }
    const sp = parsed.sessionPath;
    if (typeof sp !== "string") continue;
    const next = translatePath(sp, inputs.oldPath, inputs.newPath, inputs.mode);
    if (next === null || next === sp) continue;
    items.push({
      file: abs,
      handle: file.slice(0, -5),
      oldSessionPath: sp,
      newSessionPath: next,
    });
  }
  return items;
}

function planRegistry(inputs: MoveInputs): RegistryPlanItem[] {
  let projects: Project[];
  try {
    projects = readProjects();
  } catch {
    // Malformed registry — surface as zero rewrites; the caller is responsible
    // for surfacing/repairing the corrupt file via `yaco install`'s ENV check.
    return [];
  }
  const items: RegistryPlanItem[] = [];
  for (const p of projects) {
    const next = translatePath(p.path, inputs.oldPath, inputs.newPath, inputs.mode);
    if (next === null || next === p.path) continue;
    items.push({ id: p.name, oldPath: p.path, newPath: next });
  }
  return items;
}

/** Collect each provider's opaque move plan. The orchestrator only iterates
 *  the registry; it does not know any provider's storage schema. */
function planProviders(inputs: MoveInputs): ProviderMovePlan[] {
  const plans: ProviderMovePlan[] = [];
  for (const provider of listProviders()) {
    const plan = provider.projectMove?.plan(inputs);
    if (plan) plans.push(plan);
  }
  return plans;
}

// --- planMove + applyPlan -----------------------------------------------

export function planMove(inputs: MoveInputs): MovePlan {
  return {
    oldPath: normalizePath(inputs.oldPath),
    newPath: normalizePath(inputs.newPath),
    mode: inputs.mode,
    sessions: planSessions(inputs),
    registry: planRegistry(inputs),
    providers: planProviders(inputs),
  };
}

export function applyPlan(plan: MovePlan): MoveCounts {
  const counts = emptyCounts();
  for (const item of plan.sessions) {
    rewriteJsonField(item.file, "sessionPath", item.oldSessionPath, item.newSessionPath);
    counts.sessions += 1;
  }
  if (plan.registry.length > 0) {
    const projects = readProjects();
    let changed = false;
    for (const p of projects) {
      const hit = plan.registry.find((r) => r.id === p.name && r.oldPath === p.path);
      if (hit) {
        p.path = hit.newPath;
        changed = true;
      }
    }
    if (changed) writeProjects(projects);
    counts.registry = plan.registry.length;
  }
  for (const providerPlan of plan.providers) {
    const provider = getProvider(providerPlan.provider);
    if (!provider.projectMove) continue;
    const applied = provider.projectMove.apply(providerPlan);
    for (const [key, n] of Object.entries(applied)) counts[key] = n;
  }
  return counts;
}

/** Render the provider-owned sections of a move report by delegating each
 *  provider plan back to its adapter. The orchestrator owns aggregation and
 *  iteration order; the text content is provider-owned. */
export function renderProviderSections(plan: MovePlan): string[] {
  const lines: string[] = [];
  for (const providerPlan of plan.providers) {
    const provider = getProvider(providerPlan.provider);
    if (!provider.projectMove) continue;
    lines.push(...provider.projectMove.renderText(providerPlan));
  }
  return lines;
}

function rewriteJsonField(
  file: string,
  field: string,
  oldValue: string,
  newValue: string,
): void {
  const raw = readFileSync(file, "utf-8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data[field] !== oldValue) {
    // Concurrent edit raced us — bail out silently rather than overwriting
    // unrelated state. The next `yaco project move` invocation will pick it
    // up if it still matches.
    return;
  }
  data[field] = newValue;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}
