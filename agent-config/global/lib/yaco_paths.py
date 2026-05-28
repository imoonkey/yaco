"""Shared YACO path resolver.

Reads optional `<repo_root>/yaco.toml` and returns the canonical four
paths (tasks/active/archive/worktrees) with defaults applied. Missing
yaco.toml means "use defaults" — not "not a YACO project". Project
identity lives only in ~/.yaco/projects.json; this parser never reads or
requires [project] from yaco.toml.

All paths are repo-relative. Absolute paths are rejected.
"""

from __future__ import annotations

import os
import tomllib
from typing import TypedDict


class YacoPaths(TypedDict):
    tasks: str
    active: str
    archive: str
    worktrees: str


DEFAULTS: YacoPaths = {
    "tasks": "projects/tasks.json",
    "active": "projects/active",
    "archive": "projects/archive",
    "worktrees": ".worktrees",
}

_KEYS = ("tasks", "active", "archive", "worktrees")


def read_yaco_paths(repo_root: str) -> YacoPaths:
    config_path = os.path.join(repo_root, "yaco.toml")
    try:
        with open(config_path, "rb") as fh:
            data = tomllib.load(fh)
    except FileNotFoundError:
        return dict(DEFAULTS)  # type: ignore[return-value]

    paths = data.get("paths") or {}
    if not isinstance(paths, dict):
        raise ValueError("yaco.toml: [paths] must be a table")

    result: YacoPaths = dict(DEFAULTS)  # type: ignore[assignment]
    for key in _KEYS:
        if key not in paths:
            continue
        value = paths[key]
        if not isinstance(value, str):
            raise ValueError(f"yaco.toml: [paths].{key} must be a string")
        if os.path.isabs(value):
            raise ValueError(
                f"yaco.toml: [paths].{key} must be repo-relative, "
                f'got absolute path "{value}"'
            )
        if ".." in value.split(os.sep) or ".." in value.split("/"):
            raise ValueError(
                f"yaco.toml: [paths].{key} must be repo-relative, "
                f'got path with ".." segment "{value}"'
            )
        result[key] = value  # type: ignore[literal-required]

    return result
