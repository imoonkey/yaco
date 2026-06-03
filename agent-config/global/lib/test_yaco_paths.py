"""Tests for yaco_paths.read_yaco_paths. Uses stdlib unittest."""

from __future__ import annotations

import os
import tempfile
import unittest

from yaco_paths import DEFAULTS, read_yaco_paths


class ReadYacoPathsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo_root = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_toml(self, body: str) -> None:
        with open(os.path.join(self.repo_root, "yaco.toml"), "w", encoding="utf-8") as fh:
            fh.write(body)

    def test_defaults_when_missing(self) -> None:
        self.assertEqual(read_yaco_paths(self.repo_root), dict(DEFAULTS))

    def test_overrides_applied(self) -> None:
        self._write_toml(
            "[paths]\n"
            'tasks = "plan/tasks.json"\n'
            'active = "plan/active"\n'
            'archive = "plan/archive"\n'
            'worktrees = "wt"\n'
        )
        self.assertEqual(
            read_yaco_paths(self.repo_root),
            {
                "tasks": "plan/tasks.json",
                "active": "plan/active",
                "archive": "plan/archive",
                "worktrees": "wt",
            },
        )

    def test_partial_override_merges_with_defaults(self) -> None:
        self._write_toml('[paths]\ntasks = "custom/tasks.json"\n')
        expected = dict(DEFAULTS)
        expected["tasks"] = "custom/tasks.json"
        self.assertEqual(read_yaco_paths(self.repo_root), expected)

    def test_rejects_absolute_paths(self) -> None:
        self._write_toml('[paths]\ntasks = "/etc/passwd"\n')
        with self.assertRaisesRegex(ValueError, "repo-relative"):
            read_yaco_paths(self.repo_root)

    def test_rejects_parent_traversal(self) -> None:
        self._write_toml('[paths]\ntasks = "../../etc/passwd"\n')
        with self.assertRaisesRegex(ValueError, r"\.\."):
            read_yaco_paths(self.repo_root)

    def test_project_section_ignored(self) -> None:
        self._write_toml(
            "[project]\n"
            'name = "should-be-ignored"\n'
            'id = "also-ignored"\n'
            "\n"
            "[paths]\n"
            'tasks = "p/tasks.json"\n'
        )
        result = read_yaco_paths(self.repo_root)
        expected = dict(DEFAULTS)
        expected["tasks"] = "p/tasks.json"
        self.assertEqual(result, expected)
        # Identity fields must not leak into the result under any key.
        self.assertNotIn("should-be-ignored", repr(result))
        self.assertNotIn("also-ignored", repr(result))
        self.assertEqual(
            sorted(result.keys()), ["active", "archive", "tasks", "worktrees"]
        )


if __name__ == "__main__":
    unittest.main()
