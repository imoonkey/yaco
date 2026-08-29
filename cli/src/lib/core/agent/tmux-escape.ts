/** Where the tmux server must live, and how to put it there. Policy only — no
 *  I/O: each caller probes its own environment on the terms its runtime allows
 *  (the CLI synchronously, a server off its event loop) and applies this. */

/** The transient scope the tmux server is escaped into. A fixed unit name, not
 *  systemd-run's per-invocation `run-p<pid>-i<id>.scope`: the cgroup belongs to
 *  the server, and every session is forked by that server into it. An anonymous
 *  scope per `new-session` names the shared cgroup after whichever session
 *  happened to start the server, and reports its whole CPU/memory footprint
 *  against that one session's command line. */
const ESCAPE_DESCRIPTION = "yaco tmux server (hosts every agent session)";
/** `ManagedOOMPreference=avoid`: when the user slice is under memory pressure,
 *  systemd-oomd kills the LARGEST cgroup in it — not the one thrashing — and
 *  the scope hosting every agent session is always the largest. `avoid` makes
 *  it the last candidate rather than the first. */
const ESCAPE_FLAGS = [
  "--user",
  "--scope",
  "--unit=yaco-tmux-server",
  "--property=ManagedOOMPreference=avoid",
  "--collect",
  "--quiet",
];

/** argv form, for callers that spawn without a shell. */
export const CGROUP_ESCAPE_ARGV = [
  "systemd-run",
  ...ESCAPE_FLAGS,
  `--description=${ESCAPE_DESCRIPTION}`,
];

/** Shell-string form, for callers that build a `tmux …` command line. */
export const CGROUP_ESCAPE_PREFIX =
  `systemd-run ${ESCAPE_FLAGS.join(" ")} --description="${ESCAPE_DESCRIPTION}" `;

/** The leaf of a cgroup v2 `/proc/<pid>/cgroup`, whose one line reads
 *  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/<leaf>". */
export function cgroupLeaf(procSelfCgroup: string): string | undefined {
  return procSelfCgroup.split("\n").find(l => l.startsWith("0::"))?.split("/").pop()?.trim();
}

/** Whether a process whose leaf cgroup is `leaf` needs the escape: a managed
 *  `.service` would take tmux down with it — on `systemctl restart`, or on a
 *  systemd-oomd kill, which SIGKILLs every process in the cgroup at once.
 *  `user@<uid>.service` is the user manager itself — direct membership means
 *  we're a top-level user process in a `.scope`, never directly in user@. */
export function needsCgroupEscape(leaf: string | undefined): boolean {
  return !!leaf && leaf.endsWith(".service") && !/^user@\d+\.service$/.test(leaf);
}
