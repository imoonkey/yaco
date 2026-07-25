/** `yaco agent usage [provider]` — subscription quota across CLI providers.
 *
 *  One command rather than one per provider: the point is a single normalized
 *  answer to "how much have I got left", so the default probes every provider
 *  concurrently and prints them side by side. */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { readUsage, usageProviderIds, type ProviderUsage, type UsageWindow } from "../../lib/core/agent/providers/usage.ts";

export const USAGE_USAGE = `yaco agent usage [provider] [--fresh] [--json]

Reports how much of each signed-in subscription's quota is spent. With no
provider, probes all of them: ${usageProviderIds().join(", ")}.

Flags:
  --fresh   Bypass the 120s cache and re-probe the providers
  --json    Emit the {ok:true,data} envelope

Numbers are cached for 120s because the Claude usage endpoint rate-limits
repeated polling. Exits non-zero only when no provider reported any window.`;

export interface UsageArgs {
  providers: string[];
  fresh: boolean;
  json: boolean;
}

export function parseUsageArgs(argv: string[]): UsageArgs {
  const args: UsageArgs = { providers: usageProviderIds(), fresh: false, json: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--fresh") args.fresh = true;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("-")) throw new CliError(ErrCode.USAGE, `unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) {
    throw new CliError(ErrCode.USAGE, `expected at most one provider, got: ${positional.join(" ")}`);
  }
  const provider = positional[0];
  if (provider !== undefined) {
    if (!usageProviderIds().includes(provider)) {
      throw new CliError(
        ErrCode.INVALID,
        `unknown usage provider: ${provider}. Available: ${usageProviderIds().join(", ")}`,
      );
    }
    args.providers = [provider];
  }
  return args;
}

/** The report's one failure rule: a report is a failure only when nothing at
 *  all came back. Losing one provider out of two is a partial report (the
 *  failure prints inline and the exit code stays 0), while losing the only one
 *  asked for fails carrying that provider's own error code — so a caller can
 *  still tell "re-authenticate" from "back off" from "codex isn't installed". */
export function requireReported(entries: ProviderUsage[]): ProviderUsage[] {
  if (entries.some((entry) => entry.windows.length > 0)) return entries;

  const failures = entries.filter((entry) => entry.error);
  const first = failures[0]?.error;
  if (!first) {
    throw new CliError(ErrCode.NOT_FOUND, "no provider reported a quota window");
  }
  throw new CliError(first.code, failures.map((e) => `${e.provider}: ${e.error?.message}`).join("; "));
}

export async function runUsage(args: UsageArgs): Promise<ProviderUsage[]> {
  return requireReported(await readUsage(args.providers, { fresh: args.fresh }));
}

// -- Rendering --

const BAR_CELLS = 10;

function bar(percent: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)));
  return `[${"▓".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}]`;
}

function windowLabel(window: UsageWindow): string {
  return window.scope ? `${window.window} · ${window.scope}` : window.window;
}

/** Coarse "3d 4h" / "14h" / "22m" gap, floored — a quota monitor wants to know
 *  roughly how long until relief, not the exact second. */
function relative(fromMs: number, toMs: number): string {
  const totalMins = Math.round((toMs - fromMs) / 60_000);
  if (totalMins <= 0) return "now";
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${totalMins}m`;
}

export function renderUsage(entries: ProviderUsage[], nowMs: number = Date.now()): string {
  const labelWidth = Math.max(
    0,
    ...entries.flatMap((entry) => entry.windows.map((w) => windowLabel(w).length)),
  );

  return (
    entries
      .map((entry) => {
        const age = relative(Date.parse(entry.checkedAt), nowMs);
        const head = [
          entry.plan ? `${entry.provider} · ${entry.plan}` : entry.provider,
          age === "now" ? "just checked" : `checked ${age} ago`,
        ].join("   ");

        if (entry.error) return `${head}\n  error [${entry.error.code}]: ${entry.error.message}\n`;
        if (entry.windows.length === 0) return `${head}\n  (no quota windows reported)\n`;

        const rows = entry.windows.map((window) => {
          const resets =
            window.resetsAt === undefined
              ? "reset time unreported"
              : `resets in ${relative(nowMs, Date.parse(window.resetsAt))}`;
          return (
            `  ${windowLabel(window).padEnd(labelWidth)}  ${bar(window.percent)}` +
            `  ${String(Math.round(window.percent)).padStart(3)}%   ${resets}`
          );
        });
        return `${head}\n${rows.join("\n")}\n`;
      })
      .join("\n")
  );
}
