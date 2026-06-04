#!/usr/bin/env bun
/** Slim entry point for `yaco agent hook-event`.
 *
 *  Provider hooks fire on every event in a session and (for Codex) block the
 *  agent loop until they return. Routing through `main.ts → handleAgent`
 *  would load the entire agent command surface (start/send/capture/...) on
 *  every hook fire, which is gratuitous overhead for what's a one-liner JSON
 *  read + state-file write. This entry only loads what hook-event needs.
 */
import { readFileSync } from "fs";
import { runHookEvent, type HookInput } from "./lib/core/agent/hook-event.ts";

function main(): void {
  const eventName = process.argv[2];
  if (!eventName) {
    process.stderr.write("yaco-hook-event: requires <EventName> as argv[1]\n");
    process.exit(2);
  }
  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf-8");
    if (raw.trim().length > 0) {
      input = JSON.parse(raw) as HookInput;
    }
  } catch {
    // Silent on parse failure — mirrors prior shell handler's contract.
    process.exit(0);
  }
  runHookEvent(eventName, input);
}

if (import.meta.main) {
  main();
}
