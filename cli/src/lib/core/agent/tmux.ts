import { execFileSync, execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { listProviders } from "./providers/index.ts";
import { isInputEmpty } from "./providers/idle.ts";
import { stripAnsi } from "./model.ts";
import { sleepSync } from "../sleep.ts";
import { yacoExecutable } from "../../../package-root.ts";

const EXEC_TIMEOUT_MS = 5000;
const INPUT_EMPTY_POLL_MS = 500;
export const SEND_WHEN_INPUT_EMPTY_TIMEOUT_MS = 5 * 60 * 1000;
const RGB_TERMINAL_FEATURES = [
  "xterm-256color:RGB",
  "tmux-256color:RGB",
  "screen-256color:RGB",
] as const;
// Provider executables YACO knows how to launch, sourced from the registry so a
// new adapter needs no edit here. Resolved lazily to keep this low-level module
// free of a load-time registry dependency.
let _knownAgentCommands: Set<string> | null = null;
function knownAgentCommands(): Set<string> {
  return (_knownAgentCommands ??= new Set(listProviders().map((p) => p.executable)));
}
const THEME_ENV_KEYS = ["MULTMUX_THEME", "MULTMUX_COLOR_SCHEME", "GTK_THEME", "KDE_COLOR_SCHEME"] as const;
const LINUX_THEME_COMMANDS = [
  "gsettings get org.gnome.desktop.interface color-scheme",
  "gsettings get org.gnome.desktop.interface gtk-theme",
  "kreadconfig6 --group General --key ColorScheme",
  "kreadconfig5 --group General --key ColorScheme",
] as const;

// tmux exact-match target helpers.
// The "=" prefix disables tmux prefix matching (e.g., "foo" won't match "foo-2").
// Commands that accept target-session (has-session, kill-session, rename-session)
// work with "=handle". Commands that accept target-pane (set-option, send-keys,
// capture-pane) require "=handle:" — the trailing colon separates session from
// window/pane, letting the "=" apply to the session name lookup.
const sessionTargetValue = (handle: string) => `=${handle}`;
const paneTargetValue = (handle: string) => `=${handle}:`;
const sessionTarget = (handle: string) => `"${sessionTargetValue(handle)}"`;
const paneTarget = (handle: string) => `"${paneTargetValue(handle)}"`;

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

function exec(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: EXEC_TIMEOUT_MS,
  }).trim();
}

