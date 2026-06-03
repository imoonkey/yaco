#!/bin/bash
set -euo pipefail

# Global one-time setup for agent-config symlinks.
# Project-level setup is handled by /init-all skill.
#
# Usage: ./setup.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Global setup (one-time) ==="
echo "Source: $SCRIPT_DIR"
echo ""

# --- 1. Global: ~/.claude/skills/ -> agent-config/global/skills/ ---
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

# --- 2. Global: ~/.claude/CLAUDE.md -> agent-config/global/CLAUDE.md ---
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

# --- 3. Global: ~/.codex/AGENTS.md -> agent-config/global/CLAUDE.md ---
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

# --- 4. Global: ~/.agents/skills/ -> ~/.claude/skills/ (for Codex) ---
mkdir -p "$HOME/.agents"
GLOBAL_AGENTS_SKILLS="$HOME/.agents/skills"
if [ -L "$GLOBAL_AGENTS_SKILLS" ]; then
  echo "  ~/.agents/skills/ already symlinked -> $(readlink "$GLOBAL_AGENTS_SKILLS")"
elif [ ! -e "$GLOBAL_AGENTS_SKILLS" ]; then
  ln -s "$HOME/.claude/skills" "$GLOBAL_AGENTS_SKILLS"
  echo "  linked: ~/.agents/skills/ -> ~/.claude/skills/"
fi

echo ""
echo "Done! Global config linked."
echo "For per-project setup, use /init-all in the project directory."
