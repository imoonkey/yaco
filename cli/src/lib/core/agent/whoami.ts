import { execFileSync } from "child_process";
import { listStateHandles, readState } from "./session-state.ts";
import { listProviders } from "./providers/index.ts";
import { PENDING_SESSION_ID, type SessionState } from "./model.ts";

export type WhoamiSource = "tmux-pane" | "session-id" | "ancestor-pid";

export interface WhoamiMatch {
  handle: string;
  source: WhoamiSource;
}

export interface WhoamiProcessInfo {
  pid: number;
  ppid: number;
}

interface ResolveWhoamiOptions {
  env?: Record<string, string | undefined>;
  currentPid?: number;
  states?: readonly SessionState[];
  processes?: readonly WhoamiProcessInfo[];
  tmuxSessionNameFromPane?: (pane: string) => string | null;
}

/** Session-id env vars carried inside a provider TUI, aggregated from every
 *  registered adapter so a new provider needs no edit here. */
function sessionIdEnvKeys(): readonly string[] {
  return listProviders().flatMap((provider) => provider.sessionId.envKeys);
}

function readStates(): SessionState[] {
  const states: SessionState[] = [];
  for (const handle of listStateHandles()) {
    const state = readState(handle);
    if (state) states.push(state);
  }
  return states;
}

function defaultTmuxSessionNameFromPane(pane: string): string | null {
  try {
    const name = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", pane, "#{session_name}"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    ).trim();
    return name || null;
  } catch {
    return null;
  }
}

function readProcesses(): WhoamiProcessInfo[] {
  try {
    const output = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const processes: WhoamiProcessInfo[] = [];
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      processes.push({
        pid: parseInt(match[1]!, 10),
        ppid: parseInt(match[2]!, 10),
      });
    }
    return processes;
  } catch {
    return [];
  }
}

function firstKnownSessionId(env: Record<string, string | undefined>): string | null {
  for (const key of sessionIdEnvKeys()) {
    const value = env[key]?.trim();
    if (value && value !== PENDING_SESSION_ID) return value;
  }
  return null;
}

function ancestorDistances(
  processes: readonly WhoamiProcessInfo[],
  currentPid: number,
): Map<number, number> {
  const parentByPid = new Map<number, number>();
  for (const process of processes) {
    parentByPid.set(process.pid, process.ppid);
  }

  const distances = new Map<number, number>();
  let pid = currentPid;
  let distance = 0;

  while (pid > 0 && !distances.has(pid)) {
    distances.set(pid, distance);
    const parent = parentByPid.get(pid);
    if (parent === undefined || parent === pid) break;
    pid = parent;
    distance++;
  }

  return distances;
}

export function resolveWhoamiMatch(options: ResolveWhoamiOptions = {}): WhoamiMatch | null {
  const env = options.env ?? process.env;
  const states = options.states ?? readStates();
  const byHandle = new Map(states.map((state) => [state.handle, state]));

  const pane = env["TMUX_PANE"];
  if (pane) {
    const getTmuxSessionName = options.tmuxSessionNameFromPane ?? defaultTmuxSessionNameFromPane;
    const handle = getTmuxSessionName(pane);
    if (handle && byHandle.has(handle)) {
      return { handle, source: "tmux-pane" };
    }
  }

  const sessionId = firstKnownSessionId(env);
  if (sessionId) {
    const match = states.find((state) => state.sessionId === sessionId);
    if (match) return { handle: match.handle, source: "session-id" };
  }

  const currentPid = options.currentPid ?? process.pid;
  const processes = options.processes ?? readProcesses();
  const distances = ancestorDistances(processes, currentPid);
  const ancestorMatch = states
    .filter((state) => state.pid > 0 && distances.has(state.pid))
    .sort((a, b) => distances.get(a.pid)! - distances.get(b.pid)!)[0];

  if (ancestorMatch) {
    return { handle: ancestorMatch.handle, source: "ancestor-pid" };
  }

  return null;
}
