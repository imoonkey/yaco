# 2026 Monorepo Migration Tools

This directory archives the one-time operator scripts used by the YACO monorepo
migration. They are kept for auditability and rollback context, not as active
product tooling.

Archived scripts:

- `import-multmux.sh`
- `import-agent-config.sh`
- `migrate-tasks.py`
- `cutover-registry.sh` was folded into `tools/install.sh` registry handling
  instead of being kept as a standalone script.
