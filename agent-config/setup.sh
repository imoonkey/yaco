#!/bin/bash
set -euo pipefail

# Usage: ./setup.sh <project-path> <stack-name>
# Example: ./setup.sh ~/workspace/Investment kotlin-android
# Example: ./setup.sh ~/workspace/multmux typescript-node

if [ $# -lt 2 ]; then
  echo "Usage: $0 <project-path> <stack-name>"
  echo "Available stacks: kotlin-android, typescript-node"
  exit 1
fi

PROJECT="$(cd "$1" && pwd)"
STACK="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STACK_DIR="$SCRIPT_DIR/stacks/$STACK"

if [ ! -d "$STACK_DIR" ]; then
  echo "Error: stack '$STACK' not found at $STACK_DIR"
  echo "Available stacks:"
  ls "$SCRIPT_DIR/stacks/"
  exit 1
fi

echo "Setting up $PROJECT with stack: $STACK"
echo "Source: $SCRIPT_DIR"
echo ""

# --- 1. Create .claude/skills ---
mkdir -p "$PROJECT/.claude/skills"

# --- 2. Symlink stack-specific skills (e.g., coding-standards; skip existing) ---
echo "=== Stack skills ==="
for skill in "$STACK_DIR/skills"/*/; do
  [ -d "$skill" ] || continue
  skill_name=$(basename "$skill")
  target="$PROJECT/.claude/skills/$skill_name"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "  skip (exists): skills/$skill_name"
  else
    ln -s "$skill" "$target"
    echo "  linked: skills/$skill_name"
  fi
done

# --- 3. Global: ~/.claude/skills/ -> agent-config/global/skills/ ---
echo ""
echo "=== Global setup (one-time) ==="
GLOBAL_SKILLS="$HOME/.claude/skills"
if [ -L "$GLOBAL_SKILLS" ]; then
  echo "  ~/.claude/skills/ already symlinked -> $(readlink "$GLOBAL_SKILLS")"
elif [ -d "$GLOBAL_SKILLS" ]; then
  echo "  WARNING: ~/.claude/skills/ is a real directory"
  echo "  Back it up and replace with symlink:"
  echo "    mv ~/.claude/skills ~/.claude/skills.bak"
  echo "    ln -s $SCRIPT_DIR/global/skills ~/.claude/skills"
else
  ln -s "$SCRIPT_DIR/global/skills" "$GLOBAL_SKILLS"
  echo "  linked: ~/.claude/skills/ -> global/skills/"
fi

# --- 4. Global: ~/.claude/CLAUDE.md -> agent-config/global/CLAUDE.md ---
GLOBAL_CLAUDE="$HOME/.claude/CLAUDE.md"
if [ -L "$GLOBAL_CLAUDE" ]; then
  echo "  ~/.claude/CLAUDE.md already symlinked -> $(readlink "$GLOBAL_CLAUDE")"
elif [ -s "$GLOBAL_CLAUDE" ]; then
  echo "  WARNING: ~/.claude/CLAUDE.md exists and is non-empty"
  echo "  Back it up and replace:"
  echo "    mv ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak"
  echo "    ln -s $SCRIPT_DIR/global/CLAUDE.md ~/.claude/CLAUDE.md"
else
  rm -f "$GLOBAL_CLAUDE"  # remove empty file
  ln -s "$SCRIPT_DIR/global/CLAUDE.md" "$GLOBAL_CLAUDE"
  echo "  linked: ~/.claude/CLAUDE.md -> agent-config/global/CLAUDE.md"
fi

# --- 5. Global: ~/.codex/AGENTS.md -> agent-config/global/CLAUDE.md ---
mkdir -p "$HOME/.codex"
GLOBAL_CODEX="$HOME/.codex/AGENTS.md"
if [ -L "$GLOBAL_CODEX" ]; then
  echo "  ~/.codex/AGENTS.md already symlinked -> $(readlink "$GLOBAL_CODEX")"
elif [ -s "$GLOBAL_CODEX" ]; then
  echo "  WARNING: ~/.codex/AGENTS.md exists and is non-empty"
else
  rm -f "$GLOBAL_CODEX"
  ln -s "$SCRIPT_DIR/global/CLAUDE.md" "$GLOBAL_CODEX"
  echo "  linked: ~/.codex/AGENTS.md -> agent-config/global/CLAUDE.md"
fi

# --- 6. Global: ~/.agents/skills/ -> ~/.claude/skills/ (for Codex) ---
mkdir -p "$HOME/.agents"
GLOBAL_AGENTS_SKILLS="$HOME/.agents/skills"
if [ -L "$GLOBAL_AGENTS_SKILLS" ]; then
  echo "  ~/.agents/skills/ already symlinked -> $(readlink "$GLOBAL_AGENTS_SKILLS")"
elif [ ! -e "$GLOBAL_AGENTS_SKILLS" ]; then
  ln -s "$HOME/.claude/skills" "$GLOBAL_AGENTS_SKILLS"
  echo "  linked: ~/.agents/skills/ -> ~/.claude/skills/"
fi

# --- 7. Project: IDE compatibility symlinks ---
echo ""
echo "=== IDE compatibility ==="
cd "$PROJECT"

# .agents/ -> .claude/
if [ ! -e .agents ] && [ ! -L .agents ]; then
  ln -s .claude .agents
  echo "  linked: .agents/ -> .claude/"
else
  echo "  skip (exists): .agents/"
fi

# .codex/ -> .claude/
if [ ! -e .codex ] && [ ! -L .codex ]; then
  ln -s .claude .codex
  echo "  linked: .codex/ -> .claude/"
else
  echo "  skip (exists): .codex/"
fi

# --- 8. Project: AGENTS.md, GEMINI.md -> CLAUDE.md ---
if [ -f CLAUDE.md ] || [ -L CLAUDE.md ]; then
  if [ ! -e AGENTS.md ] && [ ! -L AGENTS.md ]; then
    ln -s CLAUDE.md AGENTS.md
    echo "  linked: AGENTS.md -> CLAUDE.md"
  else
    echo "  skip (exists): AGENTS.md"
  fi

  if [ ! -e GEMINI.md ] && [ ! -L GEMINI.md ]; then
    ln -s CLAUDE.md GEMINI.md
    echo "  linked: GEMINI.md -> CLAUDE.md"
  else
    echo "  skip (exists): GEMINI.md"
  fi
else
  echo "  NOTE: No CLAUDE.md found in project root. Create one with project-specific content."
fi

echo ""
echo "Done! Project '$PROJECT' configured with stack '$STACK'."
