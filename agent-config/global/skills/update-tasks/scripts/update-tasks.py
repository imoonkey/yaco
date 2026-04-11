#!/usr/bin/env python3
"""Write-only operations on doc/todo/tasks.json with cross-record validation."""
import fcntl, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

FILE = Path("doc/todo/tasks.json")
STATES = {"ready", "running", "done", "blocked", "cancelled"}
TERMINAL = {"done", "cancelled"}
PRIORITIES = {"critical", "high", "normal", "low"}
ESTIMATES = {"xs", "s", "m", "l", "xl"}
BLOCK_REASONS = {"verification-failed", "human-review", "external", "dependency"}
SLUG_RE = re.compile(r'^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$')

LOCK_FILE = str(FILE.parent / ("."+FILE.name+".lock"))

def load():
    return json.loads(FILE.read_text()) if FILE.exists() else {}

def save(tasks):
    FILE.parent.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(tasks, indent=2, ensure_ascii=False) + "\n")

def with_lock(fn):
    """Serialize concurrent writes via fcntl file lock."""
    FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)

def die(msg):
    print(f"error: {msg}", file=sys.stderr); sys.exit(1)

def validate_types(data):
    checks = {
        "parent": (str, type(None)),
        "depends": (list,),
        "state": (str,),
        "scope": (list,),
        "requireHumanReview": (bool,),
    }
    for k, types in checks.items():
        if k in data and not isinstance(data[k], types):
            die(f"'{k}' must be {'/'.join(t.__name__ for t in types)}")
    # acceptCriteria: str or list[str]
    ac = data.get("acceptCriteria")
    if ac is not None:
        if isinstance(ac, str):
            pass  # ok
        elif isinstance(ac, list):
            if not all(isinstance(x, str) for x in ac):
                die("acceptCriteria list items must be strings")
        else:
            die("acceptCriteria must be str or list[str]")
    # resources: str or list[str]
    res = data.get("resources")
    if res is not None:
        if isinstance(res, str):
            pass  # ok
        elif isinstance(res, list):
            if not all(isinstance(x, str) for x in res):
                die("resources list items must be strings")
        else:
            die("resources must be str or list[str]")
    # V2 fields
    if "priority" in data and data["priority"] not in PRIORITIES:
        die(f"priority must be one of: {', '.join(sorted(PRIORITIES))}")
    if "agent" in data and not isinstance(data.get("agent"), (str, type(None))):
        die("agent must be string or null")
    if "agent" in data and isinstance(data["agent"], str) and not data["agent"].strip():
        die("agent must not be empty")
    if "tags" in data:
        if not isinstance(data["tags"], list) or not all(isinstance(x, str) for x in data["tags"]):
            die("tags must be list of strings")
        if any(not x.strip() for x in data["tags"]):
            die("tags must not contain empty or whitespace-only strings")
    if "estimate" in data and data["estimate"] not in ESTIMATES:
        die(f"estimate must be one of: {', '.join(sorted(ESTIMATES))}")
    if "blockReason" in data and data["blockReason"] not in BLOCK_REASONS:
        die(f"blockReason must be one of: {', '.join(sorted(BLOCK_REASONS))}")
    if "worktree" in data:
        wt = data["worktree"]
        if not isinstance(wt, str):
            die("worktree must be a string")
        if not SLUG_RE.match(wt):
            die("worktree must be a valid slug (alphanumeric and hyphens, no leading/trailing hyphens)")

def validate_refs(tasks, tid, task):
    if task.get("parent") == tid or tid in task.get("depends", []):
        die("self-reference")
    p = task.get("parent")
    if p is not None and p not in tasks:
        die(f"parent '{p}' not found")
    for d in task.get("depends", []):
        if d not in tasks:
            die(f"depends '{d}' not found")

def check_cycles(tasks):
    # Parent chain
    for tid in tasks:
        visited = set()
        cur = tid
        while cur:
            if cur in visited: die(f"cycle in parent chain: {cur}")
            visited.add(cur)
            cur = tasks[cur].get("parent")
    # Depends — DFS
    GRAY, BLACK = 1, 2
    color = {}
    def dfs(t):
        color[t] = GRAY
        for d in tasks[t].get("depends", []):
            if color.get(d) == GRAY: die(f"cycle in depends: {d}")
            if d not in color: dfs(d)
        color[t] = BLACK
    for t in tasks:
        if t not in color: dfs(t)

def has_children(tasks, tid):
    return any(t.get("parent") == tid for t in tasks.values())

def validate_state(tasks, tid, old_state, new_state):
    if new_state not in STATES: die(f"invalid state '{new_state}'")
    # Constraint 1: milestone state derived by rollup
    if has_children(tasks, tid) and new_state != old_state:
        die(f"cannot set state on milestone task (state derived from children)")
    # Constraint 2: -> running requires all depends terminal
    if new_state == "running" and old_state != "running":
        for d in tasks[tid].get("depends", []):
            if tasks[d]["state"] not in TERMINAL:
                die(f"depends '{d}' not terminal (state={tasks[d]['state']})")

def rollup(tasks, tid):
    pid = tasks[tid].get("parent")
    if not pid or pid not in tasks: return
    children = [t for t in tasks if tasks[t].get("parent") == pid]
    all_term = all(tasks[c]["state"] in TERMINAL for c in children)
    ps = tasks[pid]["state"]
    if all_term and ps not in TERMINAL:
        tasks[pid]["state"] = "done"; rollup(tasks, pid)
    elif not all_term and ps == "done":
        tasks[pid]["state"] = "running"; rollup(tasks, pid)

