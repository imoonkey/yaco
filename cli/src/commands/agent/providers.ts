/** `yaco agent providers --json` — registered CLI agent provider catalog.
 *
 *  A thin adapter over the shared catalog `app/server` reads in process, so the
 *  command and the app cannot answer "which providers exist" differently. */

import { providerCatalog, type ProviderCatalogEntry } from "../../lib/core/agent/provider-catalog.ts";

export type { ProviderCatalogEntry };

export const runProviders = providerCatalog;

/** Concise text rendering: one `id  label (executable)` line per provider. */
export function renderProviders(catalog: ProviderCatalogEntry[]): string {
  if (catalog.length === 0) return "(no providers)\n";
  const width = Math.max(...catalog.map((p) => p.id.length));
  return catalog.map((p) => `${p.id.padEnd(width)}  ${p.label} (${p.executable})`).join("\n") + "\n";
}
