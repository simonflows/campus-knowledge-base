"""Exercise the 1.2.0 transition through the real release entry point."""
import importlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import ci_image_load_100 as staging
import test_release_100_update as legacy
import test_release_110_update as base_fixture

BASE_REV = "2ab9a3f0c70311cd7c4773b3f85e4e5c6fbc189f"
BASE_IMAGE = "sha256:98a4b4b0a7144c0a465d89da078ff542e7d57cde5054be622060e624801b88f3"
BASE_RUN = "f110n27a"
RUN = "f120n27a"
REV, IMAGE = legacy.REV, legacy.IMAGE
NATIVE_CHAIN = "sha256:" + "b" * 64


class Cutover120Tests(unittest.TestCase):
    def setUp(self):
        entry = Path(__file__).with_name("release-120-update.py")
        self.assertTrue(entry.is_file(), "the 1.2.0 cutover entry point must exist")
        self.release = importlib.import_module("release-120-update")
        previous = base_fixture.Cutover110Tests()
        self.addCleanup(previous.doCleanups)
        previous.setUp()
        self.previous = previous
        self.fixture = fixture = previous.fixture
        self.app = app = fixture.app
        self.enterContext(patch.object(app, "updater_lock_held", return_value=True))
        self.enterContext(patch.object(self.release, "engine", app))
        self.enterContext(patch.object(self.release.previous, "engine", app))

        self.base = app.STATE / f"release110-{BASE_RUN}"
        self.base.mkdir(mode=0o700)
        build = self.stage(BASE_REV, BASE_IMAGE, "1.1.0", 45943480267, "110")
        self.base_build = build
        self.base_source = build / "source"
        (self.base_source / "deploy/release-110-update.py").write_bytes(b"immutable previous helper")
        synthetic = previous.reseal(build, BASE_REV)
        documented = self.release.ACCEPTED_110_CI
        synthetic.update({key: value for key, value in documented.items()
                          if key not in {"snapshotCommitted", "sourceManifestSha256", "sourceArchiveSha256"}})
        chain = documented["snapshotCommitted"]
        previous.write_provenance(build, synthetic, chain)
        self.enterContext(patch.object(self.release, "ACCEPTED_110_CI", {
            **documented, **{key: synthetic[key] for key in ("sourceArchiveSha256", "sourceManifestSha256")},
        }))
        wrapped = {key: value for key, value in synthetic.items() if key not in {"schema", "image", "revision"}}
        self.reviewed = {**wrapped, "snapshotCommitted": chain, "revision": BASE_REV, "image": BASE_IMAGE,
                         "run": BASE_RUN, "version": "1.1.0", "previousRun": "f100n26b",
                         "previousRevision": base_fixture.BASE_REV, "previousImage": base_fixture.BASE_IMAGE,
                         "previousVersion": "1.0.0", "oldContainer": "a" * 64, "restored": True,
                         "baselineRestorePrefix": "qa095-110-f110n27a-old-",
                         "baselineBackupSha256": self.release.ACCEPTED_110_BACKUPS["baselineBackupSha256"],
                         "baselineTableCounts": {name: 1 for name in app.TABLES}}
        frozen = {**self.reviewed, "inventoryUnchanged": True, "status": "frozen-verified",
                  "frozenBackupSha256": self.release.ACCEPTED_110_BACKUPS["frozenBackupSha256"],
                  "frozenTableCounts": {name: 1 for name in app.TABLES}, "frozenContainer": "b" * 64,
                  "emailAccountsEnabled": False}
        accepted = {**frozen, "yandexOAuthStartVerified": True, "status": "accepted",
                    "container": self.release.ACCEPTED_110_CONTAINER}
        for name, proof in [("reviewed-release", self.reviewed), ("frozen-verified", frozen), ("accepted", accepted),
                            ("activation-authorized", {**accepted, "status": "activation-authorized"})]:
            legacy.save(self.base / f"{name}.json", proof)
        self.base_boot = (f"/usr/bin/python3 -B {self.base_source / 'deploy/release-110-update.py'} "
                          f"--boot-gate {legacy.BOOT} {BASE_REV} {BASE_IMAGE}")
        self.base_pin = app.DROPINS / "30-release-110.conf"
        fixture.override(self.base_pin, app.pin_content(self.base, BASE_REV, self.base_boot))
        fixture.override(self.base / "image.override.yml", app.override_content(BASE_IMAGE, BASE_RUN, "unless-stopped", False))
        self.prior_bytes = {path: path.read_bytes() for path in [*app.DROPINS.iterdir(), *self.base.iterdir()]}
        self.native = {BASE_IMAGE: chain, IMAGE: NATIVE_CHAIN}
        self.enterContext(patch.object(self.release, "require_snapshot", self.require_snapshot))

    def stage(self, revision, image, version, run, series):
        fixture = self.fixture
        build = fixture.stage if revision == REV else fixture.artifact(revision, image, run)
        target = fixture.app.STATE / f"build{series}-{revision}"
        build.rename(target)
        (target / "source/package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        return target

    def require_snapshot(self, image, expected):
        if self.native.get(image) != expected:
            raise RuntimeError("native snapshot is unavailable")

    def wire(self):
        fixture, app = self.fixture, self.app
        build = self.stage(REV, IMAGE, "1.2.0", 50000000000, "120")
        script = build / "source/deploy/release-120-update.py"
        script.write_bytes(Path(self.release.__file__).read_bytes())
        provenance = self.previous.reseal(build, REV)
        self.previous.write_provenance(build, {**provenance, "ciRunId": 50000000000}, NATIVE_CHAIN)
        fixture.work = app.STATE / f"release120-{RUN}"
        fixture.base = self.base
        fixture.pin = app.DROPINS / "31-release-120.conf"
        fixture.gate = fixture.work / "reviewed-release.json"
        fixture.activation = fixture.work / "activation-authorized.json"
        fixture.accepted = fixture.work / "accepted.json"
        self.fence = fixture.work / "new-writer-allowed.json"
        fixture.conditions += [f"/usr/bin/test -f {self.previous.base / 'reviewed-release.json'}", self.previous.base_boot,
                               f"/usr/bin/test -f {self.base / 'reviewed-release.json'}", self.base_boot]
        self.enterContext(patch.object(self.release, "SCRIPT", script))
        self.enterContext(patch.object(app, "SCRIPT", script))
        self.enterContext(patch.object(sys, "argv", [str(script), REV, IMAGE, RUN]))
        self.enterContext(patch.object(app, "run", self.run_command))
        self.old_starts = 0
        return fixture

    def run_command(self, args, **kwargs):
        fixture, app = self.fixture, self.app
        candidate = fixture.container_id == legacy.NEW
        image, revision, run, version = ((IMAGE, REV, RUN, "1.2.0") if candidate else
                                         (BASE_IMAGE, BASE_REV, BASE_RUN, "1.1.0"))
        if args[:3] == ["docker", "image", "inspect"]:
            return {BASE_IMAGE: f"{BASE_IMAGE} {BASE_REV} 1.1.0", IMAGE: f"{IMAGE} {REV} 1.2.0"}[args[-1]]
        if args[:2] == ["docker", "inspect"]:
            template = args[3]
            running = str(fixture.running).lower()
            if template.startswith("{{.Image}} {{.State.Running}}"):
                return f"{image} {running} healthy {fixture.policy} {revision} {version}"
            if "{{.State.Running}}" in template:
                return f"{image} {run} {running} {fixture.policy}"
            return f"{image} {run}"
        if args[:2] == ["systemctl", "start"]:
            if not fixture.pin.exists():
                self.old_starts += 1
                return fixture.run_command(args, **kwargs)
            self.assertTrue(self.release.boot_gate(legacy.BOOT, REV, IMAGE))
            self.assertFalse(self.release.boot_gate(legacy.NEXT_BOOT, REV, IMAGE))
            fixture.unit_active = fixture.running = True
            fixture.frozen = 'CANON_DEPLOY_FREEZE_WRITES: "true"' in (fixture.work / "image.override.yml").read_text()
            fixture.container_id, fixture.policy = legacy.NEW, "no"
            if not fixture.frozen:
                self.assertIn("frozen-verified.json", fixture.durable[fixture.work])
                self.assertIn(self.fence.name, fixture.durable[fixture.work])
                fixture.writer_starts += 1
                fixture.fail("open-start")
            return ""
        if args[:2] == ["docker", "update"] and args[3] == "unless-stopped":
            self.assertTrue(self.release.boot_gate(legacy.NEXT_BOOT, REV, IMAGE))
            self.assertFalse(fixture.accepted.exists())
            fixture.policy = args[3]
            fixture.fail("restart-policy")
            return ""
        if args[:2] == ["docker", "run"] and "scripts/database-backup.ts" in args:
            frozen = "/backup/frozen.json" in args
            self.assertEqual(args[args.index("node") - 1], IMAGE if frozen else BASE_IMAGE)
            translated = [app.BASE_IMAGE if arg == BASE_IMAGE else arg for arg in args]
            if "restore" in args:
                self.assertEqual(args[-2:], ["--prefix", "qa095-120-f120n27a-old-"])
                translated[-1] = "qa095-100-f100n26b-old-"
            return fixture.backup_command(translated)
        if args[0] == "curl" and args[-1].endswith("/api/version"):
            if fixture.fault == "frozen-version" and candidate and fixture.frozen:
                version = "1.1.0"
            return json.dumps({"revision": revision, "version": version})
        return fixture.run_command(args, **kwargs)

    def assert_prior_unchanged(self):
        self.assertEqual({path: path.read_bytes() for path in self.prior_bytes}, self.prior_bytes)

    def test_bootstrap_rejects_tampered_110_and_inherited_boot_pin(self):
        _, _, conditions, gate_files = self.release.baseline()
        self.assertEqual(conditions[-1], self.base_boot)
        self.assertIn(self.base / "activation-authorized.json", gate_files)
        for path in [self.base / "accepted.json", self.base_pin, self.previous.base_pin,
                     self.base_source / "unrelated.txt"]:
            with self.subTest(path=path):
                before = path.read_bytes()
                path.write_bytes(before + b"unexpected")
                with self.assertRaises((RuntimeError, json.JSONDecodeError)):
                    self.release.baseline()
                path.write_bytes(before)
        self.assert_prior_unchanged()

    def test_orphaned_same_boot_candidate_cannot_restart_without_updater_lock(self):
        self.wire()
        expected = self.app.identity(REV, IMAGE, RUN, "1.2.0")
        self.fixture.work.mkdir(mode=0o700)
        legacy.save(self.fixture.gate, expected)
        legacy.save(self.fence, {**expected, "status": "new-writer-allowed"})
        self.fixture.override(self.fixture.work / "image.override.yml", self.app.override_content(IMAGE, RUN, "no", False))
        with patch.object(self.app, "updater_lock_held", return_value=False):
            self.assertFalse(self.release.boot_gate(legacy.BOOT, REV, IMAGE))
            self.assertFalse(self.release.boot_gate(legacy.NEXT_BOOT, REV, IMAGE))

    def test_missing_native_proof_leaves_110_running(self):
        fixture = self.wire()
        del self.native[IMAGE]
        with self.assertRaises(RuntimeError):
            self.release.main()
        self.assertEqual((fixture.stops, fixture.writer_starts), (0, 0))
        self.assertTrue(fixture.running)
        self.assertFalse(fixture.pin.exists() or fixture.work.exists())

    def test_frozen_version_failure_returns_exact_110_writer(self):
        fixture = self.wire()
        fixture.fault = "frozen-version"
        with self.assertRaises(RuntimeError):
            self.release.main()
        rollback = json.loads((fixture.work / "rollback.json").read_text())
        self.assertEqual((rollback["status"], rollback["image"], rollback["revision"]), ("rolled-back", BASE_IMAGE, BASE_REV))
        self.assertEqual((self.old_starts, fixture.writer_starts), (1, 0))
        self.assertTrue(fixture.running)
        self.assertFalse(fixture.pin.exists() or self.fence.exists())
        self.assert_prior_unchanged()

    def assert_maintenance(self, fixture):
        self.assertEqual((self.old_starts, fixture.writer_starts), (0, 1))
        self.assertTrue(fixture.pin.is_file() and self.fence.is_file())
        self.assertFalse(fixture.running or fixture.gate.exists() or fixture.accepted.exists() or fixture.activation.exists())
        self.assertFalse((fixture.work / "rollback.json").exists())
        self.assertEqual(fixture.policy, "no")
        self.assertEqual(json.loads((fixture.work / "maintenance-required.json").read_text())["status"], "maintenance-required")
        self.assertFalse(self.release.boot_gate(legacy.BOOT, REV, IMAGE))
        self.assertFalse(self.release.boot_gate(legacy.NEXT_BOOT, REV, IMAGE))
        self.assert_prior_unchanged()

    def test_write_start_failure_after_first_possible_write_keeps_service_closed(self):
        fixture = self.wire()
        fixture.fault = "open-start"
        with self.assertRaises(RuntimeError):
            self.release.main()
        self.assert_maintenance(fixture)

    def test_failure_after_authorizing_restart_withdraws_both_gates_and_never_restarts_110(self):
        fixture = self.wire()
        fixture.fault = "restart-policy"
        with self.assertRaises(RuntimeError):
            self.release.main()
        self.assert_maintenance(fixture)

    def test_uncertain_fence_fsync_never_opens_new_writes_or_restarts_110(self):
        fixture = self.wire()

        def sync(path):
            if path == fixture.work and self.app.phase == "seal-writer-fence":
                raise OSError("failed fence directory sync after rename")
            fixture.sync(path)

        with patch.object(self.app, "fsync_directory", sync), self.assertRaises(OSError):
            self.release.main()
        self.assertEqual((self.old_starts, fixture.writer_starts), (0, 0))
        self.assertTrue(fixture.pin.is_file() and self.fence.is_file())
        self.assertFalse(fixture.running or fixture.gate.exists() or fixture.activation.exists())
        self.assertTrue((fixture.work / "maintenance-required.json").is_file())

    def test_success_leaves_durable_fence_and_boot_authorization(self):
        fixture = self.wire()
        self.release.main()
        accepted = json.loads(fixture.accepted.read_text())
        self.assertEqual((accepted["version"], accepted["previousVersion"], accepted["previousRun"]),
                         ("1.2.0", "1.1.0", BASE_RUN))
        self.assertTrue(accepted["inventoryUnchanged"] and accepted["restored"])
        self.assertEqual(fixture.backups, [("snapshot", "/backup/before.json"), ("verify", "/backup/before.json"),
                                           ("restore", "/backup/before.json"), ("snapshot", "/backup/frozen.json"),
                                           ("verify", "/backup/frozen.json")])
        self.assertEqual((self.old_starts, fixture.writer_starts, fixture.policy), (0, 1, "unless-stopped"))
        self.assertIn(self.fence.name, fixture.durable[fixture.work])
        self.assertTrue(self.release.boot_gate(legacy.NEXT_BOOT, REV, IMAGE))
        self.assert_prior_unchanged()
        legacy.save(self.fence, {**json.loads(self.fence.read_text()), "revision": BASE_REV})
        self.assertFalse(self.release.boot_gate(legacy.BOOT, REV, IMAGE))
        self.assertFalse(self.release.boot_gate(legacy.NEXT_BOOT, REV, IMAGE))
