/** Provider registry: registration and lookup for TUI provider adapters. */

import type { TuiProvider } from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";

// A Map keeps lookup/membership to registered ids only — a plain object would
// resolve inherited keys like "toString" or "constructor".
const REGISTRY = new Map<string, TuiProvider>([
  [claudeProvider.id, claudeProvider],
  [codexProvider.id, codexProvider],
]);

/** Resolve a provider adapter by id, throwing for unknown ids. */
export function getProvider(id: string): TuiProvider {
  const provider = REGISTRY.get(id);
  if (!provider) {
    throw new Error(`Unknown provider: ${id}. Available: ${listProviderIds().join(", ")}`);
  }
  return provider;
}

/** All registered provider adapters. */
export function listProviders(): TuiProvider[] {
  return [...REGISTRY.values()];
}

/** All registered provider ids. */
export function listProviderIds(): string[] {
  return [...REGISTRY.keys()];
}

/** True when a provider id is registered. */
export function hasProvider(id: string): boolean {
  return REGISTRY.has(id);
}

export type { TuiProvider } from "./types.ts";
