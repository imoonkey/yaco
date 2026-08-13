import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CliError, ErrCode } from "./errors.ts";

/** Append `entry` as its own line unless already present.
 *
 * Creates the file if absent and preserves existing content. Presence follows
 * gitignore whitespace rules: trailing whitespace is insignificant, while
 * leading whitespace is significant. Read failures other than ENOENT fail
 * closed rather than risking replacement of an unreadable file. */
export function ensureLine(filePath: string, entry: string): boolean {
  let current = "";
  try {
    current = readFileSync(filePath, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError(ErrCode.IO, `could not read ${filePath}: ${(error as Error).message}`);
    }
  }
  if (current.split(/\r?\n/).some((line) => line.trimEnd() === entry)) return false;

  mkdirSync(dirname(filePath), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, current + prefix + entry + "\n");
  return true;
}
