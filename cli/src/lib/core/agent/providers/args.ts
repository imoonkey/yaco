/** Passthrough-arg helpers shared by provider command adapters. */

/** True when any permission-related flag is present (prefix match handles
 *  `--flag=value`). When present, the provider's default permission flag is
 *  not injected. */
export function hasPermissionFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(flag + "=")));
}

/** True when args already carry a name flag (`--name`, `--name=`, `-n`). */
export function hasNameFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--name" || arg === "-n" || arg.startsWith("--name="));
}

/** Strip `--name` / `-n` (and their values) for providers that reject them. */
export function stripNameFlag(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--name" || arg === "-n") {
      i++; // skip value
    } else if (arg.startsWith("--name=")) {
      // skip
    } else {
      result.push(arg);
    }
  }
  return result;
}

/** Extract a resume id from passthrough args — flag form (`--resume <id>`,
 *  `--resume=<id>`) or leading positional `resume <id>`. */
export function extractResume(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--resume" && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length);
  }
  if (args.length >= 2 && args[0] === "resume" && !args[1]!.startsWith("-")) {
    return args[1];
  }
  return undefined;
}

/** Remove the resume flag+value or positional `resume <id>` from args. */
export function stripResume(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--resume") { i++; continue; }
    if (arg.startsWith("--resume=")) continue;
    result.push(arg);
  }
  if (result.length >= 2 && result[0] === "resume" && !result[1]!.startsWith("-")) {
    return result.slice(2);
  }
  return result;
}
