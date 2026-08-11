/** Minimal scoped TOML reader for yaco.toml.
 *
 *  yaco.toml only carries small string overrides under [paths] (and an
 *  optional ignored [project] table). A full TOML parser would dwarf the
 *  data it reads, so this implementation handles only the slice we care
 *  about: section headers, `key = "string"`, comments, blank lines.
 *
 *  Anything that does not match — multi-line strings, inline tables,
 *  arrays, numbers — is rejected with a line-numbered error so malformed
 *  files surface clearly rather than parse to silent defaults.
 */

import { CliError, ErrCode } from "../errors.ts";

export interface ParsedTomlSections {
  [section: string]: Record<string, string>;
}

/** A parse failure, in the one error vocabulary the exports map publishes.
 *
 *  This used to be a `TomlParseError` class, exported alongside the parser.
 *  Export eligibility rule 6 admits one vocabulary, and an in-process caller
 *  that has to learn a second error type is how a second one spreads —
 *  `app/server` imports this parser directly. The message and the `ENV` code
 *  are exactly what `readYacoProjectPaths` used to translate the class into,
 *  and no `details` is attached, so the CLI envelope is byte-identical — the
 *  line number stays where it always was, in the message. */
const parseError = (message: string, line: number): CliError =>
  new CliError(ErrCode.ENV, `yaco.toml:${line}: ${message}`);

const SECTION_RE = /^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/;
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

/** Parse a yaco.toml source string into `{ section: { key: string } }`.
 *  Only string values are accepted; other TOML types throw CliError(ENV). */
export function parseScopedToml(source: string): ParsedTomlSections {
  const sections: ParsedTomlSections = {};
  let current: string | null = null;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const trimmed = stripComment(raw).trim();
    if (trimmed === "") continue;

    const section = SECTION_RE.exec(trimmed);
    if (section) {
      current = section[1] ?? "";
      if (!(current in sections)) sections[current] = {};
      continue;
    }

    const kv = KEY_RE.exec(trimmed);
    if (!kv) {
      throw parseError(`expected "key = value" or "[section]"`, lineNo);
    }
    if (current === null) {
      throw parseError(
        `key "${kv[1]}" outside any [section]; yaco.toml uses [paths]`,
        lineNo,
      );
    }

    const key = kv[1] ?? "";
    if (key in sections[current]!) {
      throw parseError(
        `duplicate key "${key}" in [${current}]`,
        lineNo,
      );
    }
    const value = parseStringValue(kv[2] ?? "", lineNo);
    sections[current]![key] = value;
  }

  return sections;
}

/** Strip an unquoted `# comment` tail, leaving quoted-string `#`s intact. */
function stripComment(line: string): string {
  let inString = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      continue;
    }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

function parseStringValue(raw: string, lineNo: number): string {
  const s = raw.trim();
  if (s.length < 2) {
    throw parseError(`value must be a quoted string`, lineNo);
  }
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    const body = s.slice(1, -1);
    if (first === "'") {
      // Literal string: no escapes.
      if (body.includes("'")) {
        throw parseError(`unterminated literal string`, lineNo);
      }
      return body;
    }
    return decodeBasicString(body, lineNo);
  }
  throw parseError(`value must be a quoted string, got: ${s}`, lineNo);
}

function decodeBasicString(body: string, lineNo: number): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      if (c === '"') {
        throw parseError(`unescaped quote inside basic string`, lineNo);
      }
      out += c;
      continue;
    }
    i++;
    const esc = body[i];
    switch (esc) {
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      default:
        throw parseError(
          `unsupported escape \\${esc ?? ""} (use a literal 'string' if needed)`,
          lineNo,
        );
    }
  }
  return out;
}
