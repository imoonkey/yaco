/** Minimal argv parser for the dispatcher and subcommands.
 *
 *  Splits argv into positional tokens and a flat flag map. No subcommand
 *  knowledge — area routers take the leading positionals and re-parse the
 *  remainder. Long flags only (`--name value`, `--flag`, `--key=value`);
 *  single-dash tokens are treated as boolean flags so passthrough cases
 *  (handing args to an agent CLI) can detect and forward them.
 */

export type FlagValue = string | boolean;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, FlagValue>;
  /** Tokens after `--`, in order, untouched. */
  rest: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          flags[body] = true;
        } else {
          flags[body] = next;
          i++;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
    i++;
  }

  return { positional, flags, rest };
}

/** Read a flag as a string. Falsy boolean (--flag with no value) returns undefined. */
export function flagString(
  args: ParsedArgs,
  ...names: string[]
): string | undefined {
  for (const n of names) {
    const v = args.flags[n];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Read a flag as a boolean. Presence (any value) → true. */
export function flagBool(args: ParsedArgs, ...names: string[]): boolean {
  for (const n of names) {
    if (n in args.flags) return true;
  }
  return false;
}
