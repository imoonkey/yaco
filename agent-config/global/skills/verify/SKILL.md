---
name: verify
description: Run verification loop (build, lint, test, security) before commits. Use before any commit or PR, or after significant changes. Detects project stack automatically.
---

# Verify

Build, lint, unit tests, secret scan — the machine-checkable gate before a commit. User flows → `/qa`.

**Verification costs what the change can break, not what the repo contains.** While iterating, run what the diff reaches: build/typecheck of the touched components, lint on the changed files, the tests that exercise them. Run everything once — before the work is called done or a PR opens — and whenever the change has no narrow blast radius (shared config, build tooling, a module most of the repo imports).

"Everything" is the repo's **`scripts/verify.sh`** when it has one: the source of truth `yaco gate` and hooks also run, stopping at the first failing step and naming it. Without one, run all four checks per the stack reference (and consider adding the script):

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |
| `package.json` | TypeScript/Node | `references/typescript-node.md` |

Lint errors block; warnings don't. Report each check's result and whether the tree is ready to commit.
