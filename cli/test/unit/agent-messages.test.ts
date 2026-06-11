/** Unit tests for the full-inventory message readers (`yaco agent messages`).
 *
 *  Exercises `parseLine` for both providers over every kept and intentionally
 *  skipped line shape, the generic placeholder fallback for unknown kinds, and
 *  timestamp extraction. The command-layer indexing/filters/rendering live in
 *  agent-messages-command.test.ts. */

import { describe, it, expect } from "bun:test";
import { claudeMessages, codexMessages } from "../../src/lib/core/agent/providers/messages.ts";

const claude = claudeMessages().parseLine;
const codex = codexMessages().parseLine;

const TS = "2026-06-11T06:44:24.840Z";

function cl(entry: object): string {
  return JSON.stringify(entry);
}

describe("claude parseLine", () => {
  it("skips header/meta/blank/malformed lines", () => {
    for (const t of [
      "custom-title",
      "agent-name",
      "mode",
      "permission-mode",
      "last-prompt",
      "system",
      "attachment",
      "file-history-snapshot",
    ]) {
      expect(claude(cl({ type: t }))).toBeNull();
    }
    expect(claude("")).toBeNull();
    expect(claude("{not json")).toBeNull();
  });

  it("skips sidechain (sub-agent) lines", () => {
    const line = cl({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "x" }] } });
    expect(claude(line)).toBeNull();
  });

  it("parses user string content", () => {
    const r = claude(cl({ type: "user", timestamp: TS, message: { content: "hello world" } }));
    expect(r).toEqual({ role: "user", types: ["text"], text: "hello world", ts: TS });
  });

  it("parses user array text block", () => {
    const r = claude(cl({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }));
    expect(r).toMatchObject({ role: "user", types: ["text"], text: "hi", ts: null });
  });

  it("parses tool_result with string content", () => {
    const r = claude(cl({ type: "user", message: { content: [{ type: "tool_result", content: "ok done" }] } }));
    expect(r).toMatchObject({ role: "user", types: ["tool_result"], text: "ok done" });
  });

  it("parses tool_result with nested text/image array content", () => {
    const r = claude(
      cl({
        type: "user",
        message: { content: [{ type: "tool_result", content: [{ type: "text", text: "line" }, { type: "image" }] }] },
      }),
    );
    expect(r).toMatchObject({ types: ["tool_result"], text: "line\n[image]" });
  });

  it("parses mixed user array (text + tool_result), de-duping types order", () => {
    const r = claude(
      cl({ type: "user", message: { content: [{ type: "text", text: "a" }, { type: "tool_result", content: "b" }] } }),
    );
    expect(r).toMatchObject({ role: "user", types: ["text", "tool_result"], text: "a\nb" });
  });

  it("parses assistant text / thinking / tool_use", () => {
    expect(claude(cl({ type: "assistant", message: { content: [{ type: "text", text: "t" }] } }))).toMatchObject({
      role: "assistant",
      types: ["text"],
      text: "t",
    });
    expect(claude(cl({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }))).toMatchObject(
      { types: ["thinking"], text: "hmm" },
    );
    const tu = claude(
      cl({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }] } }),
    );
    expect(tu).toMatchObject({ role: "assistant", types: ["tool_use:Bash"], text: 'Bash({"cmd":"ls"})' });
  });

  it("parses a multi-block assistant line in order", () => {
    const r = claude(
      cl({
        type: "assistant",
        message: { content: [{ type: "text", text: "x" }, { type: "thinking", thinking: "y" }, { type: "tool_use", name: "Read", input: {} }] },
      }),
    );
    expect(r).toMatchObject({ types: ["text", "thinking", "tool_use:Read"], text: "x\ny\nRead({})" });
  });

  it("keeps an unknown block as a placeholder row (frozen indices)", () => {
    const r = claude(cl({ type: "assistant", message: { content: [{ type: "redacted_thinking" }] } }));
    expect(r).toMatchObject({ types: ["redacted_thinking"], text: "[redacted_thinking]" });
  });

  it("keeps a user/assistant line with no usable content as an empty row", () => {
    const r = claude(cl({ type: "user", message: {} }));
    expect(r).toMatchObject({ role: "user", types: [], text: "" });
  });
});

describe("codex parseLine", () => {
  it("skips non-response_item records and developer messages", () => {
    expect(codex(cl({ type: "session_meta" }))).toBeNull();
    expect(codex(cl({ type: "turn_context" }))).toBeNull();
    expect(codex(cl({ type: "event_msg", payload: { type: "agent_message" } }))).toBeNull();
    expect(codex(cl({ type: "response_item", payload: { type: "message", role: "developer", content: [] } }))).toBeNull();
    expect(codex("")).toBeNull();
    expect(codex("{bad")).toBeNull();
  });

  it("parses user / assistant messages", () => {
    const u = codex(
      cl({ type: "response_item", timestamp: TS, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hey" }] } }),
    );
    expect(u).toEqual({ role: "user", types: ["text"], text: "hey", ts: TS });
    const a = codex(
      cl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "yo" }] } }),
    );
    expect(a).toMatchObject({ role: "assistant", types: ["text"], text: "yo" });
  });

  it("represents input_image as [image]", () => {
    const r = codex(
      cl({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image" }, { type: "input_text", text: "see" }] } }),
    );
    expect(r).toMatchObject({ types: ["image", "text"], text: "[image]\nsee" });
  });

  it("parses reasoning (empty and with summary)", () => {
    expect(codex(cl({ type: "response_item", payload: { type: "reasoning", summary: [] } }))).toMatchObject({
      role: "assistant",
      types: ["thinking"],
      text: "",
    });
    expect(
      codex(cl({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] } })),
    ).toMatchObject({ types: ["thinking"], text: "plan" });
  });

  it("parses function_call / function_call_output", () => {
    expect(
      codex(cl({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}' } })),
    ).toMatchObject({ role: "assistant", types: ["tool_use:exec_command"], text: 'exec_command({"cmd":"ls"})' });
    expect(
      codex(cl({ type: "response_item", payload: { type: "function_call_output", output: "exit 0" } })),
    ).toMatchObject({ role: "user", types: ["tool_result"], text: "exit 0" });
  });

  it("parses custom_tool_call and web_search_call via the *_call rule", () => {
    expect(
      codex(cl({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "diff" } })),
    ).toMatchObject({ types: ["tool_use:apply_patch"], text: "apply_patch(diff)" });
    expect(
      codex(cl({ type: "response_item", payload: { type: "web_search_call", query: "foo" } })),
    ).toMatchObject({ types: ["tool_use:web_search_call"], text: "web_search_call(foo)" });
  });

  it("parses *_output variants as tool_result", () => {
    expect(
      codex(cl({ type: "response_item", payload: { type: "tool_search_output", output: "hit" } })),
    ).toMatchObject({ role: "user", types: ["tool_result"], text: "hit" });
  });

  it("keeps an unknown response_item kind as a placeholder row", () => {
    const r = codex(cl({ type: "response_item", payload: { type: "mystery_event" } }));
    expect(r).toMatchObject({ role: "assistant", types: ["mystery_event"], text: "" });
  });
});
