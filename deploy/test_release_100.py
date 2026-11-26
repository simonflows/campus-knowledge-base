"""Fault-injection checks for the cutover, using temporary files and fake Docker.

Run: python -m unittest discover -s deploy -p 'test_release_100.py'
No SSH, credentials, database or real systemd process is used.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import tarfile
import types
import unittest
from unittest.mock import patch

import ci_image_load_100 as staging

if os.name == "nt":
    sys.modules.setdefault("fcntl", types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None))

SPEC = importlib.util.spec_from_file_location("cutover100", Path(__file__).with_name("release-100.py"))
REV = "f" * 40
IMAGE = "sha256:" + "e" * 64
RUN_ID = "f100n26a"
MIGRATION_ID = "d" * 64


class CutoverFaults(unittest.TestCase):
    def simulate(self, fault=None):
        app = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(app)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app.REPO = root / "repo"
            app.STATE = root / "state"
            app.DROPINS = root / "dropins"
            app.PIN = app.DROPINS / "28-release-100.conf"
            app.BASE_OVERRIDE = app.STATE / "old.yml"
            app.BASE_GATE = app.STATE / "old-gate.json"
            app.ANCESTOR_GATE = app.STATE / "097-gate.json"
            app.BASE_ACCEPTED = app.STATE / "accepted.json"
            app.BASE_BACKUP = app.STATE / "last-backup.json"
            app.FIRST_098_GATE = app.STATE / "098a-gate.json"
            app.SECOND_098_GATE = app.STATE / "098b-gate.json"
            app.TOMBSTONE_ATTEMPTED = app.STATE / "096-attempted.json"
            app.TOMBSTONE_BLOCKED = app.STATE / "096-blocked.json"
            app.COMPOSE_SHA256 = hashlib.sha256(b"same compose").hexdigest()
            build = app.STATE / f"build100-{REV}"
            work = app.STATE / f"release100-{RUN_ID}"
            for path in [app.REPO / "deploy", app.STATE, app.DROPINS, build / "source/deploy"]:
                path.mkdir(parents=True, exist_ok=True)
            accepted_override = (f'services:\n  app:\n    image: "{app.BASE_IMAGE}"\n    restart: "unless-stopped"\n'
                                 f'    labels:\n      canon.release099.run: "{app.BASE_RUN}"\n    environment:\n'
                                 '      CANON_DEPLOY_FREEZE_WRITES: "false"\n      CANON_DISK_RECOVERY: "true"\n')
            app.BASE_OVERRIDE.write_bytes((accepted_override.replace('FREEZE_WRITES: "false"', 'FREEZE_WRITES: "true"')
                                          if fault == "baseline-override" else accepted_override).encode())
            base_proof = {"revision": app.BASE_REV, "image": app.BASE_IMAGE, "run": app.BASE_RUN,
                          "version": app.BASE_VERSION}
            app.BASE_GATE.write_text(json.dumps(base_proof if fault != "baseline-gate" else {**base_proof, "image": IMAGE}))
            app.ANCESTOR_GATE.write_text("older compatible gate")
            app.TOMBSTONE_ATTEMPTED.write_text("compatible writer attempted")
            if fault != "missing-098a-gate":
                app.FIRST_098_GATE.write_text("prior accepted 0.9.8")
            if fault != "missing-098b-gate":
                app.SECOND_098_GATE.write_text("later accepted 0.9.8")
            if fault == "blocked-baseline":
                app.TOMBSTONE_BLOCKED.touch()
            app.BASE_BACKUP.write_text("prior backup")
            app.BASE_ACCEPTED.write_text(json.dumps({
                "status": "pending" if fault == "baseline-proof" else "accepted",
                **base_proof,
                "restored": True, "inventoryUnchanged": True,
            }))
            (app.STATE / "backup096.lock").touch()
            compose = "changed identically" if fault == "changed-compose" else "same compose"
            (app.REPO / "deploy/compose.prod.yml").write_text(compose)
            (build / "source/deploy/compose.prod.yml").write_text(compose)
            (build / "source/package.json").write_text(json.dumps({
                "version": app.BASE_VERSION if fault == "wrong-source-version" else app.RELEASE_VERSION,
            }))
            (build / "source/unrelated.txt").write_text("This file is part of the complete source tree.")
            for path in (build / "source").rglob("*"):
                path.chmod(0o700 if path.is_dir() else 0o600)
            (build / "source").chmod(0o700)
            package = build / staging.SOURCE_ARCHIVE
            with tarfile.open(package, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": REV}) as archive:
                archive.add(build / "source", arcname="source")
            provenance = {"schema": 1, "repository": staging.REPOSITORY, "revision": REV, "image": IMAGE,
                          "ciWorkflow": staging.WORKFLOW, "ciRunId": 100, "ciRunAttempt": 1,
                          "ciQualityJobId": 101, "ciQualityConclusion": "success", "ciArtifactId": 102,
                          "ciArtifactBytes": 305_000_000, "ciArtifactSha256": "sha256:" + "1" * 64,
                          "gzipBytes": 300_000_000, "gzipSha256": "a" * 64,
                          "sourceArchiveSha256": staging.hash_file(package),
                          "sourceManifestSha256": staging.source_manifest(package, REV)}
            (build / staging.PROVENANCE).write_text(json.dumps(provenance))
            load_proof = {**provenance, "loaded": True, "snapshotCommitted": "sha256:" + "b" * 64}
            if fault == "bad-image-receipt":
                load_proof["image"] = app.BASE_IMAGE
            elif fault == "bad-gzip-receipt":
                load_proof["gzipSha256"] = ""
            elif fault == "bad-commit-receipt":
                load_proof["snapshotCommitted"] = "overlay pending"
            elif fault == "changed-staged-tree":
                (build / "source/unrelated.txt").write_text("edited without touching Compose or package.json")
            elif fault == "sparse-staged-tree":
                (build / "source/unrelated.txt").unlink()
            if fault != "missing-image-receipt":
                (build / staging.RECEIPT).write_text(json.dumps(load_proof))
            if fault == "reuse-run":
                work.mkdir()
                (work / "reviewed-release.json").write_text("earlier run")
            for name in app.OLD_NAMES:
                (app.DROPINS / name).write_text("original " + name)
            old_command = " ".join(app.COMPOSE + ["-f", str(app.BASE_OVERRIDE)])
            accepted_pin = (f"[Service]\nEnvironment=CAMPUS_RELEASE_TAG={app.BASE_REV}\n"
                            f"Environment=CAMPUS_RUNTIME_ENV_FILE={app.RUNTIME}\n"
                            f"ExecCondition=/usr/bin/test -f {app.BASE_GATE}\nExecStart=\n"
                            f"ExecStart={old_command} up --wait --wait-timeout 90\nExecStop=\n"
                            f"ExecStop={old_command} stop\n")
            (app.DROPINS / "27-release-099.conf").write_bytes(
                (accepted_pin.replace(app.RUNTIME, "/invalid/runtime.env") if fault == "baseline-pin" else accepted_pin).encode())
            initial = {p: p.read_bytes() for p in app.DROPINS.iterdir()}
            original_override = app.BASE_OVERRIDE.read_bytes()
            state = {"image": app.BASE_IMAGE, "active": True, "failed": False,
                     "restore": False, "frozen": False, "policy": "unless-stopped", "stops": 0,
                     "backup_operations": [], "migrated": False,
                     "migration_container": fault == "foreign-migration",
                     "migration_removals": 0, "new_writer_starts": 0,
                     "oauth_runtime_verified": False, "oauth_rollback_injected": False,
                     "oauth_frozen_in_migration": False, "oauth_frozen_in_override": False,
                     "oauth_callbacks": [], "oauth_starts": 0, "durable_names": {}}

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
                    state["stops"] += 1
                    fail_once("stop-writers")
                    state["active"] = False
                    if fault == "late-create" and app.phase == "rollback":
                        state["image"] = IMAGE
                        state["docker_running"] = True
                elif args[:2] == ["systemctl", "start"]:
                    if app.PIN.exists():
                        self.assertTrue((work / "reviewed-release.json").is_file())
                        self.assertIn("reviewed-release.json", state["durable_names"][work])
                        self.assertTrue(state["migrated"] and not state["migration_container"])
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
                        if not state["frozen"]:
                            self.assertTrue((work / "frozen-verified.json").exists())
                            self.assertIn("frozen-verified.json", state["durable_names"][work])
                            state["new_writer_starts"] += 1
                            if fault == "unfreeze":
                                state["docker_running"] = True
                                fail_once("unfreeze")
                    else:
                        state["image"] = app.BASE_IMAGE
                        state["policy"] = "unless-stopped"
                        state["frozen"] = False
                    state["active"] = True
                elif args[:2] == ["systemctl", "daemon-reload"]:
                    self.assertEqual(app.PIN.name in state["durable_names"].get(app.DROPINS, set()), app.PIN.exists())
                elif args[:3] == ["systemctl", "is-active", "kanon-runtime.service"]:
                    return "active"
                elif args[:2] == ["docker", "run"] and "--entrypoint" in args:
                    self.assertIn("none", args)
                    self.assertIn(app.RUNTIME, args)
                    state["oauth_rollback_injected"] = fault == "incomplete-oauth-runtime"
                    fail_once("incomplete-oauth-runtime")
                    state["oauth_runtime_verified"] = True
                elif args[:3] == ["docker", "image", "inspect"]:
                    candidate = args[-1] == IMAGE
                    version = app.RELEASE_VERSION if candidate and fault != "wrong-version" else app.BASE_VERSION
                    return f"{IMAGE if candidate else app.BASE_IMAGE} {REV if candidate else app.BASE_REV} {version}"
                elif args[:2] == ["docker", "ps"]:
                    if f"name=^/kanon100-{RUN_ID}-migrate$" in args:
                        return MIGRATION_ID if state["migration_container"] else ""
                    if any("kanon100-" in a for a in args):
                        return ""
                    if "-q" in args:
                        return "id" if state["image"] and (state["active"] or state.get("docker_running") or "-a" in args) else ""
                    return f"{'c' * 64} {app.APP}" if state["image"] else ""
                elif args[:2] == ["docker", "inspect"]:
                    if args[-1] == MIGRATION_ID:
                        self.assertTrue(state["migration_container"])
                        if fault == "foreign-migration":
                            return f"{app.BASE_IMAGE} other-run unrelated app no"
                        return f"{IMAGE} {RUN_ID} campus-kb-migrate-{RUN_ID} app no"
                    if state["image"] is None:
                        raise RuntimeError("container absent")
                    fmt = args[3]
                    if fmt == "{{.Id}}":
                        return "c" * 64
                    if fmt == "{{.Image}}":
                        return state["image"]
                    if fmt.startswith("{{.Image}} {{index"):
                        return f"{state['image']} {RUN_ID}"
                    if "canon.release099.run" in fmt:
                        self.assertEqual(state["image"], app.BASE_IMAGE, "Baseline label applies only to 0.9.9")
                        return "other-run" if fault == "baseline-label" else app.BASE_RUN
                    if "canon.release100.run" in fmt:
                        self.assertEqual(state["image"], IMAGE, "Candidate label applies only to 1.0.0")
                        return RUN_ID
                    candidate = state["image"] == IMAGE
                    return (f"{state['image']} true healthy {state['policy']} "
                            f"{REV if candidate else app.BASE_REV} {app.RELEASE_VERSION if candidate else app.BASE_VERSION}")
                elif args[:2] == ["docker", "update"]:
                    if args[3] == "unless-stopped":
                        fail_once("restart-policy-update")
                    state["policy"] = args[3]
                elif args[:3] == ["docker", "container", "stop"]:
                    state["docker_running"] = False
                elif args[:3] == ["docker", "rm", "-f"]:
                    self.assertEqual(args[-1], MIGRATION_ID, "Only the exact migration container may be removed")
                    state["migration_removals"] += 1
                    fail_once("migration-cleanup")
                    state["migration_container"] = False
                elif args[:2] == ["/usr/bin/docker", "compose"]:
                    self.assertIn(f"campus-kb-migrate-{RUN_ID}", args)
                    self.assertFalse(state["active"], "DDL must never run with a serving writer")
                    self.assertTrue(app.PIN.exists())
                    self.assertFalse((work / "reviewed-release.json").exists(), "Boot must stay closed during DDL")
                    self.assertEqual(state["backup_operations"], [
                        (app.BASE_IMAGE, "snapshot"), (app.BASE_IMAGE, "verify"), (app.BASE_IMAGE, "restore"),
                    ])
                    spec = json.loads(Path(args[args.index("-f") + 1]).read_text())["services"]["app"]
                    self.assertEqual(spec["image"], IMAGE)
                    self.assertEqual(spec["env_file"], [{"path": app.RUNTIME, "format": "raw"}])
                    self.assertNotIn("ports", spec)
                    self.assertTrue(spec["read_only"])
                    self.assertEqual(spec["restart"], "no")
                    self.assertEqual(spec["cap_drop"], ["ALL"])
                    self.assertEqual(spec["environment"]["CANON_DEPLOY_FREEZE_WRITES"], "true")
                    self.assertEqual(spec["environment"]["CANON_DISK_RECOVERY"], "false")
                    self.assertEqual(spec["environment"]["CAMPUS_EMAIL_ACCOUNTS_ENABLED"], "false")
                    state["oauth_frozen_in_migration"] = spec["environment"].get("CAMPUS_YANDEX_OAUTH_ENABLED") == "false"
                    self.assertEqual(spec["entrypoint"], ["node", "-e", "setInterval(() => {}, 60000)"])
                    if args[-4:] == ["up", "-d", "--no-deps", "app"]:
                        state["migration_container"] = True
                        fail_once("migration-up")
                    else:
                        self.assertEqual(args[-6:], ["exec", "-T", "app", "npm", "run", "db:migrate"])
                        self.assertTrue(state["migration_container"])
                        state["migrated"] = True
                        fail_once("migration-exec")
                elif args[:2] == ["docker", "run"]:
                    operation = args[-2] if "verify" in args else "restore" if "restore" in args else "snapshot"
                    backup_image = args[args.index("node") - 1]
                    candidate = "/backup/frozen.json" in args
                    self.assertEqual(backup_image, IMAGE if candidate else app.BASE_IMAGE)
                    self.assertEqual(state["migrated"], candidate, "Backups must straddle the DDL")
                    self.assertEqual(state["active"], candidate, "Pre-DDL backup needs every writer stopped")
                    self.assertFalse(state["migration_container"])
                    state["backup_operations"].append((backup_image, operation))
                    fail_once(("candidate-" if candidate else "") + operation)
                    tables = app.RELEASE_TABLES if candidate else app.BASE_TABLES
                    if candidate and fault == "wrong-new-inventory":
                        tables = app.BASE_TABLES
                    counts = dict.fromkeys(sorted(tables), 0)
                    counts["knowledge-cards"] = 27
                    if candidate and fault == "unexpected-account":
                        counts["account-identities"] = 1
                    digest = ("b" if candidate else "a") * 64
                    if "restore" in args:
                        self.assertEqual(args[-2:], ["--prefix", f"qa095-100-{RUN_ID}-{'new' if candidate else 'old'}-"])
                        state["restore"] = True
                    if operation == "verify":
                        self.assertIn("--network", args)
                        self.assertIn("none", args)
                        self.assertNotIn("--env-file", args)
                    else:
                        self.assertEqual(args[args.index("--env-file") + 1], app.RUNTIME)
                    if "snapshot" in args:
                        self.assertIn("--writers-stopped", args)
                        rows = [{"name": name, "count": count, "sha256": hashlib.sha256(name.encode()).hexdigest()}
                                for name, count in counts.items()]
                        if candidate and fault == "inventory-mismatch":
                            next(row for row in rows if row["name"] == "knowledge-cards")["sha256"] = "d" * 64
                        source = ("f" if candidate and fault == "changed-source" else "e") * 64
                        archive = {"scope": "current", "sha256": digest, "sourceSha256": source, "tables": rows}
                        (work / ("frozen.json" if candidate else "before.json")).write_text(json.dumps(archive))
                    status = {"snapshot": "saved", "verify": "verified", "restore": "restored"}[operation]
                    if fault == "verify-status" and operation == "verify":
                        status = "saved"
                    return json.dumps({"status": status, "sha256": digest, "tables": len(counts),
                                       "entries": sum(counts.values()), "tableCounts": counts})
                elif args[0] == "curl":
                    if "--resolve" in args and fault == "trusted-https":
                        raise RuntimeError("injected TLS handshake failure")
                    if "-i" in args:
                        if args[-1].endswith("/api/auth/yandex/callback"):
                            self.assertTrue(state["frozen"], "Only frozen callback may be probed")
                            method = "HEAD" if "--head" in args else "GET"
                            state["oauth_callbacks"].append(method)
                            if fault == "head-callback-writes" and method == "HEAD":
                                return "HTTP/1.1 503\nx-canon-deploy-freeze: writes\nset-cookie: unexpected=1"
                            return "HTTP/1.1 503\nx-canon-deploy-freeze: writes"
                        if args[-1].endswith("/api/auth/yandex/start"):
                            self.assertFalse(state["frozen"])
                            self.assertTrue((work / "frozen-verified.json").is_file())
                            state["oauth_starts"] += 1
                            if fault == "oauth-start-unavailable":
                                return "HTTP/1.1 503"
                            return ("HTTP/1.1 303\nLocation: https://oauth.yandex.ru/authorize?response_type=code"
                                    "&client_id=configured&code_challenge_method=S256"
                                    "&redirect_uri=https%3A%2F%2Fcanon.midis.ru%2Fapi%2Fauth%2Fyandex%2Fcallback"
                                    "\nSet-Cookie: __Host-vibecraft-oauth=fixture; Path=/; Secure; HttpOnly; SameSite=lax"
                                    "\nCache-Control: private, no-store\nReferrer-Policy: no-referrer")
                        if state["frozen"] and fault == "freeze-body-header":
                            return "HTTP/1.1 503\r\n\r\nx-canon-deploy-freeze: writes"
                        return "HTTP/1.1 503\nx-canon-deploy-freeze: writes" if state["frozen"] else "HTTP/1.1 405"
                    if args[-1].endswith("/api/version"):
                        return json.dumps({"version": app.RELEASE_VERSION if state["image"] == IMAGE else app.BASE_VERSION,
                                           "revision": REV if state["image"] == IMAGE else app.BASE_REV})
                    return '{"status":"ready"}'
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
                    if state["frozen"]:
                        state["oauth_frozen_in_override"] = 'CAMPUS_YANDEX_OAUTH_ENABLED: "false"' in Path(src).read_text()
                actual_replace(src, dst)
                if Path(dst) == work / "accepted.json" and fault == "accept-replace-interrupt":
                    raise InterruptedError("injected after actual acceptance rename")

            def command(name, commands):
                if name == "ExecCondition":
                    expected = [
                        f"/usr/bin/test -f {app.TOMBSTONE_ATTEMPTED}",
                        f"/usr/bin/test ! -e {app.TOMBSTONE_BLOCKED}",
                        f"/usr/bin/test -f {app.ANCESTOR_GATE}",
                        f"/usr/bin/test -f {app.FIRST_098_GATE}",
                        f"/usr/bin/test -f {app.SECOND_098_GATE}",
                        f"/usr/bin/test -f {app.BASE_GATE}",
                    ]
                    if app.PIN.exists():
                        expected.append(f"/usr/bin/test -f {work / 'reviewed-release.json'}")
                    self.assertEqual(commands, expected, "Every previously accepted boot gate must remain")

            def private(path, directory=False):
                if not (path.is_dir() if directory else path.is_file()) or path.is_symlink():
                    raise RuntimeError("invalid private file")

            def statvfs(_):
                return types.SimpleNamespace(f_bavail=0 if fault == "low-space" else 300_000, f_frsize=4096,
                                             f_favail=100_000)

            def fsync_directory(path):
                state["durable_names"][path] = {item.name for item in path.iterdir()}

            actual_tree_manifest = staging.tree_manifest
            owner = getattr(os, "geteuid", lambda: 0)()
            with patch.object(app, "run", fake_run), patch.object(app, "prop", prop), \
                 patch.object(app, "write", write), \
                 patch.object(app, "private", private), patch.object(app, "command", command), \
                 patch.object(app, "trusted_directories", lambda path: private(path, directory=True)), \
                 patch.object(app, "fsync_directory", fsync_directory), \
                 patch.object(staging, "private_exact", lambda path, _: private(path)), \
                 patch.object(staging, "tree_manifest", lambda path: actual_tree_manifest(path, owner=owner)), \
                 patch.object(app.os, "statvfs", statvfs, create=True), \
                 patch.object(app.os, "geteuid", lambda: 0, create=True), \
                 patch.object(app.os, "umask", lambda *_: 0), patch.object(app.os, "replace", replace), \
                 patch.object(sys, "argv", ["release-100.py", REV, IMAGE, "wrongrun" if fault == "wrong-run" else RUN_ID]), \
                 contextlib.redirect_stdout(io.StringIO()):
                if fault and fault != "actual-retry":
                    with self.assertRaises(Exception):
                        app.main()
                    self.assertTrue(state["active"], "Previous compatible release must run after failure")
                    self.assertEqual(state["image"], app.BASE_IMAGE)
                    self.assertFalse(app.PIN.exists())
                    if fault in ["baseline-proof", "baseline-gate", "baseline-override", "baseline-pin",
                                 "changed-compose", "missing-098a-gate", "missing-098b-gate",
                                 "blocked-baseline", "baseline-label", "low-space", "trusted-https",
                                 "wrong-version", "wrong-source-version", "wrong-run", "reuse-run",
                                 "foreign-migration", "missing-image-receipt",
                                 "bad-image-receipt", "bad-gzip-receipt", "bad-commit-receipt",
                                 "changed-staged-tree", "sparse-staged-tree", "incomplete-oauth-runtime"]:
                        self.assertEqual(state["stops"], 0, "Untrusted rollback baseline must fail before writer stop")
                        if fault == "incomplete-oauth-runtime":
                            self.assertTrue(state["oauth_rollback_injected"])
                    elif fault != "partial-pin":
                        rollback = json.loads((work / "rollback.json").read_text())
                        self.assertFalse(rollback["dataRestored"], "Rollback must never restore production data")
                        self.assertFalse((work / "accepted.json").exists())
                        self.assertNotIn("accepted.json", state["durable_names"][work])
                        self.assertIn("rollback.json", state["durable_names"][work])
                        self.assertFalse(state["migration_container"])
                        if fault in ["unfreeze", "restart-policy-update", "accept-replace-interrupt",
                                     "oauth-start-unavailable"]:
                            self.assertTrue((work / "frozen-verified.json").exists())
                            self.assertEqual(state["new_writer_starts"], 1)
                        else:
                            self.assertEqual(state["new_writer_starts"], 0)
                else:
                    app.main()
                    self.assertEqual(state["image"], IMAGE)
                    self.assertEqual(state["policy"], "unless-stopped")
                    self.assertTrue(state["restore"])
                    self.assertTrue(state["migrated"])
                    self.assertEqual(state["migration_removals"], 1)
                    self.assertFalse(state["migration_container"])
                    self.assertEqual(state["new_writer_starts"], 1)
                    self.assertTrue(state["oauth_runtime_verified"])
                    self.assertTrue(state["oauth_frozen_in_migration"])
                    self.assertTrue(state["oauth_frozen_in_override"])
                    self.assertIn("GET", state["oauth_callbacks"])
                    self.assertIn("HEAD", state["oauth_callbacks"])
                    self.assertEqual(state["oauth_starts"], 1)
                    accepted = json.loads((work / "accepted.json").read_text())
                    self.assertTrue(accepted["accountTablesEmpty"])
                    self.assertFalse(accepted["emailAccountsEnabled"])
                    self.assertTrue(accepted["yandexOAuthStartVerified"])
                    self.assertIn("accepted.json", state["durable_names"][work])
                    self.assertEqual(accepted["gzipSha256"], load_proof["gzipSha256"])
                    self.assertEqual(accepted["snapshotCommitted"], load_proof["snapshotCommitted"])
                    self.assertEqual(accepted["baselineTableCounts"].keys(), app.BASE_TABLES)
                    self.assertEqual(accepted["candidateTableCounts"].keys(), app.RELEASE_TABLES)
                    self.assertIn('CAMPUS_EMAIL_ACCOUNTS_ENABLED: "false"', (work / "image.override.yml").read_text())
                    if fault == "actual-retry":
                        original = (work / "accepted.json").read_bytes()
                        stops = state["stops"]
                        with self.assertRaises(RuntimeError):
                            app.main()
                        self.assertEqual(state["stops"], stops)
                        self.assertEqual((work / "accepted.json").read_bytes(), original)
            self.assertEqual({p: p.read_bytes() for p in initial}, initial)
            self.assertEqual(app.BASE_OVERRIDE.read_bytes(), original_override)
            if fault == "reuse-run":
                self.assertEqual((work / "reviewed-release.json").read_text(), "earlier run")
            return state, app.BASE_IMAGE

    def test_unaccepted_baseline_stops_before_writers(self):
        self.simulate("baseline-proof")

    def test_conflicting_baseline_review_gate_stops_before_writers(self):
        self.simulate("baseline-gate")

    def test_changed_baseline_override_stops_before_writers(self):
        self.simulate("baseline-override")

    def test_changed_baseline_runtime_pin_stops_before_writers(self):
        self.simulate("baseline-pin")

    def test_compose_must_match_reviewed_checksum_even_when_local_copies_agree(self):
        self.simulate("changed-compose")

    def test_missing_earlier_098_boot_gate_stops_before_writers(self):
        self.simulate("missing-098a-gate")

    def test_missing_later_098_boot_gate_stops_before_writers(self):
        self.simulate("missing-098b-gate")

    def test_blocked_096_writer_gate_stops_before_writers(self):
        self.simulate("blocked-baseline")

    def test_rollback_baseline_has_exact_099_run_label(self):
        self.simulate("baseline-label")

    def test_insufficient_space_stops_before_writers(self):
        self.simulate("low-space")

    def test_trusted_https_failure_stops_before_writers(self):
        self.simulate("trusted-https")

    def test_wrong_candidate_image_version_stops_before_writers(self):
        self.simulate("wrong-version")

    def test_wrong_staged_source_version_stops_before_writers(self):
        self.simulate("wrong-source-version")

    def test_other_run_id_stops_before_writers(self):
        self.simulate("wrong-run")

    def test_existing_run_cannot_overwrite_evidence(self):
        self.simulate("reuse-run")

    def test_successful_run_cannot_be_repeated(self):
        self.simulate("actual-retry")

    def test_import_receipt_requires_exact_image_hash_and_committed_snapshot(self):
        for fault in ["missing-image-receipt", "bad-image-receipt", "bad-gzip-receipt", "bad-commit-receipt"]:
            with self.subTest(fault=fault):
                self.simulate(fault)

    def test_partial_or_modified_staged_source_stops_before_writer_stop(self):
        for fault in ["changed-staged-tree", "sparse-staged-tree"]:
            with self.subTest(fault=fault):
                self.simulate(fault)

    def test_incomplete_runtime_oauth_stops_before_stopping_writers(self):
        self.simulate("incomplete-oauth-runtime")

    def test_frozen_head_callback_cannot_set_a_cookie(self):
        self.simulate("head-callback-writes")

    def test_oauth_start_is_required_for_acceptance(self):
        self.simulate("oauth-start-unavailable")

    def test_freeze_probe_requires_real_response_header(self):
        self.simulate("freeze-body-header")

    def test_wrong_snapshot_verify_status_rolls_back(self):
        self.simulate("verify-status")

    def test_success_requires_restore_and_preserves_old_release(self):
        self.simulate()

    def test_backup_uses_the_schema_owned_by_each_image(self):
        state, baseline_image = self.simulate()
        self.assertEqual(state["backup_operations"], [
            (baseline_image, "snapshot"), (baseline_image, "verify"), (baseline_image, "restore"),
            (IMAGE, "snapshot"), (IMAGE, "verify"), (IMAGE, "restore"),
        ])

    def test_snapshot_failure_restores_baseline(self):
        self.simulate("snapshot")

    def test_restore_failure_restores_baseline(self):
        self.simulate("restore")

    def test_writer_stop_failure_restores_baseline_without_ddl(self):
        state, _ = self.simulate("stop-writers")
        self.assertFalse(state["migrated"])

    def test_foreign_migration_container_is_never_adopted_or_removed(self):
        state, _ = self.simulate("foreign-migration")
        self.assertTrue(state["migration_container"])
        self.assertEqual(state["migration_removals"], 0)

    def test_migration_failures_restore_compatible_writer_and_only_remove_own_container(self):
        for fault in ["migration-up", "migration-exec", "migration-cleanup"]:
            with self.subTest(fault=fault):
                state, _ = self.simulate(fault)
                self.assertGreaterEqual(state["migration_removals"], 1)
                self.assertEqual(state["new_writer_starts"], 0)
                if fault in ["migration-exec", "migration-cleanup"]:
                    self.assertTrue(state["migrated"], "Rollback must keep any additive schema changes")

    def test_new_schema_backup_and_restore_failures_prevent_opening_writes(self):
        for fault in ["candidate-snapshot", "candidate-verify", "candidate-restore", "wrong-new-inventory"]:
            with self.subTest(fault=fault):
                self.simulate(fault)

    def test_source_mismatch_or_unexpected_new_account_prevents_opening_writes(self):
        for fault in ["changed-source", "unexpected-account"]:
            with self.subTest(fault=fault):
                self.simulate(fault)

    def test_unfreeze_failure_keeps_frozen_proof_and_restores_application_without_data_restore(self):
        for fault in ["unfreeze", "restart-policy-update"]:
            with self.subTest(fault=fault):
                self.simulate(fault)

    def test_interruption_after_acceptance_rename_cannot_leave_a_false_acceptance(self):
        self.simulate("accept-replace-interrupt")

    def test_inventory_difference_prevents_reopening_writes(self):
        self.simulate("inventory-mismatch")

    def test_missing_container_after_failed_create_restores_baseline(self):
        self.simulate("missing-container")

    def test_partial_pin_write_does_not_leave_systemd_broken(self):
        self.simulate("partial-pin")

    def test_failed_start_leaving_running_candidate_restores_baseline(self):
        self.simulate("failed-running-start")

    def test_late_container_creation_during_stop_is_rechecked(self):
        self.simulate("late-create")


if __name__ == "__main__":
    unittest.main()