function execOk(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function execTmux(args: string[], input?: string): void {
  execFileSync("tmux", args, {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: EXEC_TIMEOUT_MS,
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isTmuxAvailable(): boolean {
  return execOk("which tmux");
}

/** The transient scope the tmux server is escaped into. A fixed unit name, not
 *  systemd-run's per-invocation `run-p<pid>-i<id>.scope`: the cgroup belongs to
 *  the server, and every session is forked by that server into it. An anonymous
 *  scope per `new-session` names the shared cgroup after whichever session
 *  happened to start the server, and reports its whole CPU/memory footprint
 *  against that one session's command line. */
export const CGROUP_ESCAPE_PREFIX =
  "systemd-run --user --scope --unit=yaco-tmux-server --collect --quiet " +
  `--description="yaco tmux server (hosts every agent session)" `;

/** Whether a process whose leaf cgroup is `leaf` needs the escape: a managed
 *  `.service` would take tmux down with it on `systemctl restart`.
 *  `user@<uid>.service` is the user manager itself — direct membership means
 *  we're a top-level user process in a `.scope`, never directly in user@. */
export function needsCgroupEscape(leaf: string | undefined): boolean {
  return !!leaf && leaf.endsWith(".service") && !/^user@\d+\.service$/.test(leaf);
}

let _cgroupEscapePrefix: string | null | undefined = undefined;
/** When multmux runs inside a nested systemd `.service` cgroup (e.g. spawned
 *  by workflow-server.service), `tmux new-session` would inherit that cgroup
 *  and die with the parent on `systemctl restart`. Wrapping with
 *  `systemd-run --user --scope` puts the tmux server in a transient scope
 *  outside the parent's control-group, so sessions survive parent restart.
 *  Returns the prefix to inject before `tmux new-session`, or "" when not
 *  needed (non-Linux, no systemd-run, or leaf cgroup already a .scope). */
function cgroupEscapePrefix(): string {
  if (_cgroupEscapePrefix !== undefined) return _cgroupEscapePrefix ?? "";
  if (process.platform !== "linux" || !execOk("which systemd-run")) {
    return (_cgroupEscapePrefix = null) ?? "";
  }
  try {
    // cgroup v2 line: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/<leaf>"
    const leaf = readFileSync("/proc/self/cgroup", "utf-8")
      .split("\n").find(l => l.startsWith("0::"))?.split("/").pop()?.trim();
    _cgroupEscapePrefix = needsCgroupEscape(leaf) ? CGROUP_ESCAPE_PREFIX : null;
  } catch {
    _cgroupEscapePrefix = null;
  }
  return _cgroupEscapePrefix ?? "";
}

/** True when a tmux server is already accepting commands on this socket.
 *  `list-sessions` exits 1 with "no server running on <socket>" when it isn't. */
function isTmuxServerRunning(): boolean {
  return execOk("tmux list-sessions");
}

/** The escape belongs to the invocation that STARTS the tmux server. Every
 *  later session is forked by that server and lands in its cgroup whatever
 *  scope its own client was launched into, so wrapping those too buys nothing
 *  and would collide on the singleton unit name. */
function serverEscapePrefix(): string {
  const prefix = cgroupEscapePrefix();
  return prefix && !isTmuxServerRunning() ? prefix : "";
}

export function hasSession(handle: string): boolean {
  return execOk(`tmux has-session -t ${sessionTarget(handle)} 2>/dev/null`);
}

/** GC-safe liveness check: true = alive, false = confirmed dead, null = uncertain.
 *  GC should only delete on `false`, never on `null` (timeout, tmux error). */
export function checkSessionAlive(handle: string): boolean | null {
  try {
    execSync(`tmux has-session -t ${sessionTarget(handle)} 2>/dev/null`, {
      stdio: "pipe",
      timeout: EXEC_TIMEOUT_MS,
    });
    return true;
  } catch (e: unknown) {
    // exit code 1 = tmux confirmed session doesn't exist
    if (typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status === 1) {
      return false;
    }
    // timeout, signal, tmux unavailable — can't confirm death
    return null;
  }
}

/** Socket-independent liveness: is the recorded agent process still running?
 *
 *  `tmux has-session` is scoped to ONE tmux socket (the caller's $TMUX), so a
 *  caller on the wrong socket sees every live session as "dead". The OS process
 *  table is global, so a live PID is authoritative regardless of socket. GC uses
 *  this to gate state-file deletion: a session whose process is alive is never
 *  deleted, even if tmux on the current socket can't see it. */
export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM = process exists but we may not signal it → still alive.
    return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "EPERM";
  }
}

export function ensureTrueColorSupport(): void {
  const existing = exec(`tmux show-options -gv terminal-features 2>/dev/null || true`);
  const configured = new Set(existing.split("\n").map((line) => line.trim()).filter(Boolean));
  for (const feature of RGB_TERMINAL_FEATURES) {
    if (configured.has(feature)) continue;
    execSync(`tmux set-option -ag terminal-features '${feature}'`, {
      stdio: "pipe",
      timeout: EXEC_TIMEOUT_MS,
    });
  }
}

/** tmux's `-N` forbids starting a server, so a command carrying it can only join
 *  one that is already up. */
export const JOIN_EXISTING_SERVER = "-N ";

/** The `tmux new-session` command line for a managed session, without the cgroup
 *  escape. Pure apart from the two env vars it forwards, so tests can pin it. */
export function newSessionCommand(
  handle: string,
  command: string,
  projectPath: string,
  serverFlag = "",
): string {
  const cwdArg = `-c "${projectPath}"`;
  // Propagate an explicit YACO_HOME into the session so the agent's hooks and
  // wrapper write state to the same runtime root as the launching `yaco`
  // process. tmux new-session against an already-running server does not copy
  // arbitrary caller env vars, so without this an explicit YACO_HOME (tests,
  // multi-root setups) is ignored and the session's state lands in ~/.yaco.
  const yacoHome = process.env["YACO_HOME"];
  const envArg = yacoHome && yacoHome.length > 0 ? `-e "YACO_HOME=${yacoHome}" ` : "";
  // Propagate the absolute yaco invocation as YACO_BIN so the wrapper's EXIT-trap
  // crash path can run `yaco agent mark-crashed` without depending on the dying
  // shell's PATH. Delivered via tmux -e (not a command prefix): a leading
  // `VAR=val` token would be exec'd by tmux as a program and the pane would die.
  const yacoBin = yacoExecutable();
  const yacoBinArg = yacoBin.length > 0 ? `-e "YACO_BIN=${yacoBin}" ` : "";
  // -x/-y is the initial detached size; window-size=latest sizes the window
  // to whatever client most recently became active — so the device you're
  // currently using always sees content fit to its own screen.
  return `tmux ${serverFlag}new-session -d -s "${handle}" ${cwdArg} ${envArg}${yacoBinArg}-x 333 -y 100 ${command}`;
}

export function createSession(handle: string, command: string, cwd?: string): void {
  const projectPath = cwd ?? process.cwd();
  const newSession = newSessionCommand(handle, command, projectPath);
  const escape = serverEscapePrefix();
  const execOpts = { stdio: "pipe", cwd: projectPath, timeout: EXEC_TIMEOUT_MS } as const;
  try {
    execSync(`${escape}${newSession}`, execOpts);
  } catch (e: unknown) {
    // Dropping the escape is only ever right when someone else has already
    // applied it: a concurrent start won the singleton unit, and the server now
    // running is the escaped one this session merely has to join. Absent that,
    // the failure is the escape's own (no user bus, systemd-run refusing an
    // option) and retrying unescaped would silently found the server inside the
    // restartable service — forfeiting, without a word, the property the whole
    // mechanism exists for. A session that did get created before the call
    // failed (the 5s timeout elapsing after tmux forked) owes the caller that
    // error too, not a second attempt that dies on the duplicate name — and a
    // probe that merely could not answer is not a session confirmed absent.
    if (!escape || checkSessionAlive(handle) !== false || !isTmuxServerRunning()) throw e;
    // `-N` rather than a bare retry: should the rival's last session end between
    // that check and this call, this must fail rather than quietly found a
    // second, unescaped server inside the service.
    execSync(newSessionCommand(handle, command, projectPath, JOIN_EXISTING_SERVER), execOpts);
  }
  ensureTrueColorSupport();
  execSync(`tmux set-option -t ${paneTarget(handle)} status off`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
  execSync(`tmux set-option -t ${paneTarget(handle)} focus-events on`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
  execSync(`tmux set-option -t ${paneTarget(handle)} allow-passthrough on`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
  execSync(`tmux set-option -t ${paneTarget(handle)} window-size latest`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
  execSync(`tmux set -t ${paneTarget(handle)} mouse on`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
}

/** Encode an OSC response as tmux send-keys hex bytes. */
function oscHex(code: string, rgb: string): string {
  const payload = `${code};rgb:${rgb}`;
  const bytes: string[] = ["1b", "5d"];
  for (const ch of payload) bytes.push(ch.charCodeAt(0).toString(16).padStart(2, "0"));
  bytes.push("1b", "5c");
  return bytes.join(" ");
}

type ThemeCommandRunner = (cmd: string) => string | null;

function parseThemeHint(value: string | undefined): boolean | null {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("dark")) return true;
  if (normalized.includes("light")) return false;
  return null;
}

function parseColorFgBg(value: string | undefined): boolean | null {
  const parts = value?.split(";").filter(Boolean);
  if (!parts?.length) return null;
  const background = Number(parts[parts.length - 1]);
  if (!Number.isInteger(background)) return null;
  if (background === 0 || background === 8) return true;
  if (background === 7 || background === 15) return false;
  return null;
}

function runThemeCommand(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 1000 }).trim();
  } catch {
    return null;
  }
}

/** Detect light/dark appearance for OSC 10/11 replies. Falls back to light. */
export function detectDarkMode(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  runCommand: ThemeCommandRunner = runThemeCommand,
): boolean {
  for (const key of THEME_ENV_KEYS) {
    const detected = parseThemeHint(env[key]);
    if (detected !== null) return detected;
  }

  const colorFgBg = parseColorFgBg(env.COLORFGBG);
  if (colorFgBg !== null) return colorFgBg;

  if (platform === "darwin") {
    const style = runCommand("defaults read -g AppleInterfaceStyle");
    const detected = parseThemeHint(style ?? undefined);
    return detected ?? style !== null;
  }

  if (platform === "linux") {
    for (const cmd of LINUX_THEME_COMMANDS) {
      const detected = parseThemeHint(runCommand(cmd) ?? undefined);
      if (detected !== null) return detected;
    }
  }

  return false;
}

function oscColorResponseHex(): string {
  const dark = detectDarkMode();
  const fg = dark ? "8383/9494/9696" : "6565/7b7b/8383";
  const bg = dark ? "0000/2b2b/3636" : "fdfd/f6f6/e3e3";
  return `${oscHex("10", fg)} ${oscHex("11", bg)}`;
}

/** Respond to Codex's startup OSC 10/11 color queries in detached tmux.
 *  tmux pipe-pane sees the real query bytes; replying only after a query avoids
 *  the visible `^[]10;rgb...` echo caused by blind timed input injection. */
export function startOscColorQueryResponder(handle: string): void {
  const target = paneTargetValue(handle);
  const hex = oscColorResponseHex();
  const script = [
    `target=${shellQuote(target)}`,
    `hex=${shellQuote(hex)}`,
    "query10=$'\\033]10;?\\033\\\\'",
    "query11=$'\\033]11;?\\033\\\\'",
    "buf=''",
    "deadline=$((SECONDS + 6))",
    "while (( SECONDS < deadline )); do",
    "  if IFS= read -r -t 0.2 -n 1 ch; then",
    '    buf="${buf}${ch}"',
    '    if (( ${#buf} > 64 )); then buf="${buf: -64}"; fi',
    '    if [[ "$buf" == *"$query10"* || "$buf" == *"$query11"* ]]; then',
    '      tmux send-keys -t "$target" -H $hex >/dev/null 2>&1 || true',
    "      buf=''",
    "    fi",
    "  fi",
    "done",
  ].join("\n");
  try {
    execTmux(["pipe-pane", "-o", "-t", target, `bash -lc ${shellQuote(script)}`]);
  } catch { /* best-effort */ }
}

export function getPanePid(handle: string): number | null {
  try {
    const pid = exec(`tmux list-panes -t ${sessionTarget(handle)} -F "#{pane_pid}"`);
    const parsed = parseInt(pid, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

function listProcesses(): ProcessInfo[] {
  try {
    const output = execSync("ps -eo pid=,ppid=,comm=", {
      encoding: "utf-8",
      timeout: EXEC_TIMEOUT_MS,
    });
    const processes: ProcessInfo[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      processes.push({
        pid: parseInt(match[1]!, 10),
        ppid: parseInt(match[2]!, 10),
        command: match[3]!.trim(),
      });
    }
    return processes;
  } catch {
    return [];
  }
}

export function resolveAgentPidFromProcesses(
  processes: readonly ProcessInfo[],
  rootPid: number,
  preferredCommand?: string,
): number | null {
  const children = new Map<number, ProcessInfo[]>();
  for (const process of processes) {
    const bucket = children.get(process.ppid);
    if (bucket) {
      bucket.push(process);
    } else {
      children.set(process.ppid, [process]);
    }
  }

  const queue = [...(children.get(rootPid) ?? [])];
  const descendants: ProcessInfo[] = [];

  while (queue.length > 0) {
    const process = queue.shift()!;
    descendants.push(process);
    queue.push(...(children.get(process.pid) ?? []));
  }

  if (descendants.length === 0) return null;

  if (preferredCommand) {
    const preferred = descendants.find((process) => process.command === preferredCommand);
    return preferred?.pid ?? null;
  }

  const knownAgent = descendants.find((process) => knownAgentCommands().has(process.command));
  if (knownAgent) return knownAgent.pid;

  return descendants[0]!.pid;
}

/** Get the actual agent CLI PID from the tmux pane process tree. */
export function getAgentPid(handle: string, preferredCommand?: string): number | null {
  const panePid = getPanePid(handle);
  if (panePid === null) return null;

  const agentPid = resolveAgentPidFromProcesses(listProcesses(), panePid, preferredCommand);
  return agentPid ?? (preferredCommand ? null : panePid);
}

export function sendKeys(handle: string, text: string): void {
  const bufferName = `multmux-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  execTmux(["load-buffer", "-b", bufferName, "-"], text);
  try {
    // Bracketed paste keeps Codex slash-command autocomplete from consuming
    // partial input before the submit key arrives.
    execTmux(["paste-buffer", "-p", "-t", paneTargetValue(handle), "-b", bufferName]);
  } finally {
    try {
      execTmux(["delete-buffer", "-b", bufferName]);
    } catch { /* best-effort cleanup */ }
  }

  execTmux(["send-keys", "-t", paneTargetValue(handle), "Enter"]);
}

export type InputGatedSendResult = "sent" | "queued" | "timeout" | "missing";

export function isPaneInputEmpty(handle: string, providerId: string): boolean {
  try {
    const raw = capturePane(handle, 80, true);
    return isInputEmpty(stripAnsi(raw), providerId, raw);
  } catch {
    return false;
  }
}

export function waitForInputEmptyThenSend(
  handle: string,
  providerId: string,
  text: string,
  timeoutMs: number = SEND_WHEN_INPUT_EMPTY_TIMEOUT_MS,
): InputGatedSendResult {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hasSession(handle)) return "missing";
    if (isPaneInputEmpty(handle, providerId)) {
      sendKeys(handle, text);
      return "sent";
    }
    sleepSync(INPUT_EMPTY_POLL_MS);
  }
  return "timeout";
}

function queueInputEmptySend(handle: string, providerId: string, text: string): InputGatedSendResult {
  try {
    const child = spawn(
      yacoExecutable(),
      ["agent", "_send-when-input-empty", handle, providerId, text],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    child.on("error", () => {});
    child.unref();
    return "queued";
  } catch {
    return "timeout";
  }
}

/** Submit an internal slash command only when it cannot merge into user input. */
export function sendKeysWhenInputEmpty(
  handle: string,
  providerId: string,
  text: string,
): InputGatedSendResult {
  if (!hasSession(handle)) return "missing";
  if (isPaneInputEmpty(handle, providerId)) {
    sendKeys(handle, text);
    return "sent";
  }
  return queueInputEmptySend(handle, providerId, text);
}

const VALID_RAW_KEYS = /^[a-zA-Z0-9_-]+$/;

/** Send raw tmux key names (e.g. "Enter", "C-c") without text escaping */
export function sendRawKeys(handle: string, keys: string): void {
  if (!VALID_RAW_KEYS.test(keys)) {
    throw new Error(`Invalid key name: "${keys}"`);
  }
  execTmux(["send-keys", "-t", paneTargetValue(handle), keys]);
}

export function renameSession(oldHandle: string, newHandle: string): void {
  execSync(`tmux rename-session -t ${sessionTarget(oldHandle)} "${newHandle}"`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
}

export function killSession(handle: string): void {
  execSync(`tmux kill-session -t ${sessionTarget(handle)}`, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
}

export function capturePane(
  handle: string,
  lines?: number,
  includeEscapes = false,
): string {
  // -S - captures full scrollback, -p prints to stdout, -e keeps ANSI escapes.
  const escapeFlag = includeEscapes ? " -e" : "";
  const raw = exec(`tmux capture-pane -t ${paneTarget(handle)} -p${escapeFlag} -S -`);
  if (lines === undefined) return raw;
  const allLines = raw.split("\n");
  return allLines.slice(-lines).join("\n");
}
