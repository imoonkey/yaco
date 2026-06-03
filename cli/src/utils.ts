import { randomBytes } from "crypto";
import { ADJECTIVES, NOUNS } from "./words.ts";

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export function validateName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid session name: "${name}". Only alphanumeric, hyphens, and underscores allowed.`);
  }
}

/** Extract --name / -n value from args (last occurrence wins, CLI convention) */
export function extractName(args: string[]): string | undefined {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "--name" || arg === "-n") && i + 1 < args.length) {
      name = args[i + 1];
      i++;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    }
  }
  return name;
}

// ANSI escape code stripping
const ANSI_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const ANSI_OSC_REGEX = /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const C1_CONTROL_REGEX = /[\u0080-\u009F]/g;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_OSC_REGEX, "")
    .replace(ANSI_REGEX, "")
    .replace(C1_CONTROL_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, "");
}

// Short hash for default session names
export function shortHash(): string {
  return randomBytes(2).toString("hex"); // 4 chars like "a3f1"
}

// Resolve name with collision handling
export function resolveName(
  baseName: string,
  existsFn: (name: string) => boolean,
): string {
  if (!existsFn(baseName)) return baseName;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseName}-${i}`;
    if (!existsFn(candidate)) return candidate;
  }
  // Fallback: append random suffix
  return `${baseName}-${shortHash()}`;
}

export function buildDefaultSessionName(provider: string): string {
  const pick = (list: readonly string[]) =>
    list[Math.floor(Math.random() * list.length)]!;
  const hex = randomBytes(3).toString("hex");
  return `${provider}-${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(NOUNS)}-${hex}`;
}

