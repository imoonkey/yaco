#!/usr/bin/env bun

import { start } from "./commands/start.ts";
import { send } from "./commands/send.ts";
import { capture } from "./commands/capture.ts";
import { status } from "./commands/status.ts";
import { kill } from "./commands/kill.ts";
import { rename } from "./commands/rename.ts";
import { hookUpdate } from "./commands/hook-update.ts";
import { ensureHooks } from "./hooks.ts";
import { PROVIDERS } from "./providers.ts";
import { extractName } from "./utils.ts";

const HELP = `multmux — lightweight multi-agent orchestration via tmux

Usage:
  multmux <provider> [args...]                  Start agent (all args passed through)
  multmux start <provider> [args...] [--json]   Start agent (explicit form)
  multmux send <name> "message"
  multmux capture <name> [--wait] [--lines <n>] [--strip-ansi true|false]
  multmux rename <old-name> <new-name>
  multmux kill <name>
  multmux kill --all
  multmux status [name] [--json] [--all] [--path <path>]

Providers: ${Object.keys(PROVIDERS).join(", ")}

Everything after the provider name is passed through to the agent CLI.
Use --name <handle> to set the session handle (extracted by multmux, passed to agent).

Examples:
  multmux claude "Fix the tests" --name fixer
  multmux codex "Implement auth" --name builder --model o4-mini
  multmux claude --resume abc123 --name reviewer
  multmux send designer "Also consider rate limiting"
  multmux capture designer --wait
  multmux kill designer
  multmux status --all
`;

// Multmux's own commands (not provider names)
const MULTMUX_COMMANDS = new Set(["start", "send", "capture", "kill", "status", "rename", "hook-update", "install-hooks"]);

interface ParsedArgs {
  command: string;
  positional: string[];
  passthrough: string[];
  options: {
    name?: string;
    all: boolean;
    wait: boolean;
    lines?: number;
    stripAnsi: boolean;
    json: boolean;
    path?: string;
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let command = "";
  const passthrough: string[] = [];
  const options = {
    all: false,
    wait: false,
    stripAnsi: true,
    json: false,
    name: undefined as string | undefined,
    lines: undefined as number | undefined,
    path: undefined as string | undefined,
  };

  // First pass: determine if this is a provider shortcut or multmux command
  const firstArg = argv[0];
  if (!firstArg) return { command: "", positional, passthrough, options };

  // Provider shortcut: everything after provider is passthrough
  if (firstArg in PROVIDERS) {
    command = firstArg;
    const rest = argv.slice(1);
    // Extract --json (multmux's own flag for start)
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") {
        options.json = true;
      } else {
        passthrough.push(rest[i]!);
      }
    }
    options.name = extractName(passthrough);
    return { command, positional, passthrough, options };
  }

  // "start" command: next arg is provider, rest is passthrough
  if (firstArg === "start") {
    command = "start";
    const provider = argv[1];
    if (provider) positional.push(provider);
    const rest = argv.slice(2);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") {
        options.json = true;
      } else {
        passthrough.push(rest[i]!);
      }
    }
    options.name = extractName(passthrough);
    return { command, positional, passthrough, options };
  }

  // Other multmux commands: parse normally
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-n" || arg === "--name") {
      options.name = argv[++i];
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--wait") {
      options.wait = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--lines") {
      options.lines = parseInt(argv[++i]!, 10);
    } else if (arg === "--strip-ansi") {
      const val = argv[++i];
      options.stripAnsi = val !== "false";
    } else if (arg === "--path") {
      options.path = argv[++i];
    } else if (!arg.startsWith("-")) {
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, positional, passthrough, options };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const { command, positional, passthrough, options } = parseArgs(args);

  try {
    switch (command) {
      case "start": {
        const provider = positional[0];
        if (!provider) {
          console.error("Usage: multmux start <provider> [args...]");
          process.exit(1);
        }
        const state = start(provider, passthrough, options.name);
        console.log(options.json ? JSON.stringify(state) : state.handle);
        break;
      }

      case "send": {
        const name = positional[0];
        const message = positional.slice(1).join(" ");
        if (!name || !message) {
          console.error('Usage: multmux send <name> "message"');
          process.exit(1);
        }
        send(name, message);
        break;
      }

      case "capture": {
        const name = positional[0];
        if (!name) {
          console.error("Usage: multmux capture <name> [--wait] [--lines <n>]");
          process.exit(1);
        }
        const output = await capture(name, {
          wait: options.wait,
          lines: options.lines,
          stripAnsiCodes: options.stripAnsi,
        });
        console.log(output);
        break;
      }

      case "kill": {
        if (options.all) {
          if (positional.length > 0) {
            console.error("Usage: multmux kill --all");
            process.exit(1);
          }
          kill(undefined, { all: true });
          break;
        }

        const name = positional[0];
        if (!name || positional.length !== 1) {
          console.error("Usage: multmux kill <name> | multmux kill --all");
          process.exit(1);
        }
        kill(name);
        break;
      }

      case "status": {
        const output = status(positional[0], {
          json: options.json,
          all: options.all,
          path: options.path,
        });
        console.log(output);
        break;
      }

      case "rename": {
        const oldName = positional[0];
        const newName = positional[1];
        if (!oldName || !newName || positional.length !== 2) {
          console.error("Usage: multmux rename <old-name> <new-name>");
          process.exit(1);
        }
        rename(oldName, newName);
        console.log(`Renamed "${oldName}" → "${newName}"`);
        break;
      }

      case "hook-update": {
        hookUpdate();
        break;
      }

      case "install-hooks": {
        ensureHooks("claude");
        ensureHooks("codex");
        break;
      }

      default: {
        // Provider shortcut: `multmux claude "prompt"` => start
        if (command in PROVIDERS) {
          const state = start(command, passthrough, options.name);
          console.log(options.json ? JSON.stringify(state) : state.handle);
          break;
        }
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
