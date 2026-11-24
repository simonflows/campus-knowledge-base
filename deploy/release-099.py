#!/usr/bin/env python3
"""One-shot 0.9.9 cutover from the accepted 0.9.8 f098n24b baseline.

No runtime credential is read by this program. Docker passes the protected env
file directly to the existing application backup CLI. Records stay root-only.
"""
import fcntl
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

BASE_REV = "57c7e56d2ac4da9f95cde3f0edcaed4b6e720da7"
BASE_IMAGE = "sha256:42f29efef056f19e16c05846eec03452b25724776e73b9b655ed768bec6d115a"
BASE_VERSION = "0.9.8"
BASE_RUN = "f098n24b"
RELEASE_VERSION = "0.9.9"
RELEASE_RUN = "f099n24a"
COMPOSE_SHA256 = "b41a16d54e83889f543f94ab57e381bace71f10f52c0fb6b678557c1a9ab9fa7"
REPO = Path("/opt/campus-knowledge-base/app")
STATE = Path("/var/lib/canon")
RUNTIME = "/run/campus/runtime.env"
APP = "campus-kb-prod-app-1"
UNIT = "kanon.service"
DROPINS = Path("/etc/systemd/system/kanon.service.d")
PIN = DROPINS / "27-release-099.conf"
BASE_OVERRIDE = STATE / "release098-f098n24b/image.override.yml"
BASE_GATE = STATE / "release098-f098n24b/reviewed-release.json"
BASE_ACCEPTED = STATE / "release098-f098n24b/accepted.json"
BASE_BACKUP = STATE / "release098-f098n24b/before.json"
FIRST_098_GATE = STATE / "release098-f098n24a/reviewed-release.json"
ANCESTOR_GATE = STATE / "ui097-f097n23a/compat-gate.json"
TOMBSTONE_ATTEMPTED = STATE / "precutover096-f096n23b/new-writer-attempted.json"
TOMBSTONE_BLOCKED = STATE / "precutover096-f096n23b/new-writer-blocked.json"
OLD_NAMES = ["10-disk-release.conf", "20-release-095.conf", "21-ui-release-095.conf",
             "22-release-096.conf", "23-workflows-096.conf", "24-ui-097.conf", "25-release-098.conf",
             "26-release-098.conf"]
COMPOSE = ["/usr/bin/docker", "compose", "--env-file", "/dev/null", "-f", "deploy/compose.prod.yml"]
phase = "arguments"


def check(ok):
    if not ok:
        raise RuntimeError("gate")


def run(args, timeout=30, cwd=REPO):
    # Never surface arbitrary subprocess output (application errors can contain data).
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=True)
    return result.stdout.decode().strip()


def private(path, directory=False):
    s = path.lstat()
    check(not path.is_symlink() and s.st_uid == 0)
    check((s.st_mode & 0o777) == (0o700 if directory else 0o600))
    check(path.is_dir() if directory else path.is_file())


