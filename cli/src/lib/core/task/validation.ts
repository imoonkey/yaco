/** Type/shape validation for an incoming `set` payload.
 *
 *  Mirrors update-tasks.py's validate_types — the error messages are kept
 *  close so users porting workflows recognise the same diagnostics. Each
 *  check throws CliError(INVALID, ...) on first failure; the caller is
 *  responsible for wrapping the validate call before mutating disk state.
 *
 *  Anything not listed (free-form `note`, `design`, `verification`, ...)
 *  passes through untouched.
 */

import { CliError, ErrCode } from "../errors.ts";
import {
  AGENT_HANDLE_RE,
  BLOCK_REASONS,
  ESTIMATES,
  PRIORITIES,
  SLUG_RE,
  WORKSETS,
} from "./model.ts";

type Json =
  | string
  | number
  | boolean
  | null
  | { [k: string]: Json }
  | Json[];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function invalid(msg: string): never {
  throw new CliError(ErrCode.INVALID, msg);
}

/** Validate the shape of an incoming `set` payload. Errors mirror the
 *  Python diagnostics so existing skills keep their muscle memory. */
export function validateTypes(data: Record<string, unknown>): void {
  if ("parent" in data) {
    const v = data["parent"];
    if (!(typeof v === "string" || v === null)) invalid("'parent' must be str/NoneType");
  }
  if ("depends" in data) {
    if (!Array.isArray(data["depends"])) invalid("'depends' must be list");
  }
  if ("state" in data) {
    if (typeof data["state"] !== "string") invalid("'state' must be str");
  }
  if ("workset" in data) {
    if (!(WORKSETS as readonly string[]).includes(data["workset"] as string)) {
      invalid(`workset must be one of: ${[...WORKSETS].sort().join(", ")}`);
    }
  }
  if ("scope" in data) {
    if (!Array.isArray(data["scope"])) invalid("'scope' must be list");
  }
  if ("requireHumanReview" in data) {
    if (typeof data["requireHumanReview"] !== "boolean") {
      invalid("'requireHumanReview' must be bool");
    }
  }

  if (data["acceptCriteria"] !== undefined && data["acceptCriteria"] !== null) {
    const ac = data["acceptCriteria"];
    if (typeof ac === "string") {
      // ok
    } else if (Array.isArray(ac)) {
      if (!ac.every((x) => typeof x === "string")) {
        invalid("acceptCriteria list items must be strings");
      }
    } else {
      invalid("acceptCriteria must be str or list[str]");
    }
  }

  if (data["resources"] !== undefined && data["resources"] !== null) {
    const res = data["resources"];
    if (typeof res === "string") {
      // ok
    } else if (Array.isArray(res)) {
      if (!res.every((x) => typeof x === "string")) {
        invalid("resources list items must be strings");
      }
    } else {
      invalid("resources must be str or list[str]");
    }
  }

  if ("priority" in data) {
    if (!(PRIORITIES as readonly string[]).includes(data["priority"] as string)) {
      invalid(`priority must be one of: ${[...PRIORITIES].sort().join(", ")}`);
    }
  }

  if ("agent" in data) {
    invalid("agent is no longer supported; use agents (list of session handles)");
  }

  if ("agents" in data) {
    const agents = data["agents"];
    if (!isStringList(agents)) invalid("agents must be a list of strings");
    for (const handle of agents) {
      if (handle.trim() === "") invalid("agents must not contain empty handles");
      if (!AGENT_HANDLE_RE.test(handle)) {
        invalid("agents handles must match /^[a-zA-Z0-9_-]+$/");
      }
    }
  }

  if ("tags" in data) {
    const tags = data["tags"];
    if (!isStringList(tags)) invalid("tags must be list of strings");
    if (tags.some((x) => x.trim() === "")) {
      invalid("tags must not contain empty or whitespace-only strings");
    }
  }

  if ("estimate" in data) {
    if (!(ESTIMATES as readonly string[]).includes(data["estimate"] as string)) {
      invalid(`estimate must be one of: ${[...ESTIMATES].sort().join(", ")}`);
    }
  }

  // `null` clears the field, the same explicit-clear spelling `worktree` uses;
  // absent means "leave it alone". `""` stays rejected — one clear sentinel.
  if ("blockReason" in data) {
    const reason = data["blockReason"];
    if (reason !== null && !(BLOCK_REASONS as readonly string[]).includes(reason as string)) {
      invalid(
        `blockReason must be one of: ${[...BLOCK_REASONS].sort().join(", ")} (or null to clear)`,
      );
    }
  }

  if ("worktree" in data) {
    const wt = data["worktree"];
    if (wt !== null) {
      if (typeof wt !== "string") invalid("worktree must be a string");
      if (!SLUG_RE.test(wt)) {
        invalid(
          "worktree must be a valid slug (lowercase alphanumeric and hyphens, no leading/trailing hyphens)",
        );
      }
    }
  }
}

/** True if acceptCriteria is missing, empty string, or list of blank strings. */
export function isAcceptCriteriaBlank(ac: unknown): boolean {
  if (ac === undefined || ac === null) return true;
  if (typeof ac === "string") return ac.trim() === "";
  if (Array.isArray(ac)) {
    if (ac.length === 0) return true;
    return ac.every((x) => typeof x !== "string" || x.trim() === "");
  }
  return true;
}

export { isObject };
export type { Json };
