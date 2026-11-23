"""Fault-injection checks for the cutover, using temporary files and fake Docker.

Run: python -m unittest discover -s deploy -p 'test_release_098.py'
No SSH, credentials, database or real systemd process is used.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

if os.name == "nt":
    sys.modules.setdefault("fcntl", types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None))

SPEC = importlib.util.spec_from_file_location("cutover098", Path(__file__).with_name("release-098.py"))
REV = "f" * 40
IMAGE = "sha256:" + "e" * 64
RUN_ID = "test098a"


class CutoverFaults(unittest.TestCase):
    def simulate(self, fault=None):
        app = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(app)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app.REPO = root / "repo"
            app.STATE = root / "state"
            app.DROPINS = root / "dropins"
            app.PIN = app.DROPINS / "25-release-098.conf"
            app.BASE_OVERRIDE = app.STATE / "old.yml"
            app.BASE_GATE = app.STATE / "old-gate.json"
            for path in [app.REPO / "deploy", app.STATE, app.DROPINS,
                         app.STATE / f"build098-{REV}/source/deploy"]:
                path.mkdir(parents=True, exist_ok=True)
            app.BASE_OVERRIDE.write_text("old override")
            app.BASE_GATE.write_text("old gate")
            (app.STATE / "backup096.lock").touch()
            (app.REPO / "deploy/compose.prod.yml").write_text("same compose")
            (app.STATE / f"build098-{REV}/source/deploy/compose.prod.yml").write_text("same compose")
            for name in app.OLD_NAMES:
                (app.DROPINS / name).write_text("original " + name)
            initial = {p: p.read_bytes() for p in app.DROPINS.iterdir()}
            state = {"image": app.BASE_IMAGE, "active": True, "failed": False,
                     "restore": False, "frozen": False, "policy": "unless-stopped"}

            def prop(name):
                return {"ActiveState": "active" if state["active"] else "inactive",
                        "NeedDaemonReload": "no", "Restart": "no", "WorkingDirectory": str(app.REPO),
                        "DropInPaths": " ".join([str(app.DROPINS / n) for n in app.OLD_NAMES] +
                                                 ([str(app.PIN)] if app.PIN.exists() else []))}[name]

            def fail_once(phase):
                if fault == phase and not state["failed"]:
                    state["failed"] = True
                    raise RuntimeError("injected " + phase)

            def fake_run(args, **_):
                if args[:2] == ["systemctl", "stop"]:
                    state["active"] = False
                    if fault == "late-create" and app.phase == "rollback":
                        state["image"] = IMAGE
                        state["docker_running"] = True
                elif args[:2] == ["systemctl", "start"]:
                    if app.PIN.exists():
                        state["image"] = IMAGE
                        # Compose can remove the previous container then fail to create its successor.
                        if fault in ["missing-container", "late-create"] and not state["failed"]:
                            state["image"] = None
                            state["failed"] = True
                            raise RuntimeError("injected absent container")
                        state["policy"] = "no"
                        if fault == "failed-running-start" and not state["failed"]:
                            state["failed"] = True
                            state["active"] = False  # failed systemd unit; Docker still runs
                            state["docker_running"] = True
                            raise RuntimeError("injected unhealthy candidate")
                    else:
                        state["image"] = app.BASE_IMAGE
                        state["policy"] = "unless-stopped"
                    state["active"] = True
                elif args[:3] == ["systemctl", "is-active", "kanon-runtime.service"]:
                    return "active"
                elif args[:3] == ["docker", "image", "inspect"]:
                    candidate = args[-1] == IMAGE
                    return f"{IMAGE if candidate else app.BASE_IMAGE} {REV if candidate else app.BASE_REV} {'0.9.8' if candidate else '0.9.7'}"
                elif args[:2] == ["docker", "ps"]:
                    if any("kanon098-" in a for a in args):
                        return ""
                    if "-q" in args:
                        return "id" if state["image"] and (state["active"] or state.get("docker_running") or "-a" in args) else ""
                    return f"{'c' * 64} {app.APP}" if state["image"] else ""
                elif args[:2] == ["docker", "inspect"]:
                    if state["image"] is None:
                        raise RuntimeError("container absent")
                    fmt = args[3]
                    if fmt == "{{.Id}}":
                        return "c" * 64
                    if fmt == "{{.Image}}":
                        return state["image"]
                    if fmt.startswith("{{.Image}} {{index"):
                        return f"{state['image']} {RUN_ID}"
                    if "canon.release098.run" in fmt:
                        return RUN_ID
                    candidate = state["image"] == IMAGE
                    return f"{state['image']} true healthy {state['policy']} {REV if candidate else app.BASE_REV} {'0.9.8' if candidate else '0.9.7'}"
                elif args[:2] == ["docker", "update"]:
                    state["policy"] = args[3]
                elif args[:3] == ["docker", "container", "stop"]:
                    state["docker_running"] = False
                elif args[:2] == ["docker", "run"]:
                    operation = args[-2] if "verify" in args else "restore" if "restore" in args else "snapshot"
                    fail_once("restore" if operation == "restore" else "snapshot" if app.phase == "fresh-snapshot" else "inventory")
                    work = app.STATE / f"release098-{RUN_ID}"
                    if "restore" in args:
                        state["restore"] = True
                    if "snapshot" in args:
                        target = "frozen.json" if "/backup/frozen.json" in args else "before.json"
                        sha = "changed" if fault == "inventory-mismatch" and target == "frozen.json" else "same"
                        (work / target).write_text(json.dumps({"sourceSha256": "source", "tables": [{"name": "cards", "sha256": sha}]}))
                    return json.dumps({"status": "restored" if "restore" in args else "verified" if "verify" in args else "saved",
                                       "sha256": "same", "tableCounts": {"cards": 1}})
                elif args[0] == "curl":
                    if "-i" in args:
                        return "HTTP/1.1 503\nx-canon-deploy-freeze: writes" if state["frozen"] else "HTTP/1.1 405"
                    if args[-1].endswith("/api/version"):
                        return json.dumps({"version": "0.9.8" if state["image"] == IMAGE else "0.9.7",
                                           "revision": REV if state["image"] == IMAGE else app.BASE_REV})
                    return "{}"
                return ""

            actual_replace = app.os.replace
            actual_write = app.write

            def write(path, value):
                if path.parent == app.DROPINS and fault == "partial-pin" and not state["failed"]:
                    state["failed"] = True
                    path.write_text(value[:35])
                    raise OSError("injected partial write")
                actual_write(path, value)

            def replace(src, dst):
                if str(dst).endswith("image.override.yml"):
                    state["frozen"] = 'CANON_DEPLOY_FREEZE_WRITES: "true"' in Path(src).read_text()
                actual_replace(src, dst)

            with patch.object(app, "run", fake_run), patch.object(app, "prop", prop), \
                 patch.object(app, "write", write), \
                 patch.object(app, "private", lambda *_: None), patch.object(app, "command", lambda *_: None), \
                 patch.object(app.os, "geteuid", lambda: 0, create=True), \
                 patch.object(app.os, "umask", lambda *_: 0), patch.object(app.os, "replace", replace), \
                 patch.object(sys, "argv", ["release-098.py", REV, IMAGE, RUN_ID]), \
                 contextlib.redirect_stdout(io.StringIO()):
                if fault:
                    with self.assertRaises(Exception):
                        app.main()
                    self.assertTrue(state["active"], "Previous compatible release must run after failure")
                    self.assertEqual(state["image"], app.BASE_IMAGE)
                    self.assertFalse(app.PIN.exists())
                    if fault != "partial-pin":
                        self.assertTrue((app.STATE / f"release098-{RUN_ID}/rollback.json").exists())
                else:
                    app.main()
                    self.assertEqual(state["image"], IMAGE)
                    self.assertEqual(state["policy"], "unless-stopped")
                    self.assertTrue(state["restore"])
                    self.assertTrue((app.STATE / f"release098-{RUN_ID}/accepted.json").exists())
            self.assertEqual({p: p.read_bytes() for p in initial}, initial)
            self.assertEqual(app.BASE_OVERRIDE.read_text(), "old override")

    def test_success_requires_restore_and_preserves_old_release(self):
        self.simulate()

    def test_snapshot_failure_restores_097(self):
        self.simulate("snapshot")

    def test_restore_failure_restores_097(self):
        self.simulate("restore")

    def test_inventory_difference_prevents_reopening_writes(self):
        self.simulate("inventory-mismatch")

    def test_missing_container_after_failed_create_restores_097(self):
        self.simulate("missing-container")

    def test_partial_pin_write_does_not_leave_systemd_broken(self):
        self.simulate("partial-pin")

    def test_failed_start_leaving_running_candidate_restores_097(self):
        self.simulate("failed-running-start")

    def test_late_container_creation_during_stop_is_rechecked(self):
        self.simulate("late-create")


if __name__ == "__main__":
    unittest.main()
