---
name: coding-standards
description: Coding conventions and patterns. Auto-applied as reference during code changes. Detects the project stack and loads stack-specific idioms.
---

# Coding Standards

## Refactor thresholds

| Smell | Threshold | Fix |
|-------|-----------|-----|
| Large file | >400 lines | Extract class/module/functions |
| Deep nesting | >4 levels | Early returns, extract |
| Long function | >50 lines | Break into smaller |
| God class | Does everything | Single responsibility |
| Magic numbers | Unexplained | Named constants |

## Stack-Specific Standards

Detect the project stack from its marker file and read the matching reference for house-style idioms:

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |
| `package.json` | TypeScript/Node | `references/typescript-node.md` |
