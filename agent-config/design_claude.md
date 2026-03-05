# Agent Skills: Centralized AI Agent Skill Management

## Context

AI agent skills (in `.ai-dev/skills/`) are currently copy-pasted across 4+ projects (androidagent, Investment, multmux, web-skill). This creates maintenance overhead — updating a skill requires editing it in every project. The goal is a single source of truth with easy per-project setup via symlinks.

**Key finding from analysis:** Skills split naturally into 3 tiers:
- **Fully generic** (100% identical across projects): `ultra-think`, `strategic-compact`, `align`
- **Stack-parameterized** (same methodology, different build commands/language idioms): `verify`, `build-fix`, `tdd`, `plan`, `code-review`, `coding-standards`, `orchestrate`
- **Project-specific** (unique to one project): `cog-tune`, `ux-visual-debug`, `action-debug`, `update-docs`

Current tech stacks: **kotlin-android** (androidagent, Investment) and **typescript-node** (multmux, web-skill).

---

## Architecture: Central Repo + Stack Variants

### Directory Structure

```
~/workspace/agent-skills/                 # Git repo, single source of truth
  README.md
  setup.sh                                # Symlink installer

  global/                                 # Tier 1: identical everywhere
    ultra-think/SKILL.md
    strategic-compact/SKILL.md
    align/
      SKILL.md
      scripts/align_poll.sh

  stacks/                                 # Tier 2: per-tech-stack variants
    kotlin-android/
      verify/SKILL.md
      build-fix/SKILL.md
      tdd/SKILL.md
      plan/SKILL.md
      code-review/SKILL.md
      coding-standards/SKILL.md
      orchestrate/SKILL.md
    typescript-node/
      verify/SKILL.md
      build-fix/SKILL.md
      tdd/SKILL.md
      plan/SKILL.md
      code-review/SKILL.md
      coding-standards/SKILL.md
      orchestrate/SKILL.md

  agents/                                 # Shared agent definitions
    architect.md
    build-error-resolver.md
    code-reviewer.md
    code-simplifier.md
    planner.md
```

### How Projects Connect

```
# Global skills (available to ALL projects via ~/.claude/skills/)
~/.claude/skills/
  ultra-think/       -> ~/workspace/agent-skills/global/ultra-think
  strategic-compact/ -> ~/workspace/agent-skills/global/strategic-compact
  align/             -> ~/workspace/agent-skills/global/align
  continue/          (existing, stays as-is)
  last30days/        (existing, stays as-is)

# Per-project: stack skills are symlinked, project-specific skills stay local
~/workspace/Investment/.ai-dev/
  skills/
    verify/       -> ~/workspace/agent-skills/stacks/kotlin-android/verify
    build-fix/    -> ~/workspace/agent-skills/stacks/kotlin-android/build-fix
    ...           (other stack skills symlinked)
    cog-tune/     (local, project-specific)
    ux-visual-debug/ (local, project-specific)
    update-docs/  (local, project-specific doc-map)
  agents/
    architect.md  -> ~/workspace/agent-skills/agents/architect.md
    ...

# IDE compatibility symlinks (existing pattern, unchanged)
.claude/ -> .ai-dev/
.agent/  -> .ai-dev/
.codex/  -> .ai-dev/
```

### Why NOT templating?

The diffs between stacks aren't simple variable substitutions — `coding-standards` has entirely different code examples (Kotlin sealed classes vs TypeScript discriminated unions), `orchestrate` has different pipeline topologies. With only 2 stacks, maintaining separate variant files is simpler and more readable than a template engine.

---

## Skill Classification Detail

### Tier 1: Global (100% identical)

| Skill | Description |
|-------|-------------|
| `ultra-think` | Deep strategic thinking for high-impact decisions |
| `strategic-compact` | Context compaction at task boundaries |
| `align` | Design alignment between Codex and Claude (includes scripts/) |

### Tier 2: Stack-Parameterized

| Skill | Generic % | What differs |
|-------|-----------|-------------|
| `verify` | 95% | Build/lint/test commands, file extensions |
| `build-fix` | 80% | Error catalog (Gradle vs TypeScript), build commands |
| `tdd` | 80% | Test framework (JUnit vs Vitest), language idioms |
| `plan` | 90% | "Project-Specific Considerations" section, path examples |
| `code-review` | 85% | Tech-specific checklists (Android lifecycle vs Playwright/SSRF) |
| `coding-standards` | 40% | Language idioms, code examples (most divergent) |
| `orchestrate` | 75% | Pipeline topology (Android has visual-debug stage) |

