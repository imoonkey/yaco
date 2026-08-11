/** Public surface for @yaco/cli/core/worktree — pure path and slug helpers.
 *
 *  Only the naming convention is shared. Everything that *does* something to a
 *  worktree — git plumbing, create, merge, cleanup, PR — spawns git or gh
 *  synchronously and reads `process.cwd()`, so it fails the export eligibility
 *  rules and stays behind the CLI subprocess boundary. Those callers live in
 *  cli/src/commands/worktree and import their module directly.
 */

export { validateSlug } from "./slug.ts";
export { worktreePath, worktreeBranch } from "./convention.ts";
