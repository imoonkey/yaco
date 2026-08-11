/** `YACO_TASK_LOCK_TIMEOUT_MS` at the command edge.
 *
 *  The override used to live inside `core/task/lock.ts`, which is an exported
 *  closure — a fourth ambient environment name below the export seam, and a
 *  failure of the audit in `test/unit/export-audit.test.ts`. It now reads here
 *  and is passed down as an explicit `AcquireOptions.timeoutMs`.
 */

import { afterEach, describe, it, expect } from "vitest";

import { taskLockTimeoutMs } from "../../../../src/commands/task/lock-timeout.ts";

const ENV = "YACO_TASK_LOCK_TIMEOUT_MS";

afterEach(() => {
  delete process.env[ENV];
});

describe("taskLockTimeoutMs", () => {
  it("is undefined when unset, so the default stands", () => {
    delete process.env[ENV];
    expect(taskLockTimeoutMs()).toBeUndefined();
  });

  it("returns a positive numeric override", () => {
    process.env[ENV] = "200";
    expect(taskLockTimeoutMs()).toBe(200);
  });

  it("ignores empty, non-numeric and non-positive values rather than failing", () => {
    for (const raw of ["", "soon", "0", "-1", "NaN"]) {
      process.env[ENV] = raw;
      expect(taskLockTimeoutMs(), raw).toBeUndefined();
    }
  });
});
