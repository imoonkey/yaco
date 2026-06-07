import { capturePane, hasSession } from "../../lib/core/agent/tmux.ts";
import { stripAnsi, validateName } from "../../lib/core/agent/model.ts";

export async function capture(
  name: string,
  options: { lines?: number; stripAnsiCodes?: boolean },
): Promise<string> {
  validateName(name);
  const includeEscapes = options.stripAnsiCodes === false;
  if (!hasSession(name)) {
    throw new Error(`Session "${name}" not found`);
  }

  const output = capturePane(name, options.lines, includeEscapes);
  return options.stripAnsiCodes !== false ? stripAnsi(output) : output;
}
