"""Offline checks of the accepted f100n26b baseline and the 1.1.0 cutover."""
import hashlib
import importlib
import json
from pathlib import Path
import sys
import tarfile
import unittest
from unittest.mock import patch

import ci_image_load_100 as staging
import test_release_100_update as legacy


BASE_REV = "c1405c6987bd22b0c740c935c0af28625dc79fa7"
BASE_IMAGE = "sha256:7e8eecacabbbfeaf56ab5bf8737a73757487ef9bdff1e6fc7d3f3cbc5419543b"
CI_RUN = 45748848661
BASE_PROOF_FIELDS = {
    "ciArtifactId": 15084817585,
    "ciArtifactSha256": "sha256:ab5a49d715920693b45307e02bcbf3c2dd31563650e1a673331e4e4a74599a95",
    "snapshotCommitted": "sha256:14cc64b8c5390335deb8ca00d8fb3f6a533d7e989ac37c89efcd8f663fd4bf50",
}
PREVIOUS_REV = "25fa0098882be831847fdb42361952832f44fd67"
PREVIOUS_IMAGE = "sha256:23f9446ccc91462aa186d802a916c596e00f334c937c2dc281e4b35dad1feb10"
RUN = "f110n27a"
BOOT = legacy.BOOT
REV = legacy.REV
IMAGE = legacy.IMAGE


