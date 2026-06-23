import { resolveWhoamiMatch, type WhoamiSource } from "../../lib/core/agent/whoami.ts";
import type { RuntimeSessionState } from "../../lib/core/agent/model.ts";
import { resolveSession } from "./status.ts";

export interface CurrentAgentIdentity extends RuntimeSessionState {
  source: WhoamiSource;
}

export async function whoami(): Promise<CurrentAgentIdentity | null> {
  const match = resolveWhoamiMatch();
  if (!match) return null;

  // Pure read — whoami inspects the current session, it must never mutate.
  const state = await resolveSession(match.handle);
  if (!state) return null;

  return { ...state, source: match.source };
}
