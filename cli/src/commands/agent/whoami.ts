import { resolveWhoamiMatch, type WhoamiSource } from "../../lib/core/agent/whoami.ts";
import type { RuntimeSessionState } from "../../lib/core/agent/model.ts";
import { reconcile } from "./status.ts";

export interface CurrentAgentIdentity extends RuntimeSessionState {
  source: WhoamiSource;
}

export function whoami(): CurrentAgentIdentity | null {
  const match = resolveWhoamiMatch();
  if (!match) return null;

  const state = reconcile(match.handle);
  if (!state) return null;

  return { ...state, source: match.source };
}