class Cutover110Tests(unittest.TestCase):
    def setUp(self):
        fixture = legacy.UpdateFaults()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        self.fixture = fixture
        self.app = fixture.app
        self.base = self.app.STATE / "release100-f100n26b"
        self.base.mkdir(mode=0o700)
        self.base_build = fixture.artifact(BASE_REV, BASE_IMAGE, CI_RUN)
        self.base_source = self.base_build / "source"
        (self.base_source / "deploy/release-100-update.py").write_bytes(b"accepted immutable 1.0.0 helper")
        self.base_provenance = self.reseal(self.base_build, BASE_REV)
        self.base_provenance.update({key: value for key, value in BASE_PROOF_FIELDS.items()
                                     if key != "snapshotCommitted"})
        self.write_provenance(self.base_build, self.base_provenance, BASE_PROOF_FIELDS["snapshotCommitted"])
        baseline_provenance = {key: value for key, value in self.base_provenance.items()
                               if key not in {"schema", "image", "revision"}}
        baseline_provenance["snapshotCommitted"] = BASE_PROOF_FIELDS["snapshotCommitted"]
        self.reviewed = {**baseline_provenance, "image": BASE_IMAGE, "revision": BASE_REV, "version": "1.0.0",
                         "run": "f100n26b", "previousRun": "f100n26a", "previousRevision": PREVIOUS_REV,
                         "previousImage": PREVIOUS_IMAGE, "previousVersion": "1.0.0", "oldContainer": "a" * 64,
                         "baselineBackupSha256": "b" * 64, "baselineRestorePrefix": "qa095-100-f100n26b-old-",
                         "baselineTableCounts": {name: 1 for name in self.app.TABLES}, "restored": True}
        self.frozen = {**self.reviewed, "frozenContainer": "c" * 64, "frozenBackupSha256": "d" * 64,
                       "frozenTableCounts": {name: 1 for name in self.app.TABLES}, "inventoryUnchanged": True,
                       "emailAccountsEnabled": False, "status": "frozen-verified"}
        self.accepted = {**self.frozen, "status": "accepted", "container": "e" * 64, "yandexOAuthStartVerified": True}
        legacy.save(self.base / "reviewed-release.json", self.reviewed)
        legacy.save(self.base / "frozen-verified.json", self.frozen)
        legacy.save(self.base / "accepted.json", self.accepted)
        legacy.save(self.base / "activation-authorized.json", {**self.accepted, "status": "activation-authorized"})
        self.base_boot = (f"/usr/bin/python3 -B {self.base_source / 'deploy/release-100-update.py'} "
                          f"--boot-gate {BOOT} {BASE_REV} {BASE_IMAGE}")
        self.base_pin = self.app.DROPINS / "29-release-100-update.conf"
        fixture.pin_for(self.base_pin, self.base, BASE_REV)
        legacy.UpdateFaults.override(self.base_pin, self.base_pin.read_text().replace(
            "ExecStart=\n", f"ExecCondition={self.base_boot}\nExecStart=\n", 1))
        legacy.UpdateFaults.override(self.base / "image.override.yml",
                                    f'services:\n  app:\n    image: "{BASE_IMAGE}"\n    restart: "unless-stopped"\n'
                                    '    labels:\n      canon.release100.run: "f100n26b"\n    environment:\n'
                                    '      CANON_DEPLOY_FREEZE_WRITES: "false"\n      CANON_DISK_RECOVERY: "true"\n'
                                    '      CAMPUS_EMAIL_ACCOUNTS_ENABLED: "false"\n')
        self.original = {path: path.read_bytes() for path in [self.base_pin, *self.base.iterdir()]}

    def reseal(self, build, revision):
        source = build / "source"
        for path in source.rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        archive_path = build / staging.SOURCE_ARCHIVE
        with tarfile.open(archive_path, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": revision}) as archive:
            archive.add(source, arcname="source")
        proof = json.loads((build / staging.PROVENANCE).read_text())
        proof.update(sourceArchiveSha256=staging.hash_file(archive_path),
                     sourceManifestSha256=staging.source_manifest(archive_path, revision))
        return proof

    @staticmethod
    def write_provenance(build, proof, snapshot):
        legacy.save(build / staging.PROVENANCE, proof)
        legacy.save(build / staging.RECEIPT, {**proof, "loaded": True, "snapshotCommitted": snapshot})

    def candidate(self):
        script = Path(__file__).with_name("release-110-update.py")
        self.assertTrue(script.is_file(), "the 1.1.0 cutover entry point must exist")
        candidate = importlib.import_module("release-110-update")
        self.enterContext(patch.object(candidate, "engine", self.app))
        return candidate

    def test_accepted_100_update_and_both_gates_bind_the_baseline(self):
        candidate = self.candidate()
        work, source, conditions, gate_files = candidate.baseline()
        self.assertEqual((work, source), (self.base, self.base_source))
        self.assertEqual(conditions[-2:], [f"/usr/bin/test -f {self.base / 'reviewed-release.json'}", self.base_boot])
        self.assertIn(self.base / "activation-authorized.json", gate_files)
        self.assertEqual({path: path.read_bytes() for path in self.original}, self.original)

    def test_rejects_mismatched_durable_baseline_receipts(self):
        candidate = self.candidate()
        with self.subTest(part="activation"):
            path = self.base / "activation-authorized.json"
            legacy.save(path, {**self.accepted, "status": "activation-authorized", "ciRunId": 42})
            with self.assertRaises(RuntimeError):
                candidate.baseline()
            path.write_bytes(self.original[path])
        with self.subTest(part="review"):
            path = self.base / "reviewed-release.json"
            legacy.save(path, {**self.reviewed, "snapshotCommitted": "sha256:" + "2" * 64})
            with self.assertRaises(RuntimeError):
                candidate.baseline()
            path.write_bytes(self.original[path])
        with self.subTest(part="pin"):
            self.base_pin.write_bytes(self.original[self.base_pin].replace(b"--boot-gate", b"--skip-gate"))
            with self.assertRaises(RuntimeError):
                candidate.baseline()

    def test_rejects_individually_attested_baseline_with_wrong_ci_identity(self):
        candidate = self.candidate()
        self.write_provenance(self.base_build, {**self.base_provenance, "ciRunId": 42},
                              BASE_PROOF_FIELDS["snapshotCommitted"])
        for name in ("reviewed-release", "frozen-verified", "activation-authorized", "accepted"):
            path = self.base / (name + ".json")
            legacy.save(path, {**json.loads(path.read_text()), "ciRunId": 42})
        with self.assertRaises(RuntimeError):
            candidate.baseline()

    def prepare_candidate(self, candidate, version="1.1.0", run=800):
        build = self.fixture.stage
        build.rename(self.app.STATE / f"build110-{REV}")
        build = self.app.STATE / f"build110-{REV}"
        source = build / "source"
        script = source / "deploy/release-110-update.py"
        script.write_bytes(Path(candidate.__file__).read_bytes())
        (source / "package.json").write_text(json.dumps({"version": version}))
        proof = self.reseal(build, REV)
        self.write_provenance(build, {**proof, "ciRunId": run}, "sha256:" + "f" * 64)
        self.enterContext(patch.object(candidate, "SCRIPT", script))
        self.enterContext(patch.object(sys, "argv", [str(script), REV, IMAGE, RUN]))
        return self.app.DROPINS / "30-release-110.conf"

    def test_candidate_preflight_rejects_old_package_version_before_stop(self):
        candidate = self.candidate()
        pin = self.prepare_candidate(candidate, version="1.0.0")
        with self.assertRaises(RuntimeError):
            candidate.main()
        self.assertEqual(self.app.phase, "candidate-source")
        self.assertEqual(self.fixture.stops, 0)
        self.assertFalse(pin.exists())

    def test_candidate_preflight_rejects_replay_of_base_ci_run(self):
        candidate = self.candidate()
        pin = self.prepare_candidate(candidate, run=CI_RUN)
        with self.assertRaises(RuntimeError):
            candidate.main()
        self.assertEqual(self.app.phase, "candidate-source")
        self.assertEqual(self.fixture.stops, 0)
        self.assertFalse(pin.exists())

    def test_candidate_preflight_rejects_drift_outside_guarded_source_files(self):
        candidate = self.candidate()
        pin = self.prepare_candidate(candidate)
        source = self.app.STATE / f"build110-{REV}" / "source"
        (source / "unrelated.txt").write_text("unexpected change")
        with self.assertRaises(RuntimeError):
            candidate.main()
        self.assertEqual(self.app.phase, "candidate-source")
        self.assertEqual(self.fixture.stops, 0)
        self.assertFalse(pin.exists())

    def test_cutover_verifies_both_versions_and_accepts_only_after_frozen_comparison(self):
        candidate = self.candidate()
        fixture = self.wire_fakes(candidate)
        candidate.main()
        accepted = json.loads(fixture.accepted.read_text())
        self.assertEqual((accepted["version"], accepted["previousVersion"], accepted["previousRun"]),
                         ("1.1.0", "1.0.0", "f100n26b"))
        self.assertEqual((accepted["revision"], accepted["image"], accepted["ciRunId"]), (REV, IMAGE, 800))
        self.assertEqual(accepted["baselineRestorePrefix"], "qa095-110-f110n27a-old-")
        self.assertEqual(fixture.backups, [("snapshot", "/backup/before.json"), ("verify", "/backup/before.json"),
                                           ("restore", "/backup/before.json"), ("snapshot", "/backup/frozen.json"),
                                           ("verify", "/backup/frozen.json")])
        self.assertEqual(fixture.writer_starts, 1)
        self.assertEqual(fixture.policy, "unless-stopped")
        self.assertTrue(self.app.boot_gate(legacy.NEXT_BOOT, REV, IMAGE, update=candidate.UPDATE))
        self.assertEqual({path: path.read_bytes() for path in self.original}, self.original)

    def test_candidate_http_version_failure_rolls_back_to_exact_100_writer(self):
        candidate = self.candidate()
        fixture = self.wire_fakes(candidate, fault="candidate-version")
        with self.assertRaises(RuntimeError):
            candidate.main()
        rollback = json.loads((fixture.work / "rollback.json").read_text())
        self.assertEqual(rollback, {"status": "rolled-back", "phase": "frozen-start", "image": BASE_IMAGE,
                                    "revision": BASE_REV, "dataRestored": False})
        self.assertFalse(fixture.pin.exists() or fixture.accepted.exists() or fixture.activation.exists())
        self.assertTrue(fixture.running)
        self.assertEqual((fixture.container_id, fixture.policy, fixture.writer_starts), (legacy.OLD, "unless-stopped", 0))
        self.assertEqual({path: path.read_bytes() for path in self.original}, self.original)

    def test_baseline_http_version_failure_preserves_running_writer(self):
        candidate = self.candidate()
        fixture = self.wire_fakes(candidate, fault="baseline-version")
        with self.assertRaises(RuntimeError):
            candidate.main()
        self.assertEqual((fixture.stops, self.app.phase), (0, "preflight"))
        self.assertTrue(fixture.running)
        self.assertFalse(fixture.pin.exists() or fixture.work.exists())
        self.assertEqual({path: path.read_bytes() for path in self.original}, self.original)

    def wire_fakes(self, candidate, fault=None):
        fixture = self.fixture
        fixture.pin = self.prepare_candidate(candidate)
        fixture.base = self.base
        fixture.work = self.app.STATE / "release110-f110n27a"
        fixture.gate = fixture.work / "reviewed-release.json"
        fixture.activation = fixture.work / "activation-authorized.json"
        fixture.accepted = fixture.work / "accepted.json"
        fixture.conditions.extend([f"/usr/bin/test -f {self.base / 'reviewed-release.json'}", self.base_boot])
        self.enterContext(patch.object(self.app, "SCRIPT", candidate.SCRIPT))

        def run(args, **kwargs):
            is_candidate = fixture.container_id == legacy.NEW
            image, revision, run_id, version = ((IMAGE, REV, RUN, "1.1.0") if is_candidate else
                                                (BASE_IMAGE, BASE_REV, "f100n26b", "1.0.0"))
            if args[:3] == ["docker", "image", "inspect"]:
                return {BASE_IMAGE: f"{BASE_IMAGE} {BASE_REV} 1.0.0", IMAGE: f"{IMAGE} {REV} 1.1.0"}[args[-1]]
            if args[:2] == ["docker", "inspect"]:
                template = args[3]
                running = str(fixture.running).lower()
                if template.startswith("{{.Image}} {{.State.Running}}"):
                    return f"{image} {running} healthy {fixture.policy} {revision} {version}"
                if "{{.State.Running}}" in template:
                    return f"{image} {run_id} {running} {fixture.policy}"
                return f"{image} {run_id}"
            if args[:2] == ["systemctl", "start"]:
                fixture.unit_active = fixture.running = True
                if fixture.pin.exists():
                    self.assertTrue(self.app.boot_gate(BOOT, REV, IMAGE, update=candidate.UPDATE))
                    self.assertFalse(self.app.boot_gate(legacy.NEXT_BOOT, REV, IMAGE, update=candidate.UPDATE))
                    fixture.frozen = 'CANON_DEPLOY_FREEZE_WRITES: "true"' in (fixture.work / "image.override.yml").read_text()
                    fixture.container_id, fixture.policy = legacy.NEW, "no"
                    if not fixture.frozen:
                        self.assertIn("frozen-verified.json", fixture.durable[fixture.work])
                        fixture.writer_starts += 1
                else:
                    fixture.container_id, fixture.policy, fixture.frozen = legacy.OLD, "unless-stopped", False
                return ""
            if args[:2] == ["docker", "update"] and args[3] == "unless-stopped":
                self.assertEqual(args[-1], legacy.NEW)
                self.assertTrue(self.app.boot_gate(legacy.NEXT_BOOT, REV, IMAGE, update=candidate.UPDATE))
                self.assertFalse(fixture.accepted.exists())
                fixture.policy = args[3]
                return ""
            if args[:2] == ["docker", "run"] and "scripts/database-backup.ts" in args:
                frozen = "/backup/frozen.json" in args
                self.assertEqual(args[args.index("node") - 1], IMAGE if frozen else BASE_IMAGE)
                translated = [self.app.BASE_IMAGE if arg == BASE_IMAGE else arg for arg in args]
                if "restore" in args:
                    self.assertEqual(args[-2:], ["--prefix", "qa095-110-f110n27a-old-"])
                    translated[-1] = "qa095-100-f100n26b-old-"
                return fixture.backup_command(translated)
            if args[0] == "curl" and args[-1].endswith("/api/version"):
                if fault == "candidate-version" and is_candidate:
                    version = "1.0.0"
                if fault == "baseline-version" and not is_candidate:
                    version = "1.1.0"
                return json.dumps({"version": version, "revision": revision})
            return fixture.run_command(args, **kwargs)

        self.enterContext(patch.object(self.app, "run", run))
        return fixture
