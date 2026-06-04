/** Tests for the runtime-root resolver and its helpers.
 *
 *  Each test scopes its YACO_HOME mutation in beforeEach/afterEach so the
 *  default-fallback test cannot bleed YACO_HOME from earlier tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  agentWrapperPath,
  channelScopeDir,
  channelsDir,
  getYacoHome,
  projectEventsFile,
  projectsFile,
  sessionsDir,
  shellSessionsDir,
  uiStateDir,
} from "../../../../src/lib/core/paths/yaco-home.ts";

const ORIGINAL = process.env["YACO_HOME"];

describe("getYacoHome", () => {
  beforeEach(() => {
    delete process.env["YACO_HOME"];
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["YACO_HOME"];
    else process.env["YACO_HOME"] = ORIGINAL;
  });

  it("defaults to ~/.yaco when YACO_HOME is unset", () => {
    expect(getYacoHome()).toBe(join(homedir(), ".yaco"));
  });

  it("honors YACO_HOME verbatim when set", () => {
    process.env["YACO_HOME"] = "/tmp/yaco-fixture-root";
    expect(getYacoHome()).toBe("/tmp/yaco-fixture-root");
  });

  it("treats empty YACO_HOME as unset (falls back to default)", () => {
    process.env["YACO_HOME"] = "";
    expect(getYacoHome()).toBe(join(homedir(), ".yaco"));
  });
});

describe("path helpers under a YACO_HOME fixture", () => {
  const FIXTURE = "/tmp/yaco-fixture-root";

  beforeEach(() => {
    process.env["YACO_HOME"] = FIXTURE;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["YACO_HOME"];
    else process.env["YACO_HOME"] = ORIGINAL;
  });

  it("projectsFile resolves under YACO_HOME", () => {
    expect(projectsFile()).toBe(`${FIXTURE}/projects.json`);
  });

  it("sessionsDir resolves under YACO_HOME", () => {
    expect(sessionsDir()).toBe(`${FIXTURE}/sessions`);
  });

  it("uiStateDir resolves under YACO_HOME", () => {
    expect(uiStateDir()).toBe(`${FIXTURE}/ui-state`);
  });

  it("shellSessionsDir resolves under YACO_HOME", () => {
    expect(shellSessionsDir()).toBe(`${FIXTURE}/shell-sessions`);
  });

  it("channelsDir resolves under YACO_HOME", () => {
    expect(channelsDir()).toBe(`${FIXTURE}/channels`);
  });

  it("channelScopeDir nests scope under channels/", () => {
    expect(channelScopeDir("whatsapp")).toBe(`${FIXTURE}/channels/whatsapp`);
    expect(channelScopeDir("wechat")).toBe(`${FIXTURE}/channels/wechat`);
  });

  it("projectEventsFile resolves to projects/<id>/events.jsonl", () => {
    expect(projectEventsFile("workflow")).toBe(
      `${FIXTURE}/projects/workflow/events.jsonl`,
    );
  });

  it("agentWrapperPath resolves to the managed wrapper script", () => {
    expect(agentWrapperPath()).toBe(`${FIXTURE}/agent-wrapper.sh`);
  });
});
