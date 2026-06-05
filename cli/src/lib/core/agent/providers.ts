/** Legacy provider surface.
 *
 *  The typed provider registry lives under `providers/`. This module adapts it
 *  to the flat `Provider` shape that the not-yet-migrated runtime call sites
 *  still import (start, status, dispatcher). New code should import from
 *  `providers/index.ts` and `providers/idle.ts` directly. */

import { listProviders, listProviderIds } from "./providers/index.ts";
import type { TuiProvider } from "./providers/types.ts";

export { isIdle, ALL_IDLE_PATTERNS } from "./providers/idle.ts";

export interface Provider {
  readonly name: string;
  readonly idlePatterns: readonly RegExp[];
  /** Build the shell command to start this provider with passthrough args. */
  buildCommand(passthroughArgs: string[]): string;
}

function toLegacy(provider: TuiProvider): Provider {
  return {
    name: provider.id,
    idlePatterns: provider.detection.idlePatterns,
    // Legacy callers pass raw passthrough args; normalizeStartArgs applies the
    // provider's name-flag policy (claude passes through, codex strips) before
    // the command is assembled. The handle is injected separately at call sites.
    buildCommand: (args) =>
      provider.command.build(
        provider.command.normalizeStartArgs({ handle: "", args, resumeId: undefined }),
      ),
  };
}

// Null-prototype so `name in PROVIDERS` and `PROVIDERS[name]` resolve only the
// registered ids, never inherited keys like "toString" or "constructor".
export const PROVIDERS: Record<string, Provider> = Object.create(null);
for (const provider of listProviders()) {
  PROVIDERS[provider.id] = toLegacy(provider);
}

export function getProvider(name: string): Provider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Available: ${listProviderIds().join(", ")}`);
  }
  return provider;
}
