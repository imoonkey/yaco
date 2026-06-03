"""Shared YACO runtime-root resolver.

The YACO runtime root consolidates what used to live at ``~/.workflow`` and
``~/.multmux``. Vendor roots such as ``~/.claude`` and ``~/.codex`` stay
untouched. See ``projects/active/yaco-core/final/design.md`` (Canonical Path
Layout) for the full layout.

Resolution order:

1. ``$YACO_HOME`` (honored verbatim — absolute path expected)
2. ``~/.yaco``
"""

from __future__ import annotations

import os


def get_yaco_home() -> str:
    """Return the YACO runtime root path."""
    env = os.environ.get("YACO_HOME")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".yaco")


def projects_file() -> str:
    """``${YACO_HOME}/projects.json`` — workflow project registry."""
    return os.path.join(get_yaco_home(), "projects.json")


def ui_state_dir() -> str:
    """``${YACO_HOME}/ui-state`` — notifications, pinned sessions, watermarks."""
    return os.path.join(get_yaco_home(), "ui-state")


def shell_sessions_dir() -> str:
    """``${YACO_HOME}/shell-sessions`` — workflow-managed tmux shell records."""
    return os.path.join(get_yaco_home(), "shell-sessions")


def channels_dir() -> str:
    """``${YACO_HOME}/channels`` — messaging channel state root."""
    return os.path.join(get_yaco_home(), "channels")


def channel_scope_dir(scope: str) -> str:
    """``${YACO_HOME}/channels/<scope>`` — per-channel state directory."""
    return os.path.join(channels_dir(), scope)


def sessions_dir() -> str:
    """``${YACO_HOME}/sessions`` — multmux agent session-state directory.

    NOTE: No call site uses this helper yet. The yc-multmux-state-root
    follow-up task flips the multmux/workflow imports from the legacy
    ``~/.multmux/sessions`` default to this resolver. Exposing it here keeps
    Python tooling symmetric with the TypeScript ``sessionsDir()`` helper.
    """
    return os.path.join(get_yaco_home(), "sessions")


def project_events_file(project_id: str) -> str:
    """``${YACO_HOME}/projects/<id>/events.jsonl`` — append-only event stream."""
    return os.path.join(get_yaco_home(), "projects", project_id, "events.jsonl")
