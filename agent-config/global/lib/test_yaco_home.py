"""Tests for yaco_home.get_yaco_home and path helpers."""

from __future__ import annotations

import os
import unittest

from yaco_home import (
    channel_scope_dir,
    channels_dir,
    get_yaco_home,
    project_events_file,
    projects_file,
    sessions_dir,
    shell_sessions_dir,
    ui_state_dir,
)


class _EnvIsolated(unittest.TestCase):
    """Restore YACO_HOME after each test so leftovers don't bleed between runs."""

    def setUp(self) -> None:
        self._saved = os.environ.get("YACO_HOME")
        os.environ.pop("YACO_HOME", None)

    def tearDown(self) -> None:
        if self._saved is None:
            os.environ.pop("YACO_HOME", None)
        else:
            os.environ["YACO_HOME"] = self._saved


class GetYacoHomeTests(_EnvIsolated):
    def test_defaults_to_dot_yaco_under_home(self) -> None:
        self.assertEqual(
            get_yaco_home(),
            os.path.join(os.path.expanduser("~"), ".yaco"),
        )

    def test_honors_env_override(self) -> None:
        os.environ["YACO_HOME"] = "/tmp/yaco-fixture-root"
        self.assertEqual(get_yaco_home(), "/tmp/yaco-fixture-root")

    def test_empty_env_falls_back_to_default(self) -> None:
        os.environ["YACO_HOME"] = ""
        self.assertEqual(
            get_yaco_home(),
            os.path.join(os.path.expanduser("~"), ".yaco"),
        )


class HelperPathTests(_EnvIsolated):
    FIXTURE = "/tmp/yaco-fixture-root"

    def setUp(self) -> None:
        super().setUp()
        os.environ["YACO_HOME"] = self.FIXTURE

    def test_projects_file(self) -> None:
        self.assertEqual(projects_file(), f"{self.FIXTURE}/projects.json")

    def test_ui_state_dir(self) -> None:
        self.assertEqual(ui_state_dir(), f"{self.FIXTURE}/ui-state")

    def test_shell_sessions_dir(self) -> None:
        self.assertEqual(shell_sessions_dir(), f"{self.FIXTURE}/shell-sessions")

    def test_channels_dir(self) -> None:
        self.assertEqual(channels_dir(), f"{self.FIXTURE}/channels")

    def test_channel_scope_dir(self) -> None:
        self.assertEqual(
            channel_scope_dir("whatsapp"), f"{self.FIXTURE}/channels/whatsapp"
        )
        self.assertEqual(
            channel_scope_dir("wechat"), f"{self.FIXTURE}/channels/wechat"
        )

    def test_project_events_file(self) -> None:
        self.assertEqual(
            project_events_file("workflow"),
            f"{self.FIXTURE}/projects/workflow/events.jsonl",
        )

    def test_sessions_dir(self) -> None:
        # yc-multmux-state-root will flip multmux's SESSIONS_DIR to this.
        self.assertEqual(sessions_dir(), f"{self.FIXTURE}/sessions")


if __name__ == "__main__":
    unittest.main()