### Tier 3: Project-Specific (stay local)

| Skill | Why local |
|-------|-----------|
| `cog-tune` | Android Agent cognition tuning, unique scripts |
| `ux-visual-debug` | ADB-based UX QA, Android-only |
| `action-debug` | Android Agent action layer debugging |
| `update-docs` | Doc-map table is 100% project-instance-specific |
| `autotune` | Eval-tune loop specific to Android Agent |

---

## Implementation Steps

### Phase 1: Create the central repo
1. Create `~/workspace/agent-skills/{global,stacks/kotlin-android,stacks/typescript-node,agents}`
2. `git init`, create GitHub private repo
3. Copy global skills from Investment `.ai-dev/skills/` -> `agent-skills/global/`
4. Copy kotlin-android variants from Investment `.ai-dev/skills/` -> `agent-skills/stacks/kotlin-android/`
5. Copy typescript-node variants from multmux `.claude/skills/` -> `agent-skills/stacks/typescript-node/`
6. Copy shared agent definitions from Investment `.ai-dev/agents/` -> `agent-skills/agents/`
7. Initial commit

### Phase 2: Write setup.sh
Create an installer script that:
- Takes `<project-path>` and `<stack-name>` as args
- Creates `.ai-dev/skills/` and `.ai-dev/agents/` if needed
- Symlinks stack skills (skipping existing local skills)
- Symlinks shared agents
- One-time: installs global skills into `~/.claude/skills/`
- Creates IDE compatibility symlinks (.claude, .agent, .codex -> .ai-dev)

### Phase 3: Wire up global skills
1. Symlink `agent-skills/global/*` -> `~/.claude/skills/`
2. Verify Claude Code sees them from any project

### Phase 4: Migrate Investment (kotlin-android)
1. Back up: `cp -a Investment/.ai-dev/skills Investment/.ai-dev/skills.bak`
2. Remove the 10 skills now centralized (3 global + 7 stack)
3. Run `setup.sh ~/workspace/Investment kotlin-android`
4. Leave project-specific skills in place (cog-tune, ux-visual-debug, update-docs, action-debug, autotune)
5. Verify all skills work

### Phase 5: Migrate multmux (typescript-node)
1. Standardize: if `.claude/` is the actual dir, rename to `.ai-dev/`, symlink `.claude -> .ai-dev`
2. Back up and remove centralized skills
3. Run `setup.sh ~/workspace/multmux typescript-node`
4. Verify

### Phase 6: Migrate remaining projects
- androidagent, web-skill — same pattern

---

## Maintenance Workflows

**Update a stack skill across all projects:**
```bash
vim ~/workspace/agent-skills/stacks/kotlin-android/verify/SKILL.md
cd ~/workspace/agent-skills && git commit -am "verify: add type-check phase"
# Done — symlinks propagate instantly
```

**Add a new tech stack:**
```bash
cp -r stacks/typescript-node stacks/python-fastapi
# Edit each SKILL.md to replace TS commands with Python equivalents
```

**Onboard a new project:**
```bash
./setup.sh ~/workspace/new-project typescript-node
# Add project-specific skills directly in new-project/.ai-dev/skills/
```

**Promote a project skill to shared:**
Move from project `.ai-dev/skills/X` -> `agent-skills/global/X` or `agent-skills/stacks/*/X`, replace with symlink.

---

## Verification
1. After each migration, run `/verify` (or any skill) in the project to confirm Claude Code resolves the symlinked skill
2. Check double symlink resolution: `.claude/ -> .ai-dev/skills/verify -> agent-skills/stacks/.../verify`
3. Verify `~/.claude/skills/` global skills appear in all projects
4. Test `setup.sh` on a fresh directory to confirm new-project onboarding works

## Key Source Files
- Kotlin-android skills: `/Users/moonkey/workspace/Investment/.ai-dev/skills/`
- Typescript-node skills: `/Users/moonkey/workspace/multmux/.claude/skills/`
- Shared agents: `/Users/moonkey/workspace/Investment/.ai-dev/agents/`
- Global Claude config: `/Users/moonkey/.claude/settings.json`
