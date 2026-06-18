#!/usr/bin/env python3
"""Mechanical doc checks for /update-doc.

Resolves relative markdown links, validates mermaid blocks, and (optionally)
greps for stale paths left behind by a rename. Stdlib only.

Usage:
  scripts/check-docs.py [root]                       # default root: doc
  scripts/check-docs.py doc --stale old/path.md foo  # also fail if a pattern appears

Exit status is non-zero if any check fails.
"""
from __future__ import annotations

import re
import sys
import pathlib

VALID_DIAGRAMS = (
    "flowchart", "graph", "sequenceDiagram", "stateDiagram", "classDiagram",
    "erDiagram", "gantt", "pie", "mindmap", "timeline", "journey", "gitGraph",
)
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
MERMAID_RE = re.compile(r"```mermaid\n(.*?)```", re.S)


def main(argv: list[str]) -> int:
    positional = [a for a in argv[1:] if not a.startswith("--")]
    root = pathlib.Path(positional[0] if positional else "doc")
    stale = argv[argv.index("--stale") + 1:] if "--stale" in argv else []

    files = sorted(root.rglob("*.md"))
    if not files:
        print(f"no markdown found under {root}/")
        return 1

    broken: list[str] = []
    bad_mermaid: list[str] = []
    stale_hits: list[str] = []

    for f in files:
        text = f.read_text(encoding="utf-8")

        # 1. relative links resolve on disk
        for m in LINK_RE.finditer(text):
            target = m.group(1).strip().split("#")[0]
            if not target or target.startswith(("http://", "https://", "mailto:")):
                continue
            if not (f.parent / target).resolve().exists():
                broken.append(f"{f}: {m.group(1)}")

        # 2. mermaid fences balanced + a known diagram type
        if "```mermaid" in text:
            if text.count("```") % 2:
                bad_mermaid.append(f"{f}: unbalanced ``` fences")
            for block in MERMAID_RE.findall(text):
                head = block.strip().split("\n", 1)[0]
                if not head.startswith(VALID_DIAGRAMS):
                    bad_mermaid.append(f"{f}: mermaid opens with {head!r}")

        # 3. stale patterns (post-rename grep). Skip the history trace —
        # PROGRESS.md records what was true on each date and is never rewritten.
        if f.name != "PROGRESS.md":
            for pattern in stale:
                if pattern in text:
                    stale_hits.append(f"{f}: contains {pattern!r}")

    failed = False
    for label, hits in (("broken links", broken),
                        ("mermaid issues", bad_mermaid),
                        ("stale paths", stale_hits)):
        if hits:
            failed = True
            print(f"\n{label} ({len(hits)}):")
            for h in hits:
                print(f"  {h}")

    print(f"\n{'FAIL' if failed else 'OK'} — scanned {len(files)} files under {root}/")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
