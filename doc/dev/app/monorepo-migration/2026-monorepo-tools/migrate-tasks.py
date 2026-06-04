#!/usr/bin/env python3
"""One-time migration for component YACO task graphs.

This script imports active tasks from the component repos into the root
projects/tasks.json and archives terminal component task history. It is a
temporary operator script for the 2026 monorepo migration, not product code.
"""

from __future__ import annotations

import argparse
import json
import shutil
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TERMINAL = {"done", "cancelled"}
NON_TERMINAL = {"ready", "running", "blocked"}


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def prefixed_scope(repo_dir: str, scope: Any) -> Any:
    if not isinstance(scope, list):
        return scope
    result = []
    for item in scope:
        if not isinstance(item, str):
            result.append(item)
            continue
        if item.startswith((f"{repo_dir}/", "~/", "/", "../")):
            result.append(item)
        else:
            result.append(f"{repo_dir}/{item}")
    return result


def rewrite_design(prefix: str, design: Any) -> Any:
    if not isinstance(design, str):
        return design
    marker = "projects/active/"
    if not design.startswith(marker):
        return design
    rest = design[len(marker) :]
    bundle, sep, tail = rest.partition("/")
    if not sep:
        return f"projects/active/{prefix}{bundle}"
    return f"projects/active/{prefix}{bundle}/{tail}"


def split_tasks(tasks: dict[str, Any]) -> tuple[set[str], set[str]]:
    active = {task_id for task_id, task in tasks.items() if task.get("state") not in TERMINAL}
    terminal = set(tasks) - active
    return active, terminal


def import_active_tasks(
    *,
    root_tasks: dict[str, Any],
    component_tasks: dict[str, Any],
    prefix: str,
    repo_dir: str,
    imported_at: str,
) -> None:
    active_ids, terminal_ids = split_tasks(component_tasks)

    for task_id in component_tasks:
        new_id = f"{prefix}{task_id}"
        if new_id in root_tasks:
            raise SystemExit(f"refusing to overwrite existing task {new_id}")

    for task_id in sorted(active_ids):
        original = component_tasks[task_id]
        migrated = deepcopy(original)

        parent = migrated.get("parent")
        migrated["parent"] = f"{prefix}{parent}" if parent in active_ids else None

        depends = []
        omitted = []
        for dep in migrated.get("depends", []):
            if dep in active_ids:
                depends.append(f"{prefix}{dep}")
            elif dep in terminal_ids:
                omitted.append(dep)
            else:
                raise SystemExit(f"{task_id} has unknown dependency {dep}")
        migrated["depends"] = depends

        if "design" in migrated:
            migrated["design"] = rewrite_design(prefix, migrated["design"])
        if "scope" in migrated:
            migrated["scope"] = prefixed_scope(repo_dir, migrated["scope"])

        tags = list(migrated.get("tags", []))
        for tag in ("imported", repo_dir):
            if tag not in tags:
                tags.append(tag)
        migrated["tags"] = tags

        note = migrated.get("note")
        import_note = f"Imported from {repo_dir}:{task_id} on {imported_at}."
        if omitted:
            import_note += f" Terminal dependencies already satisfied and archived: {', '.join(omitted)}."
        migrated["note"] = f"{note}\n{import_note}" if note else import_note
        migrated["updated"] = imported_at

        root_tasks[f"{prefix}{task_id}"] = migrated


