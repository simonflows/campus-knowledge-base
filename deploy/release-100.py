#!/usr/bin/env python3
"""One-shot 1.0.0 cutover from the accepted 0.9.9 f099n24a baseline.

No runtime credential is read by this program. Docker passes the protected env
file directly to the application maintenance commands. Records stay root-only.
"""
import fcntl
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

from ci_image_load_100 import fsync_directory, verified_receipt

BASE_REV = "b94208f506b887685fee839d6347594739d20199"
BASE_IMAGE = "sha256:c24de3d9b32751e20b93487ee29922e269fdfadf226975087a7691527453f9ac"
BASE_VERSION = "0.9.9"
BASE_RUN = "f099n24a"
RELEASE_VERSION = "1.0.0"
RELEASE_RUN = "f100n26a"
COMPOSE_SHA256 = "b41a16d54e83889f543f94ab57e381bace71f10f52c0fb6b678557c1a9ab9fa7"
REPO = Path("/opt/campus-knowledge-base/app")
STATE = Path("/var/lib/canon")
RUNTIME = "/run/campus/runtime.env"
PUBLIC_ORIGIN = "https://canon.midis.ru"
PUBLIC_RESOLVE = ["--proto", "=https", "--resolve", "canon.midis.ru:443:127.0.0.1"]
APP = "campus-kb-prod-app-1"
UNIT = "kanon.service"
DROPINS = Path("/etc/systemd/system/kanon.service.d")
PIN = DROPINS / "28-release-100.conf"
BASE_OVERRIDE = STATE / "release099-f099n24a/image.override.yml"
BASE_GATE = STATE / "release099-f099n24a/reviewed-release.json"
BASE_ACCEPTED = STATE / "release099-f099n24a/accepted.json"
BASE_BACKUP = STATE / "release099-f099n24a/before.json"
FIRST_098_GATE = STATE / "release098-f098n24a/reviewed-release.json"
SECOND_098_GATE = STATE / "release098-f098n24b/reviewed-release.json"
ANCESTOR_GATE = STATE / "ui097-f097n23a/compat-gate.json"
TOMBSTONE_ATTEMPTED = STATE / "precutover096-f096n23b/new-writer-attempted.json"
TOMBSTONE_BLOCKED = STATE / "precutover096-f096n23b/new-writer-blocked.json"
OLD_NAMES = ["10-disk-release.conf", "20-release-095.conf", "21-ui-release-095.conf",
             "22-release-096.conf", "23-workflows-096.conf", "24-ui-097.conf", "25-release-098.conf",
             "26-release-098.conf", "27-release-099.conf"]
COMPOSE = ["/usr/bin/docker", "compose", "--env-file", "/dev/null", "-f", "deploy/compose.prod.yml"]
BASE_TABLES = frozenset({
    "editorial-documents", "editorial-revisions", "information-requests",
    "knowledge-articles", "knowledge-card-types", "knowledge-card-versions",
    "knowledge-cards", "workflow-records",
})
NEW_TABLES = frozenset({"account-identities", "account-sessions", "account-rate-limits"})
RELEASE_TABLES = BASE_TABLES | NEW_TABLES
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


def trusted_directories(path):
    for parent in (path, *path.parents):
        info = parent.lstat()
        check(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)


