/** Is this Node older than the version `@yaco/cli` requires?
 *
 *  A separate file from the launcher for one reason: the launcher runs the CLI
 *  the moment it is loaded, so it cannot be imported to be tested, and a
 *  version guard that is never exercised against the versions it is supposed to
 *  reject is decoration. Nothing here may use syntax newer than the oldest Node
 *  it has to give a useful error to.
 */
export const MINIMUM_NODE = "24.15.0";

/** Semver ordering, only as much of it as a floor check needs.
 *
 *  The prerelease clause is the part that is easy to get wrong: `24.15.0-rc.1`
 *  splits into a patch component of `NaN`, every comparison against `NaN` is
 *  false, and a naive loop concludes the release candidate satisfies a floor
 *  that its own final release defines. Semver says a prerelease precedes the
 *  version it is a candidate for, so an equal numeric core with a prerelease tag
 *  is below the floor — while `24.16.0-nightly` is above it, decided by the core
 *  before the tag is ever consulted.
 */
export function belowNodeFloor(version, floor = MINIMUM_NODE) {
  const [core, prerelease] = version.split("-");
  const found = core.split(".").map(Number);
  const required = floor.split(".").map(Number);
  for (let i = 0; i < required.length; i++) {
    if (found[i] !== required[i]) return found[i] < required[i];
  }
  return prerelease !== undefined;
}
