"""Offline fault tests for the one-shot 1.0.0 update."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

import ci_image_load_100 as staging

if os.name == "nt":
    sys.modules.setdefault("fcntl", types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None))


SCRIPT = Path(__file__).with_name("release-100-update.py")


def load_update():
    spec = importlib.util.spec_from_file_location("update100", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REV = "f" * 40
IMAGE = "sha256:" + "e" * 64
RUN = "f100n26b"
BOOT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
NEXT_BOOT = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
OLD = "a" * 64
NEW = "b" * 64
TIMES = ("2026-11-26T02:00:00.000Z", "2026-11-26T02:01:00.000Z")


def save(path, value):
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")
    path.chmod(0o600)


class UpdateFaults(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.app = app = load_update()
        root = Path(self.temp)
        app.STATE = root / "state"
        app.DROPINS = root / "dropins"
        app.REPO = root / "repo"
        app.BOOT_ID_FILE = root / "boot_id"
        app.BOOT_ID_FILE.write_text(BOOT + "\n")
        app.RUNTIME = str(root / "runtime.env")
        Path(app.RUNTIME).write_text("FIXTURE=true\n")
        for path in [app.STATE, app.DROPINS, app.REPO / "deploy"]:
            path.mkdir(parents=True, mode=0o700)
        (app.STATE / "backup096.lock").touch(mode=0o600)
        (app.REPO / "deploy/compose.prod.yml").write_bytes(b"compose")
        app.COMPOSE_SHA256 = hashlib.sha256(b"compose").hexdigest()
        self.work = app.STATE / "release100-f100n26b"
        self.base = app.STATE / "release100-f100n26a"
        self.pin = app.DROPINS / "29-release-100-update.conf"
        self.gate = self.work / "reviewed-release.json"
        self.activation = self.work / "activation-authorized.json"
        self.accepted = self.work / "accepted.json"
        self.stage = self.artifact(REV, IMAGE, 800)
        self.base_stage = self.artifact(app.BASE_REV, app.BASE_IMAGE, 45743522501)
        app.SCRIPT = self.stage / "source/deploy/release-100-update.py"
        self.conditions = []
        for run, name, condition in [
            ("precutover096-f096n23b", "new-writer-attempted.json", "-f"),
            ("precutover096-f096n23b", "new-writer-blocked.json", "! -e"),
            ("ui097-f097n23a", "compat-gate.json", "-f"),
            ("release098-f098n24a", "reviewed-release.json", "-f"),
            ("release098-f098n24b", "reviewed-release.json", "-f"),
            ("release099-f099n24a", "reviewed-release.json", "-f"),
            ("release100-f100n26a", "reviewed-release.json", "-f"),
        ]:
            path = app.STATE / run / name
            path.parent.mkdir(exist_ok=True, mode=0o700)
            if condition == "-f":
                save(path, {})
            self.conditions.append(f"/usr/bin/test {condition} {path}")
        first = app.STATE / "release099-f099n24a"
        prior = self.identity(app.PRIOR_REV, app.PRIOR_IMAGE, "f099n24a", "0.9.9")
        save(first / "reviewed-release.json", prior)
        save(first / "accepted.json", {**prior, "status": "accepted", "restored": True, "inventoryUnchanged": True})
        (first / "before.json").touch(mode=0o600)
        old_config = (
            f'services:\n  app:\n    image: "{app.PRIOR_IMAGE}"\n    restart: "unless-stopped"\n'
            '    labels:\n      canon.release099.run: "f099n24a"\n    environment:\n'
            '      CANON_DEPLOY_FREEZE_WRITES: "false"\n      CANON_DISK_RECOVERY: "true"\n'
        )
        self.override(first / "image.override.yml", old_config)
        for filename in [
            "10-disk-release.conf", "20-release-095.conf", "21-ui-release-095.conf", "22-release-096.conf",
            "23-workflows-096.conf", "24-ui-097.conf", "25-release-098.conf", "26-release-098.conf",
        ]:
            (app.DROPINS / filename).write_text(filename)
        self.pin_for(app.DROPINS / "27-release-099.conf", first, app.PRIOR_REV)
        self.pin_for(app.DROPINS / "28-release-100.conf", self.base, app.BASE_REV)
        original_proof = {
            **self.identity(app.BASE_REV, app.BASE_IMAGE, "f100n26a"),
            "previousRevision": app.PRIOR_REV, "previousImage": app.PRIOR_IMAGE, "previousVersion": "0.9.9",
        }
        receipt = json.loads((self.base_stage / staging.RECEIPT).read_text())
        original_proof.update({key: value for key, value in receipt.items()
                               if key not in {"schema", "revision", "image", "loaded"}})
        save(self.base / "reviewed-release.json", {**original_proof, "migrated": True})
        save(self.base / "accepted.json", {
            **original_proof, "migrated": True, "status": "accepted", "restored": True,
            "inventoryUnchanged": True, "accountTablesEmpty": True,
            "emailAccountsEnabled": False, "yandexOAuthStartVerified": True,
        })
        old_config = (
            f'services:\n  app:\n    image: "{app.BASE_IMAGE}"\n    restart: "unless-stopped"\n'
            '    labels:\n      canon.release100.run: "f100n26a"\n    environment:\n'
            '      CANON_DEPLOY_FREEZE_WRITES: "false"\n      CANON_DISK_RECOVERY: "true"\n'
            '      CAMPUS_EMAIL_ACCOUNTS_ENABLED: "false"\n'
        )
        self.override(self.base / "image.override.yml", old_config)
        self.original_files = {path: path.read_bytes() for path in (*app.DROPINS.iterdir(), *self.base.iterdir())}
        self.running = self.unit_active = True
        self.container_id = OLD
        self.policy = "unless-stopped"
        self.frozen = self.failed = False
        self.foreign = False
        self.stops = self.oauth_open = self.writer_starts = 0
        self.backups = []
        self.direct_stops = 0
        self.rollback_inspects = 0
        self.rollback_ps_calls = 0
        self.inspect_outages = set()
        self.ps_outages = set()
        self.durable = {}
        self.fault = None
        self.enterContext(patch.object(app, "run", self.run_command))
        self.enterContext(patch.object(app, "prop", self.unit_property))
        self.enterContext(patch.object(app, "private", self.private))
        self.enterContext(patch.object(app, "trusted_directories", lambda path: self.private(path, True)))
        self.enterContext(patch.object(app, "trusted_file", self.private))
        self.enterContext(patch.object(app, "fsync_directory", self.sync))
        self.enterContext(patch.object(staging, "private_exact", lambda path, _: self.private(path)))
        real_manifest = staging.tree_manifest
        owner = getattr(os, "geteuid", lambda: 0)()
        self.enterContext(patch.object(staging, "tree_manifest", lambda path: real_manifest(path, owner=owner)))
        self.enterContext(patch.object(os, "geteuid", lambda: 0, create=True))
        self.enterContext(patch.object(os, "statvfs", self.statvfs, create=True))
        self.enterContext(patch.object(os, "umask", lambda *_: 0))
        self.enterContext(patch.object(os, "replace", self.replace))
        self.enterContext(patch.object(sys, "argv", ["release-100-update.py", REV, IMAGE, RUN]))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def artifact(self, revision, image, run_id):
        build = self.app.STATE / f"build100-{revision}"
        source = build / "source"
        for relative, data in {
            "deploy/compose.prod.yml": b"compose",
            "scripts/database-backup.ts": b"backup entry point",
            "lib/database-backup.ts": b"canonical backup format",
            "lib/schema.ts": b"same eleven tables",
            "package.json": b'{"version":"1.0.0"}',
            "unrelated.txt": b"complete Git tree",
        }.items():
            path = source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        if revision == REV:
            (source / "deploy/release-100-update.py").write_bytes(SCRIPT.read_bytes())
        for path in [build, source, *source.rglob("*")]:
            path.chmod(0o700 if path.is_dir() else 0o600)
        archive_path = build / staging.SOURCE_ARCHIVE
        with tarfile.open(archive_path, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": revision}) as archive:
            archive.add(source, arcname="source")
        provenance = {
            "schema": 1, "repository": staging.REPOSITORY, "revision": revision, "image": image,
            "ciWorkflow": staging.WORKFLOW, "ciRunId": run_id, "ciRunAttempt": 1, "ciQualityJobId": 101,
            "ciQualityConclusion": "success", "ciArtifactId": 102, "ciArtifactBytes": 305_000_000,
            "ciArtifactSha256": "sha256:" + "1" * 64, "gzipBytes": 300_000_000, "gzipSha256": "a" * 64,
            "sourceArchiveSha256": staging.hash_file(archive_path),
            "sourceManifestSha256": staging.source_manifest(archive_path, revision),
        }
        save(build / staging.PROVENANCE, provenance)
        save(build / staging.RECEIPT, {**provenance, "loaded": True, "snapshotCommitted": "sha256:" + "b" * 64})
        return build

    @staticmethod
    def identity(revision, image, run, version="1.0.0"):
        return {"revision": revision, "image": image, "run": run, "version": version}

    @staticmethod
    def override(path, contents):
        path.write_bytes(contents.encode())
        path.chmod(0o600)

    def pin_for(self, path, work, revision):
        command = self.compose(work)
        gate = work / "reviewed-release.json"
        self.override(path, f"[Service]\nEnvironment=CAMPUS_RELEASE_TAG={revision}\n"
                      f"Environment=CAMPUS_RUNTIME_ENV_FILE={self.app.RUNTIME}\n"
                      f"ExecCondition=/usr/bin/test -f {gate}\n"
                      f"ExecStart=\nExecStart={command} up --wait --wait-timeout 90\n"
                      f"ExecStop=\nExecStop={command} stop\n")

    @staticmethod
    def compose(work):
        return f"/usr/bin/docker compose --env-file /dev/null -f deploy/compose.prod.yml -f {work / 'image.override.yml'}"

    def private(self, path, directory=False):
        if not (path.is_dir() if directory else path.is_file()) or path.is_symlink():
            raise RuntimeError("invalid private path")

    def statvfs(self, _):
        return types.SimpleNamespace(f_bavail=300_000, f_frsize=4096,
                                     f_favail=0 if self.fault == "low-inodes" else 100_000)

    def sync(self, path):
        if path == self.work and self.accepted.exists() and self.app.phase == "accept-receipt":
            self.fail("receipt-directory-fsync", OSError)
        if path == self.work and self.app.phase == "rollback" and self.fault == "withdrawal-fsync":
            self.fail("withdrawal-fsync", OSError)
        if path == self.app.DROPINS and self.accepted.exists() and self.fault == "after-commit-cleanup":
            self.fail("after-commit-cleanup", InterruptedError)
        self.durable[path] = {item.name for item in path.iterdir()}

    def replace(self, source, destination):
        self.do_replace(source, destination)
        if destination == self.accepted:
            self.fail("receipt-interrupt", InterruptedError)

    do_replace = staticmethod(os.replace)

    def fail(self, phase, error=RuntimeError):
        if self.fault == phase and not self.failed:
            self.failed = True
            raise error("injected " + phase)

    def unit_property(self, name):
        paths = sorted(str(path) for path in self.app.DROPINS.glob("*.conf"))
        work = self.work if self.pin.is_file() else self.base
        commands = {
            "ExecCondition": list(self.conditions),
            "ExecStart": [self.compose(work) + " up --wait --wait-timeout 90"],
            "ExecStop": [self.compose(work) + " stop"],
        }
        if self.pin.is_file():
            commands["ExecCondition"] += [
                f"/usr/bin/test -f {self.gate}",
                f"/usr/bin/python3 -B {self.app.SCRIPT} --boot-gate {BOOT} {REV} {IMAGE}",
            ]
        if self.fault == "dropped-gate":
            commands["ExecCondition"].pop(2)
        properties = {
            "ActiveState": "active" if self.unit_active else "inactive", "NeedDaemonReload": "no",
            "Restart": "no", "WorkingDirectory": str(self.app.REPO), "DropInPaths": " ".join(paths),
        }
        if name in commands:
            return " ".join("{ argv[]=" + item + " ; ignore_errors=no ; }" for item in commands[name])
        return properties[name]

    def assert_unchanged(self):
        self.assertEqual({path: path.read_bytes() for path in self.original_files}, self.original_files)

    def backup_command(self, args):
        operation = next(op for op in ("snapshot", "verify", "restore") if op in args)
        archive = next(arg for arg in args if arg.startswith("/backup/"))
        is_frozen = archive == "/backup/frozen.json"
        image = args[args.index("node") - 1]
        self.assertEqual(image, IMAGE if is_frozen else self.app.BASE_IMAGE)
        self.assertEqual(self.running, is_frozen)
        self.assertEqual(self.gate.exists(), is_frozen)
        self.backups.append((operation, archive))
        self.fail(("frozen-" if is_frozen else "") + operation)
        if operation == "restore":
            self.assertEqual(args[-2:], ["--prefix", "qa095-100-f100n26b-old-"])
        if operation == "verify":
            self.assertIn("none", args)
            self.assertNotIn("--env-file", args)
        else:
            self.assertIn(self.app.RUNTIME, args)
        if operation == "snapshot":
            self.assertIn("--writers-stopped", args)
            tables = []
            for name in sorted(self.app.TABLES):
                items = [{"id": {"S": "fixture"}}]
                if name == "account-sessions":
                    items[0]["expiresAt"] = {"N": "1795659000"}
                    if not is_frozen or self.fault == "unexpected-expiry":
                        items.append({"id": {"S": "elapsed"}, "expiresAt": {"N": "1795658430"}})
                    if is_frozen and self.fault == "active-ttl-loss":
                        items = []
                    if is_frozen and self.fault == "active-ttl-mutated":
                        items[0]["expiresAt"] = {"N": "1795659100"}
                if name == "account-rate-limits" and is_frozen and self.fault == "permanent-ttl-row-loss":
                    items = []
                if is_frozen and name == "knowledge-cards" and self.fault == "old-record-changed":
                    items[0]["body"] = {"S": "changed"}
                if is_frozen and name == "account-identities" and self.fault == "identity-lost":
                    items = []
                content = json.dumps(items)
                tables.append({"name": name, "items": items, "count": len(items), "schema": {"id": "S"},
                               "sha256": hashlib.sha256(content.encode()).hexdigest()})
            save(self.work / archive.split("/")[-1], {
                "version": 1, "scope": "current", "createdAt": TIMES[is_frozen],
                "sourceSha256": ("c" if is_frozen and self.fault == "different-database" else "d") * 64,
                "sha256": "f" * 64 if is_frozen else "e" * 64, "tables": tables,
            })
        payload = json.loads((self.work / archive.split("/")[-1]).read_text())
        counts = {row["name"]: row["count"] for row in payload["tables"]}
        return json.dumps({"status": {"snapshot": "saved", "verify": "verified", "restore": "restored"}[operation],
                           "tables": len(counts), "entries": sum(counts.values()),
                           "tableCounts": counts, "sha256": payload["sha256"]})

    def run_command(self, args, **_kwargs):
        app = self.app
        if args[:2] == ["systemctl", "stop"]:
            self.stops += 1
            self.fail("initial-stop")
            if app.phase == "rollback" and self.fault in {"rollback-stop-timeout", "rollback-unit-stuck"}:
                if self.fault == "rollback-stop-timeout":
                    self.unit_active = False
                raise subprocess.TimeoutExpired(args[:2], 120)
            if app.phase == "rollback" and self.running and self.container_id == OLD:
                self.fail("baseline-restarted")
                raise AssertionError("An already-running accepted writer was sent a rollback stop")
            self.running = self.unit_active = False
            if self.fault == "late-create" and app.phase == "rollback":
                self.container_id, self.running = NEW, True
            return ""
        if args[:2] == ["systemctl", "start"]:
            if self.pin.exists():
                self.assertTrue(app.boot_gate(BOOT, REV, IMAGE))
                self.assertFalse(app.boot_gate(NEXT_BOOT, REV, IMAGE))
                self.pin.read_text().index(str(app.SCRIPT))
                self.frozen = 'CANON_DEPLOY_FREEZE_WRITES: "true"' in (self.work / "image.override.yml").read_text()
                self.policy, self.container_id = "no", NEW
                self.running = True
                if self.frozen:
                    self.fail("frozen-created-but-unhealthy")
                    if self.fault == "late-create":
                        self.container_id, self.running = None, False
                        self.fail("late-create")
                else:
                    self.assertIn("frozen-verified.json", self.durable[self.work])
                    self.writer_starts += 1
                    self.fail("open-start")
            else:
                self.assertFalse(self.activation.exists())
                self.running = True
                self.policy, self.container_id, self.frozen = "unless-stopped", OLD, False
            self.unit_active = True
            return ""
        if args[:2] == ["systemctl", "daemon-reload"]:
            self.assertEqual(self.pin.exists(), self.pin.name in self.durable.get(app.DROPINS, set()))
            if self.pin.exists() and self.fault in {"baseline-restarted", "foreign-restarted"}:
                self.container_id, self.running, self.unit_active = OLD, True, True
                self.foreign = self.fault == "foreign-restarted"
            return ""
        if args[:2] == ["systemctl", "is-active"]:
            return "active"
        if args[:3] == ["docker", "image", "inspect"]:
            image = app.BASE_IMAGE if app.BASE_IMAGE in args else IMAGE
            rev = REV if image == IMAGE else app.BASE_REV
            return f"{image} {rev} 1.0.0"
        if args[:2] == ["docker", "ps"]:
            if any("name=^/kanon" in item for item in args):
                return ""
            if app.phase == "rollback":
                self.rollback_ps_calls += 1
                if self.rollback_ps_calls in self.ps_outages:
                    raise subprocess.TimeoutExpired(args[:2], 30)
            if self.container_id is None or (not self.running and "-a" not in args):
                return ""
            return self.container_id if "-q" in args else f"{self.container_id} {app.APP}"
        if args[:2] == ["docker", "inspect"]:
            image, rev, run_id = (IMAGE, REV, RUN) if self.container_id == NEW else (app.BASE_IMAGE, app.BASE_REV, "f100n26a")
            if self.foreign:
                run_id = "unexpected-run"
            template = args[3]
            if template.startswith("{{.Image}} {{.State.Running}}"):
                status = "unhealthy" if self.container_id == NEW and self.fault == "unhealthy-before-http" else "healthy"
                return f"{image} {str(self.running).lower()} {status} {self.policy} {rev} 1.0.0"
            if template.startswith("{{.Image}}"):
                if app.phase == "rollback":
                    self.rollback_inspects += 1
                    if self.rollback_inspects in self.inspect_outages:
                        raise subprocess.TimeoutExpired(args[:2], 30)
                if "{{.State.Running}}" not in template:
                    return f"{image} {run_id}"
                return f"{image} {run_id} {str(self.running).lower()} {self.policy}"
            if "canon.release100.run" in template:
                return run_id
        if args[:2] == ["docker", "update"]:
            self.assertEqual(args[-1], NEW, "Only the exact candidate may be repinned or stopped")
            if args[3] == "unless-stopped":
                self.assertFalse(self.accepted.exists(), "Final receipt requires live restart-policy validation")
                self.assertIn("activation-authorized.json", self.durable[self.work])
                self.assertTrue(app.boot_gate(NEXT_BOOT, REV, IMAGE))
            else:
                self.assertFalse(self.accepted.exists())
                self.assertFalse(self.activation.exists())
                self.assertFalse(self.gate.exists())
                self.fail("rollback-policy-error")
            self.policy = args[3]
            self.fail("restart-policy")
            return ""
        if args[:3] == ["docker", "container", "stop"]:
            self.assertEqual(args[-1], NEW)
            self.direct_stops += 1
            self.running = False
            return ""
        if args[:2] == ["docker", "run"] and "scripts/database-backup.ts" in args:
            return self.backup_command(args)
        if args[:2] == ["docker", "run"] and "--entrypoint" in args:
            self.assertIn(app.RUNTIME, args)
            if "--network" in args:
                self.fail("runtime")
            elif "DescribeTimeToLiveCommand" in args[-1]:
                self.fail("ttl")
            return ""
        if args[0] == "curl":
            url = args[-1]
            if url.endswith("/api/version"):
                return json.dumps({"version": "1.0.0", "revision": REV if self.container_id == NEW else app.BASE_REV})
            if url.endswith("/api/auth/yandex/callback"):
                self.assertTrue(self.frozen)
                cookie = "\nSet-Cookie: unexpected=1" if self.fault == "head-cookie" and "--head" in args else ""
                return "HTTP/1.1 503\nx-canon-deploy-freeze: writes" + cookie
            if url.endswith("/api/auth/yandex/start"):
                if self.container_id == NEW:
                    self.oauth_open += 1
                    self.fail("oauth-open")
                    if self.fault in {
                        "rollback-stop-timeout", "rollback-unit-stuck", "withdrawal-fsync", "rollback-policy-error",
                    }:
                        raise RuntimeError("injected candidate OAuth failure")
                return ("HTTP/1.1 303\nLocation: https://oauth.yandex.ru/authorize?response_type=code"
                        "&client_id=fixture&code_challenge_method=S256"
                        "&redirect_uri=https%3A%2F%2Fcanon.midis.ru%2Fapi%2Fauth%2Fyandex%2Fcallback"
                        "\nSet-Cookie: __Host-vibecraft-oauth=fixture; Path=/; Secure; HttpOnly; SameSite=Lax"
                        "\nCache-Control: private, no-store\nReferrer-Policy: no-referrer")
            if "-i" in args:
                return "HTTP/1.1 503\nx-canon-deploy-freeze: writes" if self.frozen else "HTTP/1.1 405"
            return '{"status":"ready"}'
        self.fail("unexpected")
        raise AssertionError(f"Unexpected command: {args[:3]}")

    def rejects_preflight(self):
        with self.assertRaises(RuntimeError):
            self.app.main()
        self.assertEqual(self.stops, 0)
        self.assertFalse(self.pin.exists())
        self.assert_unchanged()

    def test_success_allows_elapsed_ttl_row_only_and_uses_one_isolated_restore(self):
        self.app.main()
        self.assertEqual(self.backups, [
            ("snapshot", "/backup/before.json"), ("verify", "/backup/before.json"), ("restore", "/backup/before.json"),
            ("snapshot", "/backup/frozen.json"), ("verify", "/backup/frozen.json"),
        ])
        proof = json.loads(self.accepted.read_text())
        self.assertEqual(proof["previousRevision"], self.app.BASE_REV)
        self.assertTrue(proof["restored"] and proof["inventoryUnchanged"] and proof["yandexOAuthStartVerified"])
        self.assertFalse(proof["emailAccountsEnabled"])
        self.assertEqual((self.policy, self.container_id, self.writer_starts, self.oauth_open), ("unless-stopped", NEW, 1, 1))
        self.assertIn("accepted.json", self.durable[self.work])
        self.assertTrue(self.app.boot_gate(NEXT_BOOT, REV, IMAGE))
        self.assert_unchanged()
        before_retry = self.accepted.read_bytes()
        stops = self.stops
        with self.assertRaises(RuntimeError):
            self.app.main()
        self.assertEqual(self.accepted.read_bytes(), before_retry)
        self.assertEqual(self.stops, stops)

    def test_corrupt_candidate_source_rejected_before_writer_stop(self):
        (self.stage / "source/unrelated.txt").write_text("tampered")
        self.rejects_preflight()

    def test_different_candidate_receipt_rejected_before_writer_stop(self):
        path = self.stage / staging.RECEIPT
        receipt = json.loads(path.read_text())
        save(path, {**receipt, "image": self.app.BASE_IMAGE})
        self.rejects_preflight()

    def test_conflicting_old_28_pin_rejected_before_writer_stop(self):
        path = self.app.DROPINS / "28-release-100.conf"
        path.write_text("unsafe replacement")
        self.original_files[path] = path.read_bytes()
        self.rejects_preflight()

    def test_lost_inherited_gate_rejected_before_writer_stop(self):
        self.fault = "dropped-gate"
        self.rejects_preflight()

    def test_low_inode_budget_rejected_before_writer_stop(self):
        self.fault = "low-inodes"
        self.rejects_preflight()

    def test_runtime_mismatch_rejected_before_writer_stop(self):
        self.fault = "runtime"
        self.rejects_preflight()

    def test_foreign_live_container_rejected_before_writer_stop(self):
        self.foreign = True
        self.rejects_preflight()

    def assert_rollback(self, fault, writer_starts=0):
        self.fault = fault
        with self.assertRaises((RuntimeError, OSError)):
            self.app.main()
        self.assertEqual((self.container_id, self.policy, self.writer_starts), (OLD, "unless-stopped", writer_starts))
        self.assertTrue(self.running and self.unit_active)
        self.assertFalse(self.pin.exists() or self.accepted.exists() or self.activation.exists() or self.gate.exists())
        self.assertEqual(json.loads((self.work / "rollback.json").read_text())["dataRestored"], False)
        self.assert_unchanged()

    def test_before_restore_failure_rolls_back_app_only(self):
        self.assert_rollback("restore")

    def test_existing_account_identity_loss_blocks_opening_writes(self):
        self.assert_rollback("identity-lost")

    def test_active_ttl_row_loss_blocks_opening_writes(self):
        self.assert_rollback("active-ttl-loss")

    def test_active_ttl_row_mutation_blocks_opening_writes(self):
        self.assert_rollback("active-ttl-mutated")

    def test_permanent_row_loss_in_ttl_table_blocks_opening_writes(self):
        self.assert_rollback("permanent-ttl-row-loss")

    def test_frozen_snapshot_including_already_expired_row_is_invalid(self):
        self.assert_rollback("unexpected-expiry")

    def test_old_data_hash_change_blocks_opening_writes(self):
        self.assert_rollback("old-record-changed")

    def test_other_database_blocks_opening_writes(self):
        self.assert_rollback("different-database")

    def test_frozen_head_with_cookie_blocks_opening_writes(self):
        self.assert_rollback("head-cookie")

    def test_frozen_backup_verify_failure_blocks_opening_writes(self):
        self.assert_rollback("frozen-verify")

    def test_failed_systemd_start_does_not_leave_running_frozen_candidate(self):
        self.assert_rollback("frozen-created-but-unhealthy")

    def test_candidate_late_creation_is_detected_after_cancelling_start(self):
        self.assert_rollback("late-create")

    def test_initial_stop_failure_restores_old_app(self):
        self.assert_rollback("initial-stop")

    def test_open_failure_rolls_back_app_only(self):
        self.assert_rollback("open-start", writer_starts=1)

    def test_oauth_start_failure_rolls_back_app_only(self):
        self.assert_rollback("oauth-open", writer_starts=1)

    def test_restart_policy_failure_withdraws_activation_before_rollback(self):
        self.assert_rollback("restart-policy", writer_starts=1)

    def test_interrupt_during_acceptance_rename_withdraws_receipt_first(self):
        self.assert_rollback("receipt-interrupt", writer_starts=1)

    def test_acceptance_directory_fsync_failure_rolls_back(self):
        self.assert_rollback("receipt-directory-fsync", writer_starts=1)

    def test_writer_restarted_during_daemon_reload_blocks_snapshot_without_stopping_old_writer(self):
        self.assert_rollback("baseline-restarted")
        self.assertEqual(self.backups, [])
        self.assertEqual(self.stops, 1)
        self.assertEqual(self.direct_stops, 0)

    def test_rollback_systemd_timeout_falls_back_to_stopping_exact_candidate(self):
        self.assert_rollback("rollback-stop-timeout", writer_starts=1)
        self.assertEqual(self.direct_stops, 1)

    def test_rollback_leaves_unrecognized_running_writer_untouched(self):
        self.fault = "foreign-restarted"
        with self.assertRaises(RuntimeError):
            self.app.main()
        self.assertEqual((self.stops, self.direct_stops, self.backups), (1, 0, []))
        self.assertTrue(self.running and self.pin.exists())
        self.assertTrue((self.work / "rollback-incomplete.json").exists())
        self.assertFalse((self.work / "rollback.json").exists())
        self.assert_unchanged()

    def test_restart_policy_command_failure_does_not_abort_rollback_early(self):
        self.assert_rollback("rollback-policy-error", writer_starts=1)
        self.assertTrue(self.failed)
        self.assertEqual(self.direct_stops, 1)

    def test_first_rollback_inspect_timeout_after_oauth_failure(self):
        self.inspect_outages = {1}
        self.assert_rollback("oauth-open", writer_starts=1)
        self.assertEqual(self.direct_stops, 1)

    def test_second_rollback_inspect_timeout_after_policy_activation(self):
        self.inspect_outages = {2}
        self.assert_rollback("receipt-directory-fsync", writer_starts=1)
        self.assertEqual(self.direct_stops, 1)

    def test_rollback_ps_timeout_after_candidate_health(self):
        self.ps_outages = {1}
        self.assert_rollback("oauth-open", writer_starts=1)
        self.assertEqual(self.direct_stops, 1)

    def test_fresh_discovery_retries_when_failed_start_preknew_no_candidate_id(self):
        self.inspect_outages = {1}
        self.assert_rollback("frozen-created-but-unhealthy")
        self.assertEqual(self.direct_stops, 1)

    def assert_candidate_stopped_with_inspect_unavailable(self, fault):
        self.fault = fault
        self.inspect_outages = set(range(1, 50))
        with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)):
            self.app.main()
        self.assertFalse(self.running)
        self.assertEqual(self.direct_stops, 1)
        self.assertEqual(self.policy, "no")
        self.assertTrue(self.pin.exists() and (self.work / "rollback-incomplete.json").exists())
        self.assertFalse(self.accepted.exists() or self.activation.exists() or (self.work / "rollback.json").exists())

    def test_pinned_candidate_stopped_even_when_all_rollback_inspects_timeout(self):
        self.assert_candidate_stopped_with_inspect_unavailable("receipt-directory-fsync")

    def test_identity_is_remembered_before_candidate_health_can_fail(self):
        self.assert_candidate_stopped_with_inspect_unavailable("unhealthy-before-http")

    def test_systemd_still_active_after_candidate_stop_reports_incomplete(self):
        self.fault = "rollback-unit-stuck"
        with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)):
            self.app.main()
        self.assertEqual(self.direct_stops, 1)
        self.assertFalse(self.running or self.accepted.exists() or self.activation.exists())
        self.assertTrue(self.pin.exists())
        self.assertFalse((self.work / "rollback.json").exists())
        self.assertEqual(json.loads((self.work / "rollback-incomplete.json").read_text())["status"], "rollback-incomplete")

    def test_marker_sync_failure_does_not_prevent_stopping_exact_candidate(self):
        self.assert_rollback("withdrawal-fsync", writer_starts=1)
        self.assertEqual(self.direct_stops, 1)

    def test_reporting_interrupt_after_durable_commit_keeps_accepted_status(self):
        class InterruptedOutput(io.StringIO):
            def write(self, _text):
                raise InterruptedError("injected successful report interruption")

        with contextlib.redirect_stdout(InterruptedOutput()):
            self.app.main()
        self.assertIn("accepted.json", self.durable[self.work])
        self.assertEqual((self.container_id, self.policy), (NEW, "unless-stopped"))
        self.assertFalse((self.work / "rollback.json").exists())

    def test_cleanup_interrupt_after_durable_commit_keeps_accepted_status(self):
        self.fault = "after-commit-cleanup"
        self.app.main()
        self.assertTrue(self.failed)
        self.assertIn("accepted.json", self.durable[self.work])
        self.assertEqual((self.container_id, self.policy), (NEW, "unless-stopped"))
        self.assertFalse((self.work / "rollback.json").exists())
