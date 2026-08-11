/** Collapsing a user message down to the label a human recognizes the session
 *  by.
 *
 *  Shared by the history list (`history.ts`) and the session-summary read
 *  (`summary-read.ts`): both answer "what was this session asked to do", and a
 *  second copy of these rules is how the History tab and the session list start
 *  disagreeing about the same session. */

/** Flatten a JSONL user message `content` field to plain text. */
export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: { text?: string }) => b.text ?? "").join(" ");
  }
  return "";
}

/** Extract `<command-args>` content from a `<command-message>` wrapper. */
function extractCommandArgs(text: string): string | null {
  const match = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = match?.[1]?.trim();
  return args ? args : null;
}

/** Extract the command name (e.g. "/design") from a `<command-message>` wrapper. */
function extractCommandName(text: string): string | null {
  const match = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  return match ? match[1]!.trim() || null : null;
}

/** Harness-injected blocks that carry no user intent. */
const NOISE_BLOCKS =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi;
/** Slash-command wrapper tags; stripped so only the human-facing args/prose remain. */
const COMMAND_BLOCKS = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/gi;
/** Session-management commands that carry no task intent — skipped so the real
 *  prompt surfaces instead. */
const META_COMMANDS = new Set(["/rename", "/clear", "/compact"]);

/** Collapse one user message to its display intent, or "" if it is pure noise.
 *  Reminders and command stdout are dropped. Prose typed alongside a command
 *  wins; a slash command is restored to its original `/name args` input; a
 *  session-management command (e.g. `/rename`) collapses to "". */
export function collapseUserMessage(raw: string): string {
  const stripped = raw.replace(NOISE_BLOCKS, "");
  const prose = stripped.replace(COMMAND_BLOCKS, "").replace(/\s+/g, " ").trim();
  if (prose) return prose;
  const name = extractCommandName(stripped);
  if (!name) return "";
  if (META_COMMANDS.has(name)) return "";
  const args = extractCommandArgs(stripped);
  return (args ? `${name} ${args}` : name).replace(/\s+/g, " ").trim();
}

/** First user message that carries real intent, collapsed for display. Skips
 *  noise (reminders, stdout, session-management commands) and, when a handle is
 *  given, messages that merely echo it (e.g. an auto-assigned title).
 *
 *  The per-text verdict is independent of the texts around it, which is what
 *  lets the summary read feed this one log line at a time and stop early
 *  without changing the answer a whole-file scan would give. */
export function firstMeaningfulMessage(rawTexts: Iterable<string>, handle?: string): string | null {
  for (const raw of rawTexts) {
    const label = collapseUserMessage(raw);
    if (!label) continue;
    if (handle && handle.startsWith(label)) continue;
    return label;
  }
  return null;
}