def archive_component(
    *,
    repo_root: Path,
    component: str,
    component_tasks: dict[str, Any],
    imported_at: str,
) -> None:
    date = imported_at[:10].replace("-", "")
    archive_dir = repo_root / "projects" / "archive" / f"{date}_imported-{component}"
    if archive_dir.exists():
        raise SystemExit(f"archive already exists: {archive_dir}")

    active_ids, terminal_ids = split_tasks(component_tasks)
    archive = {
        "source": component,
        "importedAt": imported_at,
        "terminalTasks": {task_id: component_tasks[task_id] for task_id in sorted(terminal_ids)},
        "activeTasksImportedToRoot": sorted(f"{component_prefix(component)}{task_id}" for task_id in active_ids),
    }
    write_json(archive_dir / "tasks.json", archive)

    source_projects = repo_root / component / "projects"
    if (source_projects / "active").exists():
        shutil.copytree(source_projects / "active", archive_dir / "active")
    if (source_projects / "archive").exists():
        shutil.copytree(source_projects / "archive", archive_dir / "archive")


def component_prefix(component: str) -> str:
    if component == "multmux":
        return "mm-"
    if component == "agent-config":
        return "ac-"
    raise ValueError(component)


def copy_active_bundles(repo_root: Path, component: str, component_tasks: dict[str, Any]) -> None:
    active_ids, _ = split_tasks(component_tasks)
    source_active = repo_root / component / "projects" / "active"
    if not source_active.exists():
        return

    for task_id in sorted(active_ids):
        task = component_tasks[task_id]
        design = task.get("design")
        if not isinstance(design, str) or not design.startswith("projects/active/"):
            continue
        bundle = design.removeprefix("projects/active/").split("/", 1)[0]
        src = source_active / bundle
        if not src.exists():
            continue
        dst = repo_root / "projects" / "active" / f"{component_prefix(component)}{bundle}"
        if dst.exists():
            raise SystemExit(f"active bundle already exists: {dst}")
        shutil.copytree(src, dst)


def validate_graph(tasks: dict[str, Any]) -> None:
    for task_id, task in tasks.items():
        parent = task.get("parent")
        if parent is not None and parent not in tasks:
            raise SystemExit(f"{task_id} has missing parent {parent}")
        for dep in task.get("depends", []):
            if dep not in tasks:
                raise SystemExit(f"{task_id} has missing dependency {dep}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str) -> None:
        if task_id in visited:
            return
        if task_id in visiting:
            raise SystemExit(f"cycle detected at {task_id}")
        visiting.add(task_id)
        task = tasks[task_id]
        edges = list(task.get("depends", []))
        parent = task.get("parent")
        if parent is not None:
            edges.append(parent)
        for edge in edges:
            visit(edge)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks:
        visit(task_id)


def migrate(repo_root: Path) -> None:
    imported_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    root_tasks_path = repo_root / "projects" / "tasks.json"
    root_tasks = read_json(root_tasks_path)

    components = [
        ("multmux", "mm-"),
        ("agent-config", "ac-"),
    ]

    loaded: dict[str, dict[str, Any]] = {}
    for component, _prefix in components:
        tasks_path = repo_root / component / "projects" / "tasks.json"
        if not tasks_path.exists():
            raise SystemExit(f"missing component task graph: {tasks_path}")
        loaded[component] = read_json(tasks_path)

    for component, prefix in components:
        import_active_tasks(
            root_tasks=root_tasks,
            component_tasks=loaded[component],
            prefix=prefix,
            repo_dir=component,
            imported_at=imported_at,
        )

    validate_graph(root_tasks)

    for component, _prefix in components:
        archive_component(
            repo_root=repo_root,
            component=component,
            component_tasks=loaded[component],
            imported_at=imported_at,
        )
        copy_active_bundles(repo_root, component, loaded[component])

    write_json(root_tasks_path, root_tasks)

    for component, _prefix in components:
        (repo_root / component / "projects" / "tasks.json").unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description="Import component task graphs into root projects/tasks.json")
    parser.add_argument(
        "--repo-root",
        type=Path,
        # Archived under doc/dev/app/monorepo-migration/2026-monorepo-tools/.
        default=Path(__file__).resolve().parents[5],
        help="Monorepo root. Defaults to this script's repository root.",
    )
    args = parser.parse_args()
    migrate(args.repo_root.resolve())


if __name__ == "__main__":
    main()
