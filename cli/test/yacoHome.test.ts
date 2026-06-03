import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { homedir } from "os";

const ORIGINAL_YACO_HOME = process.env.YACO_HOME;

// Bun caches modules by URL; bun:test exposes no equivalent of
// vi.resetModules(), but the yacoHome helpers all read process.env at call
// time (not at import time), so a single import suffices.
import {
  getYacoHome,
  hookV2ScriptPath,
  wrapperV2ScriptPath,
  sessionsDir,
} from "../src/yacoHome.ts";

function restoreEnv() {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME;
  else process.env.YACO_HOME = ORIGINAL_YACO_HOME;
}

describe("getYacoHome", () => {
  beforeEach(() => { delete process.env.YACO_HOME; });
  afterEach(restoreEnv);

  it("defaults to ~/.yaco when YACO_HOME is unset", () => {
    expect(getYacoHome()).toBe(join(homedir(), ".yaco"));
  });

  it("honors YACO_HOME verbatim when set", () => {
    process.env.YACO_HOME = "/tmp/yaco-multmux-fixture";
    expect(getYacoHome()).toBe("/tmp/yaco-multmux-fixture");
  });

  it("treats empty YACO_HOME as unset (falls back to default)", () => {
    process.env.YACO_HOME = "";
    expect(getYacoHome()).toBe(join(homedir(), ".yaco"));
  });
});

describe("multmux YACO path helpers under a YACO_HOME fixture", () => {
  const FIXTURE = "/tmp/yaco-multmux-fixture";

  beforeEach(() => { process.env.YACO_HOME = FIXTURE; });
  afterEach(restoreEnv);

  it("hookV2ScriptPath resolves under YACO_HOME", () => {
    expect(hookV2ScriptPath()).toBe(`${FIXTURE}/hook-v2.sh`);
  });

  it("wrapperV2ScriptPath resolves under YACO_HOME", () => {
    expect(wrapperV2ScriptPath()).toBe(`${FIXTURE}/wrapper-v2.sh`);
  });

  it("sessionsDir resolves under YACO_HOME", () => {
    // yc-multmux-state-root will flip state.ts SESSIONS_DIR to use this.
    expect(sessionsDir()).toBe(`${FIXTURE}/sessions`);
  });
});
