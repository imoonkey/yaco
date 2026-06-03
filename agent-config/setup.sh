#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Component entry point. The monorepo root installer owns global config links,
# multmux installation, hook installation, and registry updates.
exec "$ROOT_DIR/tools/install.sh" --cli-only "$@"
