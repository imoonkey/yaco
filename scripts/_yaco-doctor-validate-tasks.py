#!/usr/bin/env python3
"""Validate a projects/tasks.json file (read-only).

Mirrors scripts/update-tasks.py validation logic but does NOT mutate state.

Exit 0 with "ok" on stdout when valid; exit 1 with "ERR: <reason>" on stderr.
Usage: _yaco-doctor-validate-tasks.py <path-to-tasks.json>
"""
import json
import sys
from pathlib import Path

STATES = {"ready", "running", "done", "blocked", "cancelled"}
TERMINAL = {"done", "cancelled"}

def die(msg: str) -> None:
    print(f"ERR: {msg}", file=sys.stderr)
    sys.exit(1)

def main() -> None:
    if len(sys.argv) != 2:
        die("usage: _yaco-doctor-validate-tasks.py <tasks.json>")
    p = Path(sys.argv[1])
    if not p.exists():
        print("ok (no tasks.json)")
        return
    try:
        tasks = json.loads(p.read_text())
    except Exception as e:
        die(f"parse failed: {e}")
    if not isinstance(tasks, dict):
        die("tasks.json root must be object keyed by slug")

    children: dict[str, list[str]] = {tid: [] for tid in tasks}
    for tid, t in tasks.items():
        if not isinstance(t, dict):
            die(f"{tid}: task value must be object")
        pid = t.get("parent")
        if pid is not None:
            if pid not in tasks:
                die(f"{tid}: parent '{pid}' not found")
            if pid == tid:
                die(f"{tid}: self-parent")
            children[pid].append(tid)
        for d in t.get("depends", []) or []:
            if d not in tasks:
                die(f"{tid}: depends '{d}' not found")
            if d == tid:
                die(f"{tid}: self-depends")
        state = t.get("state")
        if state not in STATES:
            die(f"{tid}: invalid state '{state}'")

    for tid in tasks:
        seen: set[str] = set()
        cur: str | None = tid
        while cur:
            if cur in seen:
                die(f"cycle in parent chain at {cur}")
            seen.add(cur)
            cur = tasks[cur].get("parent")

    GRAY, BLACK = 1, 2
    color: dict[str, int] = {}

    def dfs(t: str, stack: list[str]) -> None:
        color[t] = GRAY
        for d in tasks[t].get("depends", []) or []:
            if color.get(d) == GRAY:
                die("cycle in depends: " + " -> ".join(stack + [d]))
            if d not in color:
                dfs(d, stack + [d])
        color[t] = BLACK

    for tid in tasks:
        if tid not in color:
            dfs(tid, [tid])

    def ac_blank(ac) -> bool:
        if ac is None:
            return True
        if isinstance(ac, str):
            return not ac.strip()
        if isinstance(ac, list):
            return len(ac) == 0 or all(
                not (isinstance(x, str) and x.strip()) for x in ac
            )
        return True

    for tid, t in tasks.items():
        if children[tid]:
            continue  # parents derive state from children
        if t.get("state") in TERMINAL:
            continue  # historical leaves grandfathered
        if ac_blank(t.get("acceptCriteria")):
            die(f"{tid}: leaf task missing acceptCriteria")

    print("ok")

if __name__ == "__main__":
    main()
