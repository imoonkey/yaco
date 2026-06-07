/** Text-vs-JSON output convention for ordinary result-bearing commands.
 *
 *  Two text-mode envelopes exist and `render()` writes both verbatim:
 *    - `{help}` is usage text only (`--help`).
 *    - `{text}` is the single result-rendering envelope for ordinary commands.
 *
 *  `dual` is the one branch a handler needs: emit the structured record in
 *  `--json` mode, or the rendered text wrapped in `{text}` otherwise. The
 *  `render` callback is only invoked in text mode, so callers pay no formatting
 *  cost on the JSON path.
 *
 *  Streaming / process-owning commands (`agent output-follow`, `align poll`,
 *  `doctor`) are explicit exceptions: they own stdout directly and never go
 *  through `dual` or the `{text}` rule.
 */

import { ok, type Result } from "./result.ts";

export const dual = (
  json: boolean,
  data: unknown,
  render: () => string,
): Result<unknown> => ok(json ? data : { text: render() });
