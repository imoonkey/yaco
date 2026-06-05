/** Command quoting helpers for provider command assembly. */

/** Single-quote a shell argument, escaping embedded single quotes. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
