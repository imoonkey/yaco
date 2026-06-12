# Monitor (Removed)

The standalone Monitor view (`ui/src/components/Monitor.tsx`) was removed in the workspace consolidation (2026-03-31). Its three-column dashboard (Sessions, Notifications, Roadmap) is no longer rendered.

Session management now lives in the workspace sidebar and activity column. Attention is surfaced through the notification bell (server-projected feed), browser notifications, status dots, and per-session badges/"↩ your turn" chips — see [notifications.md](notifications.md). The Roadmap/workstream features are no longer exposed in the UI.

For current architecture, see [workspace/overview.md](workspace/overview.md) and [../frontend/components.md](../frontend/components.md).
