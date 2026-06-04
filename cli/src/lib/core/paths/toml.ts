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

export interface ParsedTomlSections {
  [section: string]: Record<string, string>;
}

export class TomlParseError extends Error {
  public readonly line: number;
  constructor(message: string, line: number) {
    super(`yaco.toml:${line}: ${message}`);
    this.name = "TomlParseError";
    this.line = line;
  }
}

const SECTION_RE = /^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/;
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

/** Parse a yaco.toml source string into `{ section: { key: string } }`.
 *  Only string values are accepted; other TOML types throw TomlParseError. */
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
      throw new TomlParseError(`expected "key = value" or "[section]"`, lineNo);
    }
    if (current === null) {
      throw new TomlParseError(
        `key "${kv[1]}" outside any [section]; yaco.toml uses [paths]`,
        lineNo,
      );
    }

    const key = kv[1] ?? "";
    if (key in sections[current]!) {
      throw new TomlParseError(
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
    throw new TomlParseError(`value must be a quoted string`, lineNo);
  }
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    const body = s.slice(1, -1);
    if (first === "'") {
      // Literal string: no escapes.
      if (body.includes("'")) {
        throw new TomlParseError(`unterminated literal string`, lineNo);
      }
      return body;
    }
    return decodeBasicString(body, lineNo);
  }
  throw new TomlParseError(`value must be a quoted string, got: ${s}`, lineNo);
}

function decodeBasicString(body: string, lineNo: number): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      if (c === '"') {
        throw new TomlParseError(`unescaped quote inside basic string`, lineNo);
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
        throw new TomlParseError(
          `unsupported escape \\${esc ?? ""} (use a literal 'string' if needed)`,
          lineNo,
        );
    }
  }
  return out;
}
