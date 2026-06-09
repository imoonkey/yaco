import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { detectDarkMode, resolveAgentPidFromProcesses } from "../src/lib/core/agent/tmux.ts";

const src = readFileSync(join(__dirname, "..", "src", "lib", "core", "agent", "tmux.ts"), "utf-8");

describe("tmux exact-match safety", () => {
  it("all tmux -t targets use sessionTarget() or paneTarget() helpers", () => {
    // Every tmux command that targets a session/pane by handle must use the
    // sessionTarget() or paneTarget() helper to get exact-match "=" prefix.
    // Raw inline "-t" with a variable should not appear.
    const rawTargetPattern = /tmux\s+\S+\s+.*-t\s+"\$\{|tmux\s+\S+\s+.*-t\s+"=\$\{/;
    const matches = src.match(new RegExp(rawTargetPattern.source, "g")) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("defines sessionTarget and paneTarget helpers with = prefix", () => {
    expect(src).toContain('const sessionTargetValue = (handle: string) => `=${handle}`;');
    expect(src).toContain('const paneTargetValue = (handle: string) => `=${handle}:`;');
    expect(src).toContain('const sessionTarget = (handle: string) => `"${sessionTargetValue(handle)}"`;');
    expect(src).toContain('const paneTarget = (handle: string) => `"${paneTargetValue(handle)}"`;');
  });

  it("uses sessionTarget for target-session commands", () => {
    // has-session, kill-session, rename-session, list-panes take target-session
    expect(src).toContain("has-session -t ${sessionTarget(");
    expect(src).toContain("kill-session -t ${sessionTarget(");
    expect(src).toContain("rename-session -t ${sessionTarget(");
    expect(src).toContain("list-panes -t ${sessionTarget(");
  });

  it("uses paneTarget for target-pane commands", () => {
    // set-option, set, send-keys, capture-pane take target-pane in shell strings.
    // send-keys uses execFileSync argv form and therefore the unquoted target value.
    expect(src).toContain("set-option -t ${paneTarget(");
    expect(src).toContain("set -t ${paneTarget(");
    expect(src).toContain('execTmux(["send-keys", "-t", paneTargetValue(handle),');
    expect(src).toContain('execTmux(["pipe-pane", "-o", "-t", target,');
    expect(src).toContain("capture-pane -t ${paneTarget(");
  });

  it("uses bracketed paste for text before submitting Enter", () => {
    expect(src).toContain('execTmux(["load-buffer", "-b", bufferName, "-"], text);');
    expect(src).toContain('execTmux(["paste-buffer", "-p", "-t", paneTargetValue(handle), "-b", bufferName]);');
    expect(src).toContain('execTmux(["send-keys", "-t", paneTargetValue(handle), "Enter"]);');
  });
});

describe("Codex OSC color response handling", () => {
  it("responds to observed OSC color queries instead of blind timed sends", () => {
    expect(src).toContain('execTmux(["pipe-pane", "-o", "-t", target, `bash -lc ${shellQuote(script)}`]);');
    expect(src).toContain('query10=$');
    expect(src).toContain('query11=$');
    expect(src).toContain('tmux send-keys -t "$target" -H $hex');
    expect(src).not.toContain("OSC_COLOR_RESPONSE_DELAYS");
  });

  it("keeps listening through the startup window after the first color query", () => {
    expect(src).toContain("while (( SECONDS < deadline )); do");
    expect(src).toContain("      buf=''");
    expect(src).not.toContain("      exit 0");
  });

  it("uses the app editor light background for startup replies", () => {
    expect(src).toContain('"fdfd/f6f6/e3e3"');
    expect(src).not.toContain('"eeee/e8e8/d5d5"');
  });
});

describe("terminal appearance detection", () => {
  const noThemeCommand = () => null;

  it("honors explicit multmux dark theme override", () => {
    expect(detectDarkMode({ MULTMUX_THEME: "dark" }, "linux", noThemeCommand)).toBe(true);
  });

  it("honors explicit multmux light theme override before platform probes", () => {
    const runCommand = () => "'prefer-dark'";
    expect(detectDarkMode({ MULTMUX_THEME: "light" }, "linux", runCommand)).toBe(false);
  });

  it("detects GNOME dark color-scheme on Linux", () => {
    const runCommand = (cmd: string) => cmd.includes("color-scheme") ? "'prefer-dark'" : null;
    expect(detectDarkMode({}, "linux", runCommand)).toBe(true);
  });

  it("detects KDE dark color scheme on Linux", () => {
    const runCommand = (cmd: string) => cmd.includes("kreadconfig6") ? "BreezeDark" : null;
    expect(detectDarkMode({}, "linux", runCommand)).toBe(true);
  });

  it("detects macOS dark appearance", () => {
    const runCommand = (cmd: string) => cmd.includes("AppleInterfaceStyle") ? "Dark" : null;
    expect(detectDarkMode({}, "darwin", runCommand)).toBe(true);
  });

  it("falls back to light when no theme can be detected", () => {
    expect(detectDarkMode({}, "linux", noThemeCommand)).toBe(false);
  });
});

describe("resolveAgentPidFromProcesses", () => {
  it("returns the matching direct child agent", () => {
    const pid = resolveAgentPidFromProcesses(
      [
        { pid: 10, ppid: 1, command: "bash" },
        { pid: 11, ppid: 10, command: "claude" },
      ],
      10,
      "claude",
    );

    expect(pid).toBe(11);
  });

  it("finds the preferred agent deeper in the descendant tree", () => {
    const pid = resolveAgentPidFromProcesses(
      [
        { pid: 20, ppid: 1, command: "bash" },
        { pid: 21, ppid: 20, command: "env" },
        { pid: 22, ppid: 21, command: "sh" },
        { pid: 23, ppid: 22, command: "codex" },
      ],
      20,
      "codex",
    );

    expect(pid).toBe(23);
  });

  it("prefers a known agent process when helpers are also present", () => {
    const pid = resolveAgentPidFromProcesses(
      [
        { pid: 30, ppid: 1, command: "bash" },
        { pid: 31, ppid: 30, command: "env" },
        { pid: 32, ppid: 31, command: "gh" },
        { pid: 33, ppid: 31, command: "claude" },
        { pid: 34, ppid: 33, command: "caffeinate" },
      ],
      30,
      "claude",
    );

    expect(pid).toBe(33);
  });

  it("falls back to the first descendant when no known agent name is found", () => {
    const pid = resolveAgentPidFromProcesses(
      [
        { pid: 40, ppid: 1, command: "bash" },
        { pid: 41, ppid: 40, command: "env" },
        { pid: 42, ppid: 41, command: "custom-runner" },
      ],
      40,
    );

    expect(pid).toBe(41);
  });

  it("returns null when a preferred command is requested but not present yet", () => {
    const pid = resolveAgentPidFromProcesses(
      [
        { pid: 45, ppid: 1, command: "bash" },
        { pid: 46, ppid: 45, command: "env" },
      ],
      45,
      "codex",
    );

    expect(pid).toBeNull();
  });

  it("returns null when the pane has no descendants", () => {
    const pid = resolveAgentPidFromProcesses(
      [{ pid: 50, ppid: 1, command: "bash" }],
      50,
      "claude",
    );

    expect(pid).toBeNull();
  });
});
