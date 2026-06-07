/** `yaco agent providers --json` — registered CLI agent provider catalog.
 *
 *  The downstream app validates startable providers against this list (every
 *  entry is a CLI agent provider; `shell` is not a CLI provider and is added by
 *  app/ui, not here). */

import { listProviders } from "../../lib/core/agent/providers/index.ts";

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  executable: string;
}

export function runProviders(): ProviderCatalogEntry[] {
  return listProviders().map((p) => ({ id: p.id, label: p.label, executable: p.executable }));
}

/** Concise text rendering: one `id  label (executable)` line per provider. */
export function renderProviders(catalog: ProviderCatalogEntry[]): string {
  if (catalog.length === 0) return "(no providers)\n";
  const width = Math.max(...catalog.map((p) => p.id.length));
  return catalog.map((p) => `${p.id.padEnd(width)}  ${p.label} (${p.executable})`).join("\n") + "\n";
}