def baseline_config():
    """Bind rollback to the exact startup configuration of the accepted 0.9.8."""
    for path in [TOMBSTONE_ATTEMPTED, ANCESTOR_GATE, FIRST_098_GATE, BASE_GATE, BASE_OVERRIDE, BASE_ACCEPTED]:
        private(path)
    check(not TOMBSTONE_BLOCKED.exists() and not TOMBSTONE_BLOCKED.is_symlink())
    baseline = json.loads(BASE_ACCEPTED.read_text())
    check(baseline.get("status") == "accepted" and baseline.get("revision") == BASE_REV and
          baseline.get("image") == BASE_IMAGE and baseline.get("run") == BASE_RUN and
          baseline.get("restored") is True and baseline.get("inventoryUnchanged") is True)
    pin = DROPINS / "26-release-098.conf"
    private(pin)
    expected_override = (f'services:\n  app:\n    image: "{BASE_IMAGE}"\n    restart: "unless-stopped"\n'
                         f'    labels:\n      canon.release098.run: "{BASE_RUN}"\n    environment:\n'
                         '      CANON_DEPLOY_FREEZE_WRITES: "false"\n      CANON_DISK_RECOVERY: "true"\n')
    old_command = " ".join(COMPOSE + ["-f", str(BASE_OVERRIDE)])
    expected_pin = (f"[Service]\nEnvironment=CAMPUS_RELEASE_TAG={BASE_REV}\n"
                    f"Environment=CAMPUS_RUNTIME_ENV_FILE={RUNTIME}\n"
                    f"ExecCondition=/usr/bin/test -f {BASE_GATE}\nExecStart=\n"
                    f"ExecStart={old_command} up --wait --wait-timeout 90\nExecStop=\n"
                    f"ExecStop={old_command} stop\n")
    check(BASE_OVERRIDE.read_bytes() == expected_override.encode())
    check(pin.read_bytes() == expected_pin.encode())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    with path.open("x", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    private(path)


def prop(name):
    return run(["systemctl", "show", "--value", "-p", name, UNIT])


def command(prop_name, commands):
    actual = re.findall(r"argv\[\]=(.*?) ; ignore_errors=", prop(prop_name))
    check(actual == commands)


def health(image, revision, version, policy, label_name, label):
    # The service may have only one production container, including stopped ones.
    rows = run(["docker", "ps", "-a", "--no-trunc", "--filter",
                "label=com.docker.compose.project=campus-kb-prod", "--format", "{{.ID}} {{.Names}}"])
    check(len(rows.splitlines()) == 1 and rows.split()[1] == APP)
    fmt = ('{{.Image}} {{.State.Running}} {{.State.Health.Status}} '
           '{{.HostConfig.RestartPolicy.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}} '
           '{{index .Config.Labels "org.opencontainers.image.version"}}')
    check(run(["docker", "inspect", "--format", fmt, APP]) ==
          f"{image} true healthy {policy} {revision} {version}")
    label_format = '{{index .Config.Labels "' + label_name + '"}}'
    check(run(["docker", "inspect", "--format", label_format, APP]) == label)
    check(prop("ActiveState") == "active" and prop("NeedDaemonReload") == "no")
    check(run(["systemctl", "is-active", "kanon-runtime.service"]) == "active")
    curl = ["curl", "--disable", "--noproxy", "*", "--fail", "--silent", "--max-time", "12"]
    # Exercise the same Nginx listener and trusted certificate as public clients.
    for options, origin in [
        ([], "http://127.0.0.1:8080"),
        (["--proto", "=https", "--resolve", "canon.midis.ru:443:127.0.0.1"], "https://canon.midis.ru"),
    ]:
        payload = json.loads(run(curl + options + [origin + "/api/version"]))
        check(payload.get("version") == version and payload.get("revision") == revision)
        ready = json.loads(run(curl + options + [origin + "/api/ready"]))
        check(ready.get("status") == "ready")
    return rows.split()[0]


def freeze(expected):
    response = run(["curl", "--disable", "--noproxy", "*", "--silent", "--max-time", "10", "-i", "-X", "POST",
                    "http://127.0.0.1:8080/api/ready"])
    status, *headers = response.replace("\r\n", "\n").partition("\n\n")[0].lower().splitlines()
    check(status.split()[1] == ("503" if expected else "405"))
    check([line for line in headers if line.startswith("x-canon-deploy-freeze:")] ==
          (["x-canon-deploy-freeze: writes"] if expected else []))


def main():
    with ExitStack() as cleanup:
        return cutover(cleanup)


def cutover(cleanup):
    global phase
    os.umask(0o077)
    check(os.geteuid() == 0 and len(sys.argv) == 4)
    revision, image, run_id = sys.argv[1:]
    check(bool(re.fullmatch(r"[a-f0-9]{40}", revision)) and revision != BASE_REV)
    check(bool(re.fullmatch(r"sha256:[a-f0-9]{64}", image)) and image != BASE_IMAGE)
    check(run_id == RELEASE_RUN)
    for key in ["DOCKER_HOST", "DOCKER_CONTEXT", "NODE_OPTIONS", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"]:
        os.environ.pop(key, None)
    phase = "baseline-gates"
    backup_lock = STATE / "backup096.lock"
    private(backup_lock)
    lock = cleanup.enter_context(backup_lock.open("r+"))
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check(not PIN.exists() and not PIN.is_symlink())
    baseline_config()
    private(BASE_BACKUP)
    disk = os.statvfs(STATE)
    # The backup CLI caps an archive at 64 MiB. Allow two archives plus
    # another archive-sized margin for service and filesystem writes.
    check(disk.f_bavail * disk.f_frsize >= 3 * 64 * 1024 * 1024 and disk.f_favail >= 32)
    phase = "candidate-source"
    work = STATE / f"release099-{run_id}"
    work.mkdir(mode=0o700)  # Never reuse/overwrite an earlier attempt.
    private(work, True)
    override = work / "image.override.yml"
    gate = work / "reviewed-release.json"
    source = STATE / f"build099-{revision}" / "source"
    check(source.is_dir() and source.resolve() == source)
    private(source, True)
    source_compose = source / "deploy/compose.prod.yml"
    production_compose = REPO / "deploy/compose.prod.yml"
    check(source_compose.resolve() == source_compose and production_compose.resolve() == production_compose)
    check(digest(source_compose) == COMPOSE_SHA256 and digest(production_compose) == COMPOSE_SHA256)
    old_hashes = {name: digest(DROPINS / name) for name in OLD_NAMES}
    base_command = " ".join(COMPOSE + ["-f", str(BASE_OVERRIDE)])
    candidate_command = " ".join(COMPOSE + ["-f", str(override)])
    old_conditions = [f"/usr/bin/test -f {TOMBSTONE_ATTEMPTED}",
                      f"/usr/bin/test ! -e {TOMBSTONE_BLOCKED}",
                      f"/usr/bin/test -f {ANCESTOR_GATE}",
                      f"/usr/bin/test -f {FIRST_098_GATE}",
                      f"/usr/bin/test -f {BASE_GATE}"]

    def unit(candidate=False):
        expected = [str(DROPINS / name) for name in OLD_NAMES] + ([str(PIN)] if candidate else [])
        check(prop("DropInPaths").split() == expected)
        check(prop("WorkingDirectory") == str(REPO) and prop("NeedDaemonReload") == "no" and prop("Restart") == "no")
        check(digest(production_compose) == COMPOSE_SHA256)
        check(all(digest(DROPINS / name) == sha for name, sha in old_hashes.items()))
        cmd = candidate_command if candidate else base_command
        command("ExecStart", [cmd + " up --wait --wait-timeout 90"])
        command("ExecStop", [cmd + " stop"])
        command("ExecCondition", old_conditions + ([f"/usr/bin/test -f {gate}"] if candidate else []))

    def image_check(ref, expected_image, rev, version):
        check(run(["docker", "image", "inspect", "--format",
                   '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}', ref]) ==
              f"{expected_image} {rev} {version}")

    def replace_override(frozen):
        value = (f'services:\n  app:\n    image: "{image}"\n    restart: "no"\n'
                 f'    labels:\n      canon.release099.run: "{run_id}"\n    environment:\n'
                 f'      CANON_DEPLOY_FREEZE_WRITES: "{str(frozen).lower()}"\n'
                 f'      CANON_DISK_RECOVERY: "{str(not frozen).lower()}"\n')
        temp = work / ("frozen.yml" if frozen else "open.yml")
        write(temp, value)
        os.replace(temp, override)

    def stopped():
        check(not run(["docker", "ps", "--filter", "label=com.docker.compose.project=campus-kb-prod", "-q"]))
        check(prop("ActiveState") in ["inactive", "failed"])

    def maintenance(name, args, network=True):
        path = work / (name + ".json")
        container = f"kanon099-{run_id}-{name}"
        check(not run(["docker", "ps", "-a", "--filter", f"name=^/{container}$", "-q"]))
        cmd = ["docker", "run", "--rm", "--pull", "never", "--name", container,
               "--label", f"canon.release099.maintenance={run_id}",
               "--read-only", "--tmpfs", "/tmp:mode=1777", "--user", "0:0", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--memory", "768m", "--cpus", "1",
               "--env-file", RUNTIME, "-e", "USE_DATABASE=true", "-e", "CANON_DISK_RECOVERY=false",
               "-e", "NODE_OPTIONS=", "-e", "YANDEX_AI_STUDIO_API_KEY=", "-e", "YANDEX_DISK_OAUTH_TOKEN=",
               "-e", "ALIBABA_DASHSCOPE_API_KEY=", "-v", f"{work}:/backup"]
        if not network:
            cmd += ["--network", "none"]
        try:
            result = run(cmd + [image, "node", "--import", "tsx", "scripts/database-backup.ts"] + args, timeout=600)
        finally:
            remains = run(["docker", "ps", "-a", "--filter", f"name=^/{container}$", "-q"])
            if remains:
                check(run(["docker", "inspect", "--format",
                           '{{.Image}} {{index .Config.Labels "canon.release099.maintenance"}}', container]) == f"{image} {run_id}")
                run(["docker", "rm", "-f", container])
        parsed = json.loads(result)
        expected_status = {"snapshot": "saved", "verify": "verified", "restore": "restored"}[args[0]]
        check(parsed.get("status") == expected_status)
        check(bool(re.fullmatch(r"[a-f0-9]{64}", parsed.get("sha256", ""))))
        write(path, json.dumps(parsed) + "\n")
        return parsed

    phase = "preflight"
    image_check(image, image, revision, RELEASE_VERSION)
    image_check(BASE_IMAGE, BASE_IMAGE, BASE_REV, BASE_VERSION)
    unit()
    old_container = health(BASE_IMAGE, BASE_REV, BASE_VERSION, "unless-stopped", "canon.release098.run", BASE_RUN)
    freeze(False)
    proof = {"revision": revision, "image": image, "version": RELEASE_VERSION, "run": run_id,
             "previousRevision": BASE_REV, "previousImage": BASE_IMAGE, "previousVersion": BASE_VERSION,
             "oldContainer": old_container}
    write(gate, json.dumps(proof) + "\n")
    replace_override(True)
    pin_bytes = (f"[Service]\nEnvironment=CAMPUS_RELEASE_TAG={revision}\nEnvironment=CAMPUS_RUNTIME_ENV_FILE={RUNTIME}\n"
                 f"ExecCondition=/usr/bin/test -f {gate}\nExecStart=\nExecStart={candidate_command} up --wait --wait-timeout 90\n"
                 f"ExecStop=\nExecStop={candidate_command} stop\n")
    # Prepare the complete ignored staging file before touching the running writer.
    # Hard-link publication below is atomic and cannot overwrite another pin.
    staged_pin = DROPINS / f".{PIN.stem}.{run_id}"
    check(not staged_pin.exists() and not staged_pin.is_symlink())
    cleanup.callback(lambda: staged_pin.unlink(missing_ok=True))
    write(staged_pin, pin_bytes)
    armed = False
    try:
        phase = "stop-writers"
        armed = True
        run(["systemctl", "stop", UNIT], timeout=120)
        stopped()
        phase = "fresh-snapshot"
        snapshot = maintenance("snapshot", ["snapshot", "/backup/before.json", "--writers-stopped"])
        private(work / "before.json")
        phase = "verify-snapshot"
        verified = maintenance("verify", ["verify", "/backup/before.json"], network=False)
        check(snapshot["sha256"] == verified["sha256"] and snapshot["tableCounts"] == verified["tableCounts"])
        phase = "restore-isolated"
        restored = maintenance("restore", ["restore", "/backup/before.json", "--prefix", f"qa095-099-{run_id}-"])
        check(restored["sha256"] == verified["sha256"] and restored["tableCounts"] == verified["tableCounts"])
        stopped()
        phase = "frozen-start"
        os.link(staged_pin, PIN)
        private(PIN)
        run(["systemctl", "daemon-reload"])
        unit(True)
        run(["systemctl", "start", UNIT], timeout=120)
        frozen_id = health(image, revision, RELEASE_VERSION, "no", "canon.release099.run", run_id)
        freeze(True)
        phase = "verify-production-unchanged"
        frozen = maintenance("frozen-snapshot", ["snapshot", "/backup/frozen.json", "--writers-stopped"])
        private(work / "frozen.json")
        before = json.loads((work / "before.json").read_text())
        after = json.loads((work / "frozen.json").read_text())
        check(before["sourceSha256"] == after["sourceSha256"])
        check({t["name"]: t["sha256"] for t in before["tables"]} ==
              {t["name"]: t["sha256"] for t in after["tables"]})
        check(snapshot["tableCounts"] == frozen["tableCounts"])
        phase = "open-writes"
        unit(True)
        run(["systemctl", "stop", UNIT], timeout=120)
        stopped()
        replace_override(False)
        run(["systemctl", "start", UNIT], timeout=120)
        active_id = health(image, revision, RELEASE_VERSION, "no", "canon.release099.run", run_id)
        freeze(False)
        # Persist restart policy in both Compose and Docker only after acceptance.
        content = override.read_text().replace('restart: "no"', 'restart: "unless-stopped"')
        temp = work / "accepted-override.yml"
        write(temp, content)
        os.replace(temp, override)
        run(["docker", "update", "--restart", "unless-stopped", APP])
        check(health(image, revision, RELEASE_VERSION, "unless-stopped", "canon.release099.run", run_id) == active_id)
        unit(True)
        proof.update(status="accepted", container=active_id, frozenContainer=frozen_id,
                     backupSha256=verified["sha256"], restored=True, inventoryUnchanged=True)
        receipt = work / "accepted.tmp"
        write(receipt, json.dumps(proof) + "\n")
        os.replace(receipt, work / "accepted.json")
        armed = False
        print(json.dumps(proof))
    except BaseException:
        if armed:
            phase_failed = phase
            phase = "rollback"
            # Only adopt/stop our exact candidate; otherwise leave an explicit failure.
            def pin_candidate():
                present = run(["docker", "ps", "-a", "--filter", f"name=^/{APP}$", "-q"])
                current_image = run(["docker", "inspect", "--format", "{{.Image}}", APP]) if present else None
                check(current_image in [None, BASE_IMAGE, image])
                if current_image != image:
                    return None
                candidate_id = run(["docker", "inspect", "--format", '{{.Id}}', APP])
                check(bool(re.fullmatch(r"[a-f0-9]{64}", candidate_id)))
                check(run(["docker", "inspect", "--format", '{{.Image}} {{index .Config.Labels "canon.release099.run"}}', candidate_id]) == f"{image} {run_id}")
                run(["docker", "update", "--restart", "no", candidate_id])
                return candidate_id

            pin_candidate()
            if gate.exists():
                gate.rename(work / "blocked-release.json")
            run(["systemctl", "stop", UNIT], timeout=120)
            # A create job may finish while systemctl stop is cancelling the start.
            # Re-discover after cancellation, including candidates absent beforehand.
            candidate_id = pin_candidate()
            if candidate_id:
                check(run(["docker", "inspect", "--format", '{{.Image}} {{index .Config.Labels "canon.release099.run"}}', candidate_id]) == f"{image} {run_id}")
                run(["docker", "container", "stop", "--time", "20", candidate_id], timeout=35)
            stopped()
            if PIN.exists() or PIN.is_symlink():
                private(PIN)
                check(PIN.read_text() == pin_bytes)
                PIN.unlink()
            run(["systemctl", "daemon-reload"])
            unit()
            baseline_config()
            run(["systemctl", "start", UNIT], timeout=120)
            health(BASE_IMAGE, BASE_REV, BASE_VERSION, "unless-stopped", "canon.release098.run", BASE_RUN)
            freeze(False)
            write(work / "rollback.json", json.dumps({"status": "rolled-back", "phase": phase_failed,
                                                       "dataRestored": False}) + "\n")
            phase = phase_failed + ":rolled-back-to-baseline-098"
        raise


if __name__ == "__main__":
    def interrupt(_signum, _frame):
        raise InterruptedError("release interrupted")
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    try:
        main()
    except BaseException:
        print(json.dumps({"status": "failed", "phase": phase}), file=sys.stderr)
        sys.exit(1)
