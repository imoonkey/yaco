# Monitor (Removed)

The standalone Monitor view (`ui/src/components/Monitor.tsx`) was removed in the workspace consolidation (2026-03-31). Its three-column dashboard (Sessions, Notifications, Roadmap) is no longer rendered.

Session management now lives in the workspace sidebar and activity column. Notifications are surfaced through browser notifications and session unread pills. The Roadmap/workstream features are no longer exposed in the UI.

For current architecture, see [workspace/overview.md](workspace/overview.md) and [../frontend/components.md](../frontend/components.md).