def baseline_config():
    """Bind rollback to the exact startup configuration of the accepted 0.9.9."""
    for path in [TOMBSTONE_ATTEMPTED, ANCESTOR_GATE, FIRST_098_GATE, SECOND_098_GATE,
                 BASE_GATE, BASE_OVERRIDE, BASE_ACCEPTED]:
        private(path.parent, directory=True)
        private(path)
    check(not TOMBSTONE_BLOCKED.exists() and not TOMBSTONE_BLOCKED.is_symlink())
    baseline = json.loads(BASE_ACCEPTED.read_text())
    check(baseline.get("status") == "accepted" and baseline.get("revision") == BASE_REV and
          baseline.get("image") == BASE_IMAGE and baseline.get("run") == BASE_RUN and
          baseline.get("version") == BASE_VERSION and
          baseline.get("restored") is True and baseline.get("inventoryUnchanged") is True)
    gate = json.loads(BASE_GATE.read_text())
    check(all(gate.get(key) == baseline[key] for key in ["image", "revision", "version", "run"]))
    pin = DROPINS / "27-release-099.conf"
    private(pin)
    expected_override = (f'services:\n  app:\n    image: "{BASE_IMAGE}"\n    restart: "unless-stopped"\n'
                         f'    labels:\n      canon.release099.run: "{BASE_RUN}"\n    environment:\n'
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


def has_digest(value, prefix=""):
    return isinstance(value, str) and bool(re.fullmatch(prefix + r"[a-f0-9]{64}", value))


def inventory(path, report, expected_tables):
    """Read backup-only metadata from the archive verified by its own image."""
    private(path)
    archive = json.loads(path.read_text(encoding="utf-8"))
    rows = archive["tables"]
    tables = {row["name"]: (row["count"], row["sha256"]) for row in rows}
    check(len(rows) == len(tables) and tables.keys() == expected_tables)
    check(archive["scope"] == "current" and has_digest(archive["sourceSha256"]))
    check(archive["sha256"] == report["sha256"])
    check(all(type(count) is int and count >= 0 and has_digest(sha) for count, sha in tables.values()))
    check(report["tableCounts"] == {key: value[0] for key, value in tables.items()})
    return archive["sourceSha256"], tables


def write(path, value):
    with path.open("x", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    private(path)


def replace_synced(source, destination):
    os.replace(source, destination)
    fsync_directory(destination.parent)


def unlink_synced(path):
    if path.exists() or path.is_symlink():
        path.unlink()
        fsync_directory(path.parent)


def publish(path, contents):
    staged = path.with_name("." + path.name + ".tmp")
    write(staged, contents)
    replace_synced(staged, path)


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
        (PUBLIC_RESOLVE, PUBLIC_ORIGIN),
    ]:
        payload = json.loads(run(curl + options + [origin + "/api/version"]))
        check(payload.get("version") == version and payload.get("revision") == revision)
        ready = json.loads(run(curl + options + [origin + "/api/ready"]))
        check(ready.get("status") == "ready")
    return rows.split()[0]


def response_headers(path, options):
    response = run(["curl", "--disable", "--noproxy", "*", "--silent", "--max-time", "10", "-i", *options, path])
    status, *lines = response.replace("\r\n", "\n").partition("\n\n")[0].splitlines()
    headers = {}
    for line in lines:
        name, colon, value = line.partition(":")
        check(colon == ":")
        headers.setdefault(name.lower(), []).append(value.strip())
    return status.split()[1], headers


def freeze(expected):
    internal = "http://127.0.0.1:8080"
    status, headers = response_headers(internal + "/api/ready", ["-X", "POST"])
    check(status == ("503" if expected else "405"))
    check(headers.get("x-canon-deploy-freeze", []) == (["writes"] if expected else []))
    if expected:
        for origin, options in [(internal, []), (PUBLIC_ORIGIN, PUBLIC_RESOLVE)]:
            for method in [[], ["--head"]]:
                status, headers = response_headers(origin + "/api/auth/yandex/callback", options + method)
                check(status == "503" and headers.get("x-canon-deploy-freeze") == ["writes"])
                check("set-cookie" not in headers and "location" not in headers)


def oauth_runtime(image):
    # Exit status only. The Docker runtime supplies the protected values, and
    # neither this process nor the verifier reads their contents into a log.
    predicate = ("const e = process.env; process.exitCode = Number(!(/^[-_a-zA-Z0-9]{1,128}$/.test("
                 "e.YANDEX_OAUTH_CLIENT_ID?.trim() || '') && e.YANDEX_OAUTH_CLIENT_SECRET?.trim() && "
                 "e.SESSION_SECRET?.length >= 32 && e.CAMPUS_YANDEX_OAUTH_ENABLED === 'true' && "
                 "e.CAMPUS_EMAIL_ACCOUNTS_ENABLED === 'false' && e.CAMPUS_PUBLIC_ORIGIN === 'https://canon.midis.ru'));")
    run(["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
         "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--env-file", RUNTIME,
         "-e", "NODE_OPTIONS=", "--entrypoint", "node", image, "-e", predicate])


def oauth_start():
    status, headers = response_headers(PUBLIC_ORIGIN + "/api/auth/yandex/start",
                                       PUBLIC_RESOLVE + ["-X", "POST", "-H", "Origin: " + PUBLIC_ORIGIN])
    check(status == "303" and len(headers.get("location", [])) == 1 and len(headers.get("set-cookie", [])) == 1)
    redirect = urlsplit(headers["location"][0])
    query = parse_qs(redirect.query)
    check((redirect.scheme, redirect.netloc, redirect.path, redirect.fragment) ==
          ("https", "oauth.yandex.ru", "/authorize", ""))
    check(query.get("redirect_uri") == [PUBLIC_ORIGIN + "/api/auth/yandex/callback"] and
          query.get("response_type") == ["code"] and query.get("code_challenge_method") == ["S256"] and
          len(query.get("client_id", [])) == 1)
    cookie, *attributes = [part.strip().lower() for part in headers["set-cookie"][0].split(";")]
    check(cookie.startswith("__host-vibecraft-oauth=") and
          {"path=/", "secure", "httponly", "samesite=lax"} <= set(attributes) and
          not any(attribute.startswith("domain=") for attribute in attributes))
    check(any("no-store" in item for item in headers.get("cache-control", [])) and
          headers.get("referrer-policy") == ["no-referrer"])


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
    for key in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "NODE_OPTIONS", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"]:
        os.environ.pop(key, None)
    phase = "baseline-gates"
    trusted_directories(STATE)
    trusted_directories(DROPINS)
    private(STATE, directory=True)
    backup_lock = STATE / "backup096.lock"
    private(backup_lock)
    lock = cleanup.enter_context(backup_lock.open("r+"))
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check(not PIN.exists() and not PIN.is_symlink())
    baseline_config()
    private(BASE_BACKUP.parent, directory=True)
    private(BASE_BACKUP)
    disk = os.statvfs(STATE)
    # The backup CLI caps an archive at 64 MiB. Allow two archives plus
    # another archive-sized margin for service and filesystem writes.
    check(disk.f_bavail * disk.f_frsize >= 3 * 64 * 1024 * 1024 and disk.f_favail >= 32)
    phase = "candidate-source"
    work = STATE / f"release100-{run_id}"
    work.mkdir(mode=0o700)  # Never reuse/overwrite an earlier attempt.
    private(work, True)
    fsync_directory(STATE)
    override = work / "image.override.yml"
    gate = work / "reviewed-release.json"
    build = STATE / f"build100-{revision}"
    private(build, True)
    load_proof = verified_receipt(build, revision, image)
    source = build / "source"
    check(source.is_dir() and source.resolve() == source)
    private(source, True)
    source_compose = source / "deploy/compose.prod.yml"
    source_package = source / "package.json"
    production_compose = REPO / "deploy/compose.prod.yml"
    check(all(path.resolve() == path for path in [source_compose, source_package, production_compose]))
    check(digest(source_compose) == COMPOSE_SHA256 and digest(production_compose) == COMPOSE_SHA256)
    check(json.loads(source_package.read_text(encoding="utf-8")).get("version") == RELEASE_VERSION)
    old_hashes = {name: digest(DROPINS / name) for name in OLD_NAMES}
    base_command = " ".join(COMPOSE + ["-f", str(BASE_OVERRIDE)])
    candidate_command = " ".join(COMPOSE + ["-f", str(override)])
    old_conditions = [f"/usr/bin/test -f {TOMBSTONE_ATTEMPTED}",
                      f"/usr/bin/test ! -e {TOMBSTONE_BLOCKED}",
                      f"/usr/bin/test -f {ANCESTOR_GATE}",
                      f"/usr/bin/test -f {FIRST_098_GATE}",
                      f"/usr/bin/test -f {SECOND_098_GATE}",
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
                 f'    labels:\n      canon.release100.run: "{run_id}"\n    environment:\n'
                 f'      CANON_DEPLOY_FREEZE_WRITES: "{str(frozen).lower()}"\n'
                 f'      CANON_DISK_RECOVERY: "{str(not frozen).lower()}"\n'
                 '      CAMPUS_EMAIL_ACCOUNTS_ENABLED: "false"\n' +
                 ('      CAMPUS_YANDEX_OAUTH_ENABLED: "false"\n' if frozen else ''))
        temp = work / ("frozen.yml" if frozen else "open.yml")
        write(temp, value)
        replace_synced(temp, override)

    def stopped():
        check(not run(["docker", "ps", "--filter", "label=com.docker.compose.project=campus-kb-prod", "-q"]))
        check(prop("ActiveState") in ["inactive", "failed"])

    def maintenance(name, args, backup_image, expected_tables, network=True):
        path = work / (name + ".json")
        container = f"kanon100-{run_id}-{name}"
        check(not run(["docker", "ps", "-a", "--filter", f"name=^/{container}$", "-q"]))
        cmd = ["docker", "run", "--rm", "--pull", "never", "--name", container,
               "--label", f"canon.release100.maintenance={run_id}",
               "--read-only", "--tmpfs", "/tmp:mode=1777", "--user", "0:0", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--memory", "768m", "--cpus", "1"]
        cmd += ["--env-file", RUNTIME] if network else ["--network", "none"]
        cmd += ["-e", "USE_DATABASE=true", "-e", "CANON_DISK_RECOVERY=false",
               "-e", "NODE_OPTIONS=", "-e", "YANDEX_AI_STUDIO_API_KEY=", "-e", "YANDEX_DISK_OAUTH_TOKEN=",
               "-e", "ALIBABA_DASHSCOPE_API_KEY=", "-v", f"{work}:/backup"]
        try:
            result = run(cmd + [backup_image, "node", "--import", "tsx", "scripts/database-backup.ts"] + args, timeout=600)
        finally:
            remains = run(["docker", "ps", "-a", "--filter", f"name=^/{container}$", "-q"])
            if remains:
                check(run(["docker", "inspect", "--format",
                           '{{.Image}} {{index .Config.Labels "canon.release100.maintenance"}}', container]) ==
                      f"{backup_image} {run_id}")
                run(["docker", "rm", "-f", container])
        parsed = json.loads(result)
        expected_status = {"snapshot": "saved", "verify": "verified", "restore": "restored"}[args[0]]
        check(parsed.get("status") == expected_status)
        check(has_digest(parsed.get("sha256")) and parsed.get("tables") == len(expected_tables))
        counts = parsed.get("tableCounts")
        check(isinstance(counts, dict) and counts.keys() == expected_tables)
        check(all(type(count) is int and count >= 0 for count in counts.values()))
        check(parsed.get("entries") == sum(counts.values()))
        publish(path, json.dumps(parsed) + "\n")
        return parsed

    def backup_round_trip(label, archive, backup_image, expected_tables, prefix):
        global phase
        mounted_archive = f"/backup/{archive}"
        phase = label + "-snapshot"
        snapshot = maintenance(label + "-capture", ["snapshot", mounted_archive, "--writers-stopped"],
                               backup_image, expected_tables)
        phase = label + "-verify"
        verified = maintenance(label + "-verify", ["verify", mounted_archive],
                               backup_image, expected_tables, network=False)
        check(snapshot["sha256"] == verified["sha256"] and snapshot["tableCounts"] == verified["tableCounts"])
        phase = label + "-restore"
        # Both prefixes satisfy the backup CLI's reserved namespace and differ
        # across the schema boundary, so no restore targets another run's tables.
        restored = maintenance(label + "-restore", ["restore", mounted_archive, "--prefix", prefix],
                               backup_image, expected_tables)
        check(restored["sha256"] == verified["sha256"] and restored["tableCounts"] == verified["tableCounts"])
        return verified

    migration_container = f"kanon100-{run_id}-migrate"
    migration_project = f"campus-kb-migrate-{run_id}"
    migration_file = work / "migration.compose.json"
    migration_compose = ["/usr/bin/docker", "compose", "--env-file", "/dev/null",
                         "-p", migration_project, "-f", str(migration_file)]

    def migration_id():
        rows = run(["docker", "ps", "-a", "--no-trunc", "--filter", f"name=^/{migration_container}$", "-q"])
        if not rows:
            return None
        check(has_digest(rows))
        fmt = ('{{.Image}} {{index .Config.Labels "canon.release100.migration"}} '
               '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} '
               '{{.HostConfig.RestartPolicy.Name}}')
        check(run(["docker", "inspect", "--format", fmt, rows]) == f"{image} {run_id} {migration_project} app no")
        return rows

    def clear_migration():
        container_id = migration_id()
        if container_id:
            run(["docker", "rm", "-f", container_id])
        check(migration_id() is None)

    def migrate():
        # A separate, inert Compose service runs only the reviewed migration.
        # It never binds production ports and cannot serve or recover writes.
        check(migration_id() is None)
        config = {"services": {"app": {
            "image": image,
            "container_name": migration_container,
            "labels": {"canon.release100.migration": run_id},
            "pull_policy": "never",
            "env_file": [{"path": RUNTIME, "format": "raw"}],
            "environment": {
                "NODE_ENV": "production", "USE_DATABASE": "true", "NODE_OPTIONS": "",
                "CANON_DEPLOY_FREEZE_WRITES": "true", "CANON_DISK_RECOVERY": "false",
                "CAMPUS_EMAIL_ACCOUNTS_ENABLED": "false",
                "CAMPUS_YANDEX_OAUTH_ENABLED": "false",
            },
            "entrypoint": ["node", "-e", "setInterval(() => {}, 60000)"],
            "command": [],
            "healthcheck": {"disable": True},
            "restart": "no",
            "network_mode": "bridge",
            "user": "1001:1001",
            "init": True,
            "read_only": True,
            "tmpfs": ["/tmp:mode=1777"],
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "mem_limit": "768m",
            "cpus": 1,
        }}}
        write(migration_file, json.dumps(config) + "\n")
        try:
            run(migration_compose + ["up", "-d", "--no-deps", "app"], timeout=90)
            check(migration_id() is not None)
            run(migration_compose + ["exec", "-T", "app", "npm", "run", "db:migrate"], timeout=900)
        finally:
            clear_migration()

    phase = "preflight"
    image_check(image, image, revision, RELEASE_VERSION)
    image_check(BASE_IMAGE, BASE_IMAGE, BASE_REV, BASE_VERSION)
    oauth_runtime(image)
    unit()
    old_container = health(BASE_IMAGE, BASE_REV, BASE_VERSION, "unless-stopped", "canon.release099.run", BASE_RUN)
    freeze(False)
    check(migration_id() is None)
    proof = {"revision": revision, "image": image, "version": RELEASE_VERSION, "run": run_id,
             "previousRevision": BASE_REV, "previousImage": BASE_IMAGE, "previousVersion": BASE_VERSION,
             "oldContainer": old_container, **load_proof}
    replace_override(True)
    pin_bytes = (f"[Service]\nEnvironment=CAMPUS_RELEASE_TAG={revision}\nEnvironment=CAMPUS_RUNTIME_ENV_FILE={RUNTIME}\n"
                 f"ExecCondition=/usr/bin/test -f {gate}\nExecStart=\nExecStart={candidate_command} up --wait --wait-timeout 90\n"
                 f"ExecStop=\nExecStop={candidate_command} stop\n")
    # Prepare the complete ignored staging file before touching the running writer.
    # Hard-link publication below is atomic and cannot overwrite another pin.
    staged_pin = DROPINS / f".{PIN.stem}.{run_id}"
    check(not staged_pin.exists() and not staged_pin.is_symlink())
    cleanup.callback(unlink_synced, staged_pin)
    write(staged_pin, pin_bytes)
    accepted = work / "accepted.json"
    armed = False
    try:
        phase = "stop-writers"
        armed = True
        run(["systemctl", "stop", UNIT], timeout=120)
        stopped()
        phase = "pin-closed-cutover"
        # The absence of the new review gate keeps systemd from restarting the
        # application during backup or DDL, including after a host reboot.
        os.link(staged_pin, PIN)
        fsync_directory(DROPINS)
        private(PIN)
        unlink_synced(staged_pin)
        run(["systemctl", "daemon-reload"])
        unit(True)
        check(not gate.exists() and not gate.is_symlink())
        before_prefix = f"qa095-100-{run_id}-old-"
        before = backup_round_trip("baseline", "before.json", BASE_IMAGE, BASE_TABLES, before_prefix)
        source_hash, old_tables = inventory(work / "before.json", before, BASE_TABLES)
        stopped()
        phase = "migrate-schema"
        migrate()
        stopped()
        proof.update(baselineBackupSha256=before["sha256"], baselineRestorePrefix=before_prefix,
                     baselineTableCounts=before["tableCounts"], migrated=True)
        publish(gate, json.dumps(proof) + "\n")
        phase = "frozen-start"
        run(["systemctl", "start", UNIT], timeout=120)
        frozen_id = health(image, revision, RELEASE_VERSION, "no", "canon.release100.run", run_id)
        freeze(True)
        new_prefix = f"qa095-100-{run_id}-new-"
        frozen = backup_round_trip("candidate", "frozen.json", image, RELEASE_TABLES, new_prefix)
        phase = "verify-production-unchanged"
        frozen_source, new_tables = inventory(work / "frozen.json", frozen, RELEASE_TABLES)
        check(source_hash == frozen_source and old_tables == {table: new_tables[table] for table in BASE_TABLES})
        check(all(new_tables[table][0] == 0 for table in NEW_TABLES))
        check(health(image, revision, RELEASE_VERSION, "no", "canon.release100.run", run_id) == frozen_id)
        freeze(True)
        proof.update(frozenContainer=frozen_id, backupSha256=frozen["sha256"],
                     candidateRestorePrefix=new_prefix, candidateTableCounts=frozen["tableCounts"],
                     restored=True, inventoryUnchanged=True, accountTablesEmpty=True,
                     emailAccountsEnabled=False)
        publish(work / "frozen-verified.json", json.dumps({**proof, "status": "frozen-verified"}) + "\n")
        phase = "open-writes"
        unit(True)
        run(["systemctl", "stop", UNIT], timeout=120)
        stopped()
        replace_override(False)
        run(["systemctl", "start", UNIT], timeout=120)
        active_id = health(image, revision, RELEASE_VERSION, "no", "canon.release100.run", run_id)
        freeze(False)
        phase = "accept-oauth-start"
        oauth_start()
        phase = "accept-restart-policy"
        # Persist restart policy in both Compose and Docker only after acceptance.
        content = override.read_text().replace('restart: "no"', 'restart: "unless-stopped"')
        temp = work / "accepted-override.yml"
        write(temp, content)
        replace_synced(temp, override)
        run(["docker", "update", "--restart", "unless-stopped", APP])
        check(health(image, revision, RELEASE_VERSION, "unless-stopped", "canon.release100.run", run_id) == active_id)
        unit(True)
        phase = "accept-receipt"
        proof.update(status="accepted", container=active_id, yandexOAuthStartVerified=True)
        publish(accepted, json.dumps(proof) + "\n")
        armed = False
        print(json.dumps(proof))
    except BaseException:
        if armed:
            phase_failed = phase
            phase = "rollback"
            # A signal can land immediately after rename, before acceptance is
            # complete. Withdraw any visible receipt before changing releases.
            unlink_synced(accepted)
            # Only adopt/stop our exact candidate; otherwise leave an explicit failure.
            def pin_candidate():
                present = run(["docker", "ps", "-a", "--filter", f"name=^/{APP}$", "-q"])
                current_image = run(["docker", "inspect", "--format", "{{.Image}}", APP]) if present else None
                check(current_image in [None, BASE_IMAGE, image])
                if current_image != image:
                    return None
                candidate_id = run(["docker", "inspect", "--format", '{{.Id}}', APP])
                check(bool(re.fullmatch(r"[a-f0-9]{64}", candidate_id)))
                check(run(["docker", "inspect", "--format", '{{.Image}} {{index .Config.Labels "canon.release100.run"}}', candidate_id]) == f"{image} {run_id}")
                run(["docker", "update", "--restart", "no", candidate_id])
                return candidate_id

            pin_candidate()
            if gate.exists():
                replace_synced(gate, work / "blocked-release.json")
            run(["systemctl", "stop", UNIT], timeout=120)
            # A create job may finish while systemctl stop is cancelling the start.
            # Re-discover after cancellation, including candidates absent beforehand.
            candidate_id = pin_candidate()
            if candidate_id:
                check(run(["docker", "inspect", "--format", '{{.Image}} {{index .Config.Labels "canon.release100.run"}}', candidate_id]) == f"{image} {run_id}")
                run(["docker", "container", "stop", "--time", "20", candidate_id], timeout=35)
            stopped()
            if migration_file.exists():
                clear_migration()
            if PIN.exists() or PIN.is_symlink():
                private(PIN)
                check(PIN.read_text() == pin_bytes)
                unlink_synced(PIN)
            run(["systemctl", "daemon-reload"])
            unit()
            baseline_config()
            run(["systemctl", "start", UNIT], timeout=120)
            health(BASE_IMAGE, BASE_REV, BASE_VERSION, "unless-stopped", "canon.release099.run", BASE_RUN)
            freeze(False)
            publish(work / "rollback.json", json.dumps({"status": "rolled-back", "phase": phase_failed,
                                                         "dataRestored": False}) + "\n")
            phase = phase_failed + ":rolled-back-to-baseline-099"
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
