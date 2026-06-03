---
name: coding-standards
description: Coding conventions and patterns. Auto-applied as reference during code changes. Detects the project stack and loads stack-specific idioms.
---

# Coding Standards

## Core Principles

1. **Readability First** — clear > clever
2. **KISS** — simplest solution that works
3. **DRY** — extract common logic
4. **YAGNI** — don't build unneeded features

## Code Smells

| Smell | Threshold | Fix |
|-------|-----------|-----|
| Large file | >400 lines | Extract class/module/functions |
| Deep nesting | >4 levels | Early returns, extract |
| Long function | >50 lines | Break into smaller |
| God class | Does everything | Single responsibility |
| Magic numbers | Unexplained | Named constants |

## Error Handling

- Explicit error handling, no silent failures
- Use specific exception/error types, not generic catches
- Never swallow errors: `catch (e) { }` is always wrong

## Stack-Specific Standards

Detect the project stack and read the matching reference:

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |
| `package.json` | TypeScript/Node | `references/typescript-node.md` |

Read the reference file from this skill's directory for language-specific idioms and patterns.
