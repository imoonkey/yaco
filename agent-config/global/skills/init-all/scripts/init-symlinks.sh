#!/bin/bash
set -euo pipefail

# Create multi-tool compatibility symlinks in the current project.
# Run from project root. Idempotent — safe to run multiple times.

echo "=== Multi-tool symlinks ==="

# --- .claude/skills/ ---
mkdir -p .claude/skills

# --- .agents/ -> .claude/ (Codex project skills) ---
if [ ! -e .agents ] && [ ! -L .agents ]; then
  ln -s .claude .agents
  echo "  linked: .agents/ -> .claude/"
else
  echo "  skip (exists): .agents/"
fi

# --- .codex/ -> .claude/ (Codex alt path) ---
if [ ! -e .codex ] && [ ! -L .codex ]; then
  ln -s .claude .codex
  echo "  linked: .codex/ -> .claude/"
else
  echo "  skip (exists): .codex/"
fi

# --- AGENTS.md -> CLAUDE.md ---
if [ -f CLAUDE.md ] || [ -L CLAUDE.md ]; then
  if [ ! -e AGENTS.md ] && [ ! -L AGENTS.md ]; then
    ln -s CLAUDE.md AGENTS.md
    echo "  linked: AGENTS.md -> CLAUDE.md"
  else
    echo "  skip (exists): AGENTS.md"
  fi
else
  echo "  WARNING: No CLAUDE.md found — create it first"
fi

# --- GEMINI.md -> CLAUDE.md ---
if [ -f CLAUDE.md ] || [ -L CLAUDE.md ]; then
  if [ ! -e GEMINI.md ] && [ ! -L GEMINI.md ]; then
    ln -s CLAUDE.md GEMINI.md
    echo "  linked: GEMINI.md -> CLAUDE.md"
  else
    echo "  skip (exists): GEMINI.md"
  fi
fi

echo "Done."
