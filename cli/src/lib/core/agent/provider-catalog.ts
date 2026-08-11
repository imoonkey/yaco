/** The startable agent provider catalog — the identity half of the TUI provider
 *  registry, and the only part of it an in-process caller may hold.
 *
 *  `app/server` validates a start request against this list before spawning
 *  `yaco agent start`. Reaching it through `providers/index.ts` would mean
 *  loading `claude.ts`/`codex.ts`, and those reach tmux, hook installation and
 *  the session lifecycle — none of which an exported closure may contain.
 *
 *  So the identity lives here and the adapters spread it, rather than here
 *  restating what the adapters declare: there is one definition of a provider's
 *  id, label and executable, and a registry that disagreed with this catalog
 *  would have to disagree with itself. `test/providers.test.ts` still asserts
 *  the two agree, which is what catches a third adapter that writes its own
 *  literals instead.
 *
 *  Nothing here reads the filesystem, the environment, or the clock.
 *
 *  -> See: `doc/main/cli/exports.md` (the six eligibility rules this obeys). */

/** One startable CLI agent provider. `shell` is an app-owned session type, not
 *  a CLI agent provider, and never appears here. */
export interface ProviderCatalogEntry {
  id: string;
  label: string;
  executable: string;
}

export const CLAUDE_IDENTITY = {
  id: "claude",
  label: "Claude",
  executable: "claude",
} as const satisfies ProviderCatalogEntry;

export const CODEX_IDENTITY = {
  id: "codex",
  label: "Codex",
  executable: "codex",
} as const satisfies ProviderCatalogEntry;

/** Registration order, which is the order the catalog is rendered and served
 *  in. It matches `listProviders()` because both are this one list. */
const CATALOG: readonly ProviderCatalogEntry[] = [CLAUDE_IDENTITY, CODEX_IDENTITY];

/** The catalog, as fresh records: a caller that mutates what it is handed must
 *  not be able to edit the registry's idea of a provider. */
export function providerCatalog(): ProviderCatalogEntry[] {
  return CATALOG.map((entry) => ({ ...entry }));
}
