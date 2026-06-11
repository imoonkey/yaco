/** Full-inventory message readers for `yaco agent messages`.
 *
 *  Parallel to output.ts (turn-completion only): this reconstructs EVERY
 *  message in a provider's session log as a normalized row with a stable index.
 *
 *  Inclusion is keyed on a coarse, FROZEN discriminator — Claude
 *  user/assistant non-sidechain lines, Codex non-developer response_items —
 *  never on the fine-grained block/payload kind. Unknown kinds reconstruct to a
 *  generic `[<type>]` placeholder, so enriching reconstruction later can never
 *  insert or drop a row: historical indices stay put. Path resolution reuses
 *  output.ts so provider-home encoding lives in one place. */

import { resolveClaudeLogPath, resolveCodexLogPath } from "./output.ts";
import type { MessageRole, ParsedMessage, ProviderMessages } from "./types.ts";

/** JSON.stringify that never throws and renders a string verbatim / undefined
 *  as "". Parsed-JSON input can't be circular, but guard anyway. */
function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** First-seen, order-preserving de-dupe of type tokens. */
function dedupe(types: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of types) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function tsOf(entry: { timestamp?: unknown }): string | null {
  return typeof entry.timestamp === "string" ? entry.timestamp : null;
}

// -- Claude --

interface ClaudeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

/** Render a tool_result block's `content`: a string, or an array of nested
 *  text/image/other blocks joined by newline. */
function renderClaudeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((x) => {
      if (!x || typeof x !== "object") return "";
      const b = x as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return `[${b.type ?? "unknown"}]`;
    })
    .join("\n");
}

/** One Claude content block → its (text segment, type token). */
function renderClaudeBlock(b: ClaudeBlock): { text: string; type: string } {
  switch (b.type) {
    case "text":
      return { text: b.text ?? "", type: "text" };
    case "thinking":
      return { text: b.thinking ?? "", type: "thinking" };
    case "tool_use":
      return { text: `${b.name ?? "tool"}(${safeStringify(b.input)})`, type: `tool_use:${b.name ?? "?"}` };
    case "tool_result":
      return { text: renderClaudeToolResult(b.content), type: "tool_result" };
    case "image":
      return { text: "[image]", type: "image" };
    default:
      return { text: `[${b.type ?? "unknown"}]`, type: b.type ?? "unknown" };
  }
}

function parseClaudeLine(line: string): ParsedMessage | null {
  let entry: { type?: string; isSidechain?: boolean; timestamp?: unknown; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (entry.isSidechain === true) return null;

  const role: MessageRole = entry.type;
  const content = entry.message?.content;
  const segments: string[] = [];
  const types: string[] = [];

  if (typeof content === "string") {
    segments.push(content);
    types.push("text");
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const { text, type } = renderClaudeBlock(raw as ClaudeBlock);
      segments.push(text);
      types.push(type);
    }
  }
  // Any other content shape still yields a row (inclusion is by top-level type)
  // with empty text — never a skip, so indices stay frozen.

  return { role, types: dedupe(types), text: segments.join("\n"), ts: tsOf(entry) };
}

export function claudeMessages(): ProviderMessages {
  return {
    resolveLogPath: async (session) => resolveClaudeLogPath(session),
    parseLine: parseClaudeLine,
  };
}

// -- Codex --

interface CodexPayload {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  query?: unknown;
  output?: unknown;
  summary?: unknown;
}

/** Codex message content: input_text/output_text → text, *_image → [image]. */
function renderCodexContent(content: unknown): { text: string; types: string[] } {
  if (!Array.isArray(content)) return { text: "", types: [] };
  const segments: string[] = [];
  const types: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as { type?: string; text?: string };
    if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
      segments.push(b.text);
      types.push("text");
    } else if (b.type === "input_image" || b.type === "output_image") {
      segments.push("[image]");
      types.push("image");
    } else {
      segments.push(`[${b.type ?? "unknown"}]`);
      types.push(b.type ?? "unknown");
    }
  }
  return { text: segments.join("\n"), types };
}

/** Codex reasoning summary array → joined text (often empty). */
function renderCodexReasoning(p: CodexPayload): string {
  if (!Array.isArray(p.summary)) return "";
  return p.summary
    .map((s) =>
      s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string"
        ? (s as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Text inside a tool call: arguments string, else input, else query. */
function codexCallText(p: CodexPayload): string {
  if (typeof p.arguments === "string") return p.arguments;
  if (p.input !== undefined) return safeStringify(p.input);
  if (typeof p.query === "string") return p.query;
  return "";
}

function parseCodexLine(line: string): ParsedMessage | null {
  let entry: { type?: string; timestamp?: unknown; payload?: CodexPayload };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object" || entry.type !== "response_item") return null;
  const p = entry.payload;
  if (!p || typeof p !== "object") return null;
  const ts = tsOf(entry);
  const pt = typeof p.type === "string" ? p.type : "";

  if (pt === "message") {
    if (p.role === "developer") return null; // injected sandbox/system prompt
    const role: MessageRole = p.role === "user" ? "user" : "assistant";
    const { text, types } = renderCodexContent(p.content);
    return { role, types: dedupe(types), text, ts };
  }
  if (pt === "reasoning") {
    return { role: "assistant", types: ["thinking"], text: renderCodexReasoning(p), ts };
  }
  if (pt.endsWith("_call")) {
    const name = typeof p.name === "string" ? p.name : pt;
    return { role: "assistant", types: [`tool_use:${name}`], text: `${name}(${codexCallText(p)})`, ts };
  }
  if (pt.endsWith("_output")) {
    return { role: "user", types: ["tool_result"], text: safeStringify(p.output), ts };
  }
  // Unknown response_item kind: keep as a row (placeholder) so indices stay frozen.
  return { role: "assistant", types: [pt || "unknown"], text: "", ts };
}

export function codexMessages(): ProviderMessages {
  return {
    resolveLogPath: resolveCodexLogPath,
    parseLine: parseCodexLine,
  };
}