def _ac_is_blank(ac):
    """Check if acceptCriteria is effectively blank."""
    if ac is None:
        return True
    if isinstance(ac, str):
        return not ac.strip()
    if isinstance(ac, list):
        return len(ac) == 0 or all(not x.strip() for x in ac)
    return True

def _scope_repo(entry):
    """Derive repo root hint from a scope glob. Relative → '.', absolute → prefix."""
    if not (entry.startswith("~/") or entry.startswith("/")):
        return "."
    prefix = entry.split("*")[0].rstrip("/")
    parts = prefix.split("/")
    # ~/workspace/<name>/... → ~/workspace/<name>
    if parts[0] == "~" and len(parts) >= 3:
        return "/".join(parts[:3])
    return "/".join(parts[:3]) if len(parts) >= 3 else prefix

def _warn_worktree_scope(tasks, wt):
    """Advisory: warn if tasks sharing a worktree slug have scope in different repo sets."""
    scoped = [(k, v["scope"]) for k, v in tasks.items()
              if v.get("worktree") == wt and v.get("scope")]
    if len(scoped) < 2:
        return
    repo_sets = {k: frozenset(_scope_repo(s) for s in sc) for k, sc in scoped}
    first_key = next(iter(repo_sets))
    ref = repo_sets[first_key]
    for k, rs in repo_sets.items():
        if rs != ref:
            print(f"advisory: tasks sharing worktree '{wt}' have scope in different repo sets", file=sys.stderr)
            return

def cmd_set(tid, data):
    validate_types(data)
    def _do():
        tasks = load()
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        old_state = tasks.get(tid, {}).get("state")
        if tid in tasks:
            data.pop("created", None)
            tasks[tid].update(data)
        else:
            missing = {"title", "description"} - data.keys()
            if missing: die(f"new task requires: {', '.join(sorted(missing))}")
            tasks[tid] = {"parent": None, "depends": [], "state": "ready", **data}
            tasks[tid]["created"] = now
        tasks[tid]["updated"] = now
        # Enforce non-empty acceptCriteria on leaf tasks
        if not has_children(tasks, tid) and _ac_is_blank(tasks[tid].get("acceptCriteria")):
            die("leaf task requires non-empty acceptCriteria")
        validate_refs(tasks, tid, tasks[tid])
        validate_state(tasks, tid, old_state, tasks[tid]["state"])
        check_cycles(tasks)
        rollup(tasks, tid)
        save(tasks)
        wt = tasks[tid].get("worktree")
        if wt:
            _warn_worktree_scope(tasks, wt)
    with_lock(_do)

def cmd_rm(tid):
    def _do():
        tasks = load()
        if tid not in tasks: die(f"task '{tid}' not found")
        if tasks[tid]["state"] == "running": die("cannot remove running task (cancel first)")
        for oid, o in tasks.items():
            if oid == tid: continue
            if o.get("parent") == tid: die(f"task '{oid}' has parent '{tid}'")
            if tid in o.get("depends", []): die(f"task '{oid}' depends on '{tid}'")
        pid = tasks[tid].get("parent")
        del tasks[tid]
        if pid and pid in tasks:
            # Remaining siblings may now all be terminal → rollup parent
            children = [t for t in tasks if tasks[t].get("parent") == pid]
            if children:
                rollup(tasks, children[0])
        save(tasks)
    with_lock(_do)

ARCHIVE_DIR = Path("doc/archive")

def archive_path(slug):
    from datetime import date
    stamp = date.today().strftime("%Y%m%d")
    base = ARCHIVE_DIR / f"{stamp}_{slug}.json"
    if not base.exists():
        return base
    i = 2
    while True:
        candidate = ARCHIVE_DIR / f"{stamp}_{slug}_{i}.json"
        if not candidate.exists():
            return candidate
        i += 1

def cmd_archive(tid):
    def _do():
        tasks = load()
        if tid not in tasks:
            die(f"task '{tid}' not found")
        if tasks[tid]["state"] not in TERMINAL:
            die(f"task '{tid}' is not terminal (state={tasks[tid]['state']})")
        # Collect terminal descendants
        def collect(pid):
            result = []
            for c, v in tasks.items():
                if v.get("parent") == pid:
                    result.append(c)
                    result.extend(collect(c))
            return result
        children = collect(tid)
        non_terminal = [c for c in children if tasks[c]["state"] not in TERMINAL]
        if non_terminal:
            die(f"has non-terminal children: {', '.join(non_terminal)}")
        to_archive = [tid] + children
        archived = {t: tasks[t] for t in to_archive}
        slug = tid
        out = archive_path(slug)
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(archived, indent=2, ensure_ascii=False) + "\n")
        for t in to_archive:
            del tasks[t]
        # Clean up dangling depends references
        archived_set = set(to_archive)
        for t in tasks.values():
            t["depends"] = [d for d in t.get("depends", []) if d not in archived_set]
        save(tasks)
        print(f"archived {len(to_archive)} tasks → {out}")
    with_lock(_do)

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args: die("usage: update-tasks.py set <id> [json] | rm <id> | archive <id>")
    cmd = args[0]
    if cmd == "archive":
        if len(args) < 2: die("usage: update-tasks.py archive <id>")
        cmd_archive(args[1])
    elif len(args) < 2:
        die("usage: update-tasks.py set <id> [json] | rm <id> | archive <id>")
    else:
        tid = args[1]
        if cmd == "set":
            raw = args[2] if len(args) > 2 else sys.stdin.read()
            try: data = json.loads(raw)
            except json.JSONDecodeError as e: die(f"invalid JSON: {e}")
            cmd_set(tid, data)
        elif cmd == "rm":
            cmd_rm(tid)
        else:
            die(f"unknown command: {cmd}")
