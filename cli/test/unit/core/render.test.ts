/** Unit tests for the `dual` text/JSON output convention.
 *
 *  `dual` is the single branch ordinary result-bearing commands take: the
 *  structured record in `--json` mode, the rendered string wrapped in `{text}`
 *  otherwise. The render callback must never run on the JSON path.
 */

import { describe, it, expect } from "vitest";
import { dual } from "../../../src/lib/core/render.ts";
import { isOk } from "../../../src/lib/core/result.ts";

describe("dual", () => {
  it("returns the structured data verbatim in JSON mode", () => {
    const data = { a: 1, b: "two" };
    const r = dual(true, data, () => "should-not-run");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(data);
  });

  it("wraps the rendered string in a `{text}` envelope in text mode", () => {
    const r = dual(false, { ignored: true }, () => "line one\nline two\n");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual({ text: "line one\nline two\n" });
  });

  it("does not invoke the render callback on the JSON path", () => {
    let calls = 0;
    dual(true, { x: 1 }, () => {
      calls++;
      return "";
    });
    expect(calls).toBe(0);
  });
});
