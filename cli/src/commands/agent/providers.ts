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
