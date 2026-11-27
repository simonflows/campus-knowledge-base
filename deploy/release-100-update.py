#!/usr/bin/env python3
"""Switch the accepted 1.0.0 writer to the f100n26b CI image without a migration."""
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit

sys.dont_write_bytecode = True
from ci_image_load_100 import fsync_directory, hex_digest, verified_receipt

RUN = "f100n26b"
BASE_RUN = "f100n26a"
VERSION = "1.0.0"
BASE_REV = "25fa0098882be831847fdb42361952832f44fd67"
BASE_IMAGE = "sha256:23f9446ccc91462aa186d802a916c596e00f334c937c2dc281e4b35dad1feb10"
BASE_CI_RUN = 45743522501
PRIOR_REV = "b94208f506b887685fee839d6347594739d20199"
PRIOR_IMAGE = "sha256:c24de3d9b32751e20b93487ee29922e269fdfadf226975087a7691527453f9ac"
COMPOSE_SHA256 = "b41a16d54e83889f543f94ab57e381bace71f10f52c0fb6b678557c1a9ab9fa7"
STATE = Path("/var/lib/canon")
DROPINS = Path("/etc/systemd/system/kanon.service.d")
REPO = Path("/opt/campus-knowledge-base/app")
SCRIPT = Path(__file__).absolute()
RUNTIME = "/run/campus/runtime.env"
BOOT_ID_FILE = Path("/proc/sys/kernel/random/boot_id")
UNIT = "kanon.service"
APP = "campus-kb-prod-app-1"
PROJECT = "label=com.docker.compose.project=campus-kb-prod"
LABEL = "canon.release100.run"
LABEL_FORMAT = '{{index .Config.Labels "canon.release100.run"}}'
PUBLIC = "https://canon.midis.ru"
INTERNAL = "http://127.0.0.1:8080"
PUBLIC_RESOLVE = ["--proto", "=https", "--resolve", "canon.midis.ru:443:127.0.0.1"]
OLD_DROPINS = [
    "10-disk-release.conf", "20-release-095.conf", "21-ui-release-095.conf", "22-release-096.conf",
    "23-workflows-096.conf", "24-ui-097.conf", "25-release-098.conf", "26-release-098.conf",
    "27-release-099.conf", "28-release-100.conf",
]
TTL_TABLES = ("account-sessions", "account-rate-limits")
TABLES = frozenset({
    "editorial-documents", "editorial-revisions", "information-requests",
    "knowledge-articles", "knowledge-card-types", "knowledge-card-versions",
    "knowledge-cards", "workflow-records", "account-identities", *TTL_TABLES,
})
phase = "arguments"


@dataclass(frozen=True)
class Update:
    run: str = RUN
    version: str = VERSION
    series: str = "100"
    pin_name: str = "29-release-100-update.conf"
    script_name: str = "release-100-update.py"
    base_run: str = BASE_RUN
    base_revision: str = BASE_REV
    base_image: str = BASE_IMAGE
    base_version: str = VERSION
    base_ci_run: int = BASE_CI_RUN
    base_pin: str = "28-release-100.conf"
    inherited_dropins: tuple[str, ...] = ()

    def work(self, state):
        return state / f"release{self.series}-{self.run}"

    def build(self, state, revision):
        return state / f"build{self.series}-{revision}"

    def restore_prefix(self):
        return f"qa095-{self.series}-{self.run}-old-"


UPDATE_100 = Update()


def check(condition):
    if not condition:
        raise RuntimeError("update gate failed")


def run(args, timeout=30):
    # No runtime values, response cookies, or subprocess diagnostics are logged.
    result = subprocess.run(args, cwd=REPO, check=True, timeout=timeout,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout.decode("utf-8").strip()


def private(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    check(kind(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600))


def trusted_directories(path):
    for parent in (path, *path.parents):
        info = parent.lstat()
        check(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)


def trusted_file(path):
    info = path.lstat()
    check(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)


def absent(path):
    return not path.exists() and not path.is_symlink()


def read(path):
    private(path)
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unlink_synced(path):
    if not absent(path):
        path.unlink()
        fsync_directory(path.parent)


def publish(path, value):
    staged = path.with_name("." + path.name + ".tmp")
    # Use bytes so the persisted configuration is the same as the pinned format.
    with staged.open("xb") as handle:
        handle.write(value.encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(staged, path)
    fsync_directory(path.parent)


def record(path, value):
    check(absent(path))
    publish(path, json.dumps(value, sort_keys=True) + "\n")


def compose(work):
    return f"/usr/bin/docker compose --env-file /dev/null -f deploy/compose.prod.yml -f {work / 'image.override.yml'}"


def pin_content(work, revision, boot_command=None):
    cmd = compose(work)
    boot = f"ExecCondition={boot_command}\n" if boot_command else ""
    return (f"[Service]\nEnvironment=CAMPUS_RELEASE_TAG={revision}\n"
            f"Environment=CAMPUS_RUNTIME_ENV_FILE={RUNTIME}\n"
            f"ExecCondition=/usr/bin/test -f {work / 'reviewed-release.json'}\n{boot}"
            f"ExecStart=\nExecStart={cmd} up --wait --wait-timeout 90\nExecStop=\nExecStop={cmd} stop\n")


def override_content(image, run_id, policy, frozen, accounts=True):
    label = LABEL if accounts else "canon.release099.run"
    return (f'services:\n  app:\n    image: "{image}"\n    restart: "{policy}"\n'
            f'    labels:\n      {label}: "{run_id}"\n    environment:\n'
            f'      CANON_DEPLOY_FREEZE_WRITES: "{str(frozen).lower()}"\n'
            f'      CANON_DISK_RECOVERY: "{str(not frozen).lower()}"\n'
            + ('      CAMPUS_EMAIL_ACCOUNTS_ENABLED: "false"\n' if accounts else '')
            + ('      CAMPUS_YANDEX_OAUTH_ENABLED: "false"\n' if frozen else ''))


def identity(revision, image, run_id, version=VERSION):
    return {"revision": revision, "image": image, "run": run_id, "version": version}


def includes(payload, expected):
    return all(type(payload.get(key)) is type(value) and payload.get(key) == value for key, value in expected.items())


def baseline():
    """Bind both rollback generations and return the effective inherited conditions."""
    prior = STATE / "release099-f099n24a"
    base = STATE / f"release100-{BASE_RUN}"
    conditions = []
    gate_files = []
    for path, test in [
        (STATE / "precutover096-f096n23b/new-writer-attempted.json", "-f"),
        (STATE / "precutover096-f096n23b/new-writer-blocked.json", "! -e"),
        (STATE / "ui097-f097n23a/compat-gate.json", "-f"),
        (STATE / "release098-f098n24a/reviewed-release.json", "-f"),
        (STATE / "release098-f098n24b/reviewed-release.json", "-f"),
        (prior / "reviewed-release.json", "-f"),
        (base / "reviewed-release.json", "-f"),
    ]:
        private(path.parent, directory=True)
        if test == "-f":
            private(path)
            gate_files.append(path)
        else:
            check(absent(path))
        conditions.append(f"/usr/bin/test {test} {path}")

    prior_proof = identity(PRIOR_REV, PRIOR_IMAGE, "f099n24a", "0.9.9")
    check(includes(read(prior / "reviewed-release.json"), prior_proof))
    check(includes(read(prior / "accepted.json"), {
        **prior_proof, "status": "accepted", "restored": True, "inventoryUnchanged": True,
    }))
    private(prior / "before.json")
    check_config(prior, "27-release-099.conf", PRIOR_REV, PRIOR_IMAGE, "f099n24a", accounts=False)
    check_config(base, "28-release-100.conf", BASE_REV, BASE_IMAGE, BASE_RUN)

    build = STATE / f"build100-{BASE_REV}"
    private(build, directory=True)
    provenance = verified_receipt(build, BASE_REV, BASE_IMAGE)
    check(provenance["ciRunId"] == BASE_CI_RUN)
    accepted = read(base / "accepted.json")
    gate = read(base / "reviewed-release.json")
    check(includes(gate, {
        **identity(BASE_REV, BASE_IMAGE, BASE_RUN), **provenance, "migrated": True,
        "previousRevision": PRIOR_REV, "previousImage": PRIOR_IMAGE, "previousVersion": "0.9.9",
    }))
    check(includes(accepted, {
        **gate, "status": "accepted", "restored": True, "inventoryUnchanged": True, "accountTablesEmpty": True,
        "emailAccountsEnabled": False, "yandexOAuthStartVerified": True,
    }))
    return base, build / "source", conditions, gate_files


def check_config(work, pin_name, revision, image, run_id, accounts=True, *, boot_command=None):
    pin = DROPINS / pin_name
    override = work / "image.override.yml"
    private(pin)
    private(override)
    check(pin.read_bytes() == pin_content(work, revision, boot_command).encode())
    check(override.read_bytes() == override_content(image, run_id, "unless-stopped", False, accounts).encode())


def prop(name):
    return run(["systemctl", "show", "--value", "-p", name, UNIT])


def command(prop_name, expected):
    check(re.findall(r"argv\[\]=(.*?) ; ignore_errors=", prop(prop_name)) == expected)


def image_check(image, revision, version=VERSION):
    check(run(["docker", "image", "inspect", "--format",
               '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} '
               '{{index .Config.Labels "org.opencontainers.image.version"}}', image]) == f"{image} {revision} {version}")


def production_container():
    rows = run(["docker", "ps", "-a", "--no-trunc", "--filter", PROJECT, "--format", "{{.ID}} {{.Names}}"])
    named = run(["docker", "ps", "-a", "--no-trunc", "--filter", f"name=^/{APP}$", "-q"])
    if not rows and not named:
        return None
    check(hex_digest(named) and rows == f"{named} {APP}")
    return named


def health(image, revision, policy, run_id, candidate_ids=None, *, version=VERSION, update=UPDATE_100):
    container = production_container()
    check(container is not None)
    check(run(["docker", "inspect", "--format", "{{.Image}} " + LABEL_FORMAT, container]) == f"{image} {run_id}")
    if candidate_ids is not None:
        check(run_id == update.run and image != update.base_image)
        candidate_ids.add(container)
    fmt = ('{{.Image}} {{.State.Running}} {{.State.Health.Status}} '
           '{{.HostConfig.RestartPolicy.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}} '
           '{{index .Config.Labels "org.opencontainers.image.version"}}')
    check(run(["docker", "inspect", "--format", fmt, container]) == f"{image} true healthy {policy} {revision} {version}")
    check(prop("ActiveState") == "active" and prop("NeedDaemonReload") == "no")
    check(run(["systemctl", "is-active", "kanon-runtime.service"]) == "active")
    for origin, options in [(INTERNAL, []), (PUBLIC, PUBLIC_RESOLVE)]:
        curl = ["curl", "--disable", "--noproxy", "*", "--fail", "--silent", "--max-time", "12", *options]
        payload = json.loads(run(curl + [origin + "/api/version"]))
        check(includes(payload, {"version": version, "revision": revision}))
        check(json.loads(run(curl + [origin + "/api/ready"])).get("status") == "ready")
    return container


def response_headers(url, options):
    response = run(["curl", "--disable", "--noproxy", "*", "--silent", "--max-time", "10", "-i", *options, url])
    status, *lines = response.replace("\r\n", "\n").partition("\n\n")[0].splitlines()
    headers = {}
    for line in lines:
        name, separator, value = line.partition(":")
        check(separator == ":")
        headers.setdefault(name.lower(), []).append(value.strip())
    return status.split()[1], headers


def freeze(expected):
    status, headers = response_headers(INTERNAL + "/api/ready", ["-X", "POST"])
    check(status == ("503" if expected else "405"))
    check(headers.get("x-canon-deploy-freeze", []) == (["writes"] if expected else []))
    if expected:
        for origin, options in [(INTERNAL, []), (PUBLIC, PUBLIC_RESOLVE)]:
            for method in [[], ["--head"]]:
                status, headers = response_headers(origin + "/api/auth/yandex/callback", options + method)
                check(status == "503" and headers.get("x-canon-deploy-freeze") == ["writes"])
                check("set-cookie" not in headers and "location" not in headers)


def oauth_start():
    status, headers = response_headers(PUBLIC + "/api/auth/yandex/start",
                                       PUBLIC_RESOLVE + ["-X", "POST", "-H", "Origin: " + PUBLIC])
    check(status == "303" and len(headers.get("location", [])) == len(headers.get("set-cookie", [])) == 1)
    redirect = urlsplit(headers["location"][0])
    query = parse_qs(redirect.query)
    check((redirect.scheme, redirect.netloc, redirect.path, redirect.fragment) ==
          ("https", "oauth.yandex.ru", "/authorize", ""))
    check(includes(query, {"redirect_uri": [PUBLIC + "/api/auth/yandex/callback"],
                           "response_type": ["code"], "code_challenge_method": ["S256"]}))
    check(len(query.get("client_id", [])) == 1)
    cookie, *attributes = [part.strip().lower() for part in headers["set-cookie"][0].split(";")]
    check(cookie.startswith("__host-vibecraft-oauth=") and
          {"path=/", "secure", "httponly", "samesite=lax"} <= set(attributes) and
          not any(attribute.startswith("domain=") for attribute in attributes))
    check(headers.get("referrer-policy") == ["no-referrer"] and
          any("no-store" in value for value in headers.get("cache-control", [])))


DOCKER_PROBE = [
    "docker", "run", "--rm", "--pull", "never", "--read-only", "--tmpfs", "/tmp:mode=1777",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "768m", "--cpus", "1",
]


def runtime_fingerprint():
    path = Path(RUNTIME)
    private(path)
    info = path.lstat()
    check(info.st_size > 0)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def runtime_check(image):
    # Existing application preflight validates Pilot accounts and storage config.
    predicate = """
const e = process.env;
if (!(/^[-_a-zA-Z0-9]{1,128}$/.test(e.YANDEX_OAUTH_CLIENT_ID?.trim() || '') &&
      e.YANDEX_OAUTH_CLIENT_SECRET?.trim() && e.CAMPUS_YANDEX_OAUTH_ENABLED === 'true' &&
      e.CAMPUS_EMAIL_ACCOUNTS_ENABLED === 'false' && e.CAMPUS_PUBLIC_ORIGIN === 'https://canon.midis.ru')) {
  process.exit(1);
}
"""
    flags = {
        "NODE_OPTIONS": "", "NODE_ENV": "production", "USE_DATABASE": "true",
        "NEXT_PUBLIC_DEMO_MODE": "false", "CAMPUS_DEMO_LOGIN": "false", "CAMPUS_LOCAL_DEMO": "false",
        "CAMPUS_FULL_LOCAL_DEMO": "false", "SEED_DEMO_ARTICLES": "false", "OUTPUT_MODE": "",
    }
    run(DOCKER_PROBE + ["--network", "none", "--env-file", RUNTIME]
        + [arg for name, value in flags.items() for arg in ("-e", f"{name}={value}")]
        + ["--entrypoint", "node", image, "--import", "tsx", "-e",
           predicate + "require('./deploy/preflight.ts');"])


def ttl_check(image):
    # This probe uses only DescribeTimeToLive on existing production tables.
    predicate = """
const {DynamoDBClient, DescribeTimeToLiveCommand} = require('@aws-sdk/client-dynamodb');
const e = process.env;
const client = new DynamoDBClient({
  endpoint: e.DOCUMENT_API_ENDPOINT, region: e.DOCUMENT_API_REGION || 'ru-central1', maxAttempts: 1,
  credentials: {accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
                sessionToken: e.AWS_SESSION_TOKEN},
});
Promise.all(['account-sessions', 'account-rate-limits'].map(TableName =>
  client.send(new DescribeTimeToLiveCommand({TableName}), {abortSignal: AbortSignal.timeout(10000)})
)).then(all => {
  if (!all.every(({TimeToLiveDescription: d}) =>
    d?.AttributeName === 'expiresAt' && ['ENABLED', 'ENABLING'].includes(d.TimeToLiveStatus))) process.exitCode = 1;
}).catch(() => { process.exitCode = 1; }).finally(() => client.destroy());
"""
    run(DOCKER_PROBE + ["--env-file", RUNTIME, "-e", "NODE_OPTIONS=", "--entrypoint", "node", image, "-e", predicate])


def backup(work, label, action, archive, image, prefix=None, *, update=UPDATE_100):
    container = f"kanon{update.series}-{update.run}-{label}"
    query = ["docker", "ps", "-a", "--no-trunc", "--filter", f"name=^/{container}$", "-q"]
    check(not run(query))
    marker = f"canon.release{update.series}.maintenance"
    args = [action, f"/backup/{archive}"]
    if action == "snapshot":
        args += ["--writers-stopped"]
    elif action == "restore":
        check(prefix == update.restore_prefix())
        args += ["--prefix", prefix]
    network = ["--network", "none"] if action == "verify" else ["--env-file", RUNTIME]
    command = DOCKER_PROBE + network + ["--name", container, "--label", f"{marker}={update.run}", "--user", "0:0",
        "-e", "USE_DATABASE=true", "-e", "CANON_DISK_RECOVERY=false", "-e", "NODE_OPTIONS=",
        "-e", "YANDEX_AI_STUDIO_API_KEY=", "-e", "YANDEX_DISK_OAUTH_TOKEN=", "-e", "ALIBABA_DASHSCOPE_API_KEY=",
        "-v", f"{work}:/backup", image, "node", "--import", "tsx", "scripts/database-backup.ts"]
    try:
        report = json.loads(run(command + args, timeout=900))
    finally:
        remaining = run(query)
        if remaining:
            check(hex_digest(remaining))
            fmt = '{{.Image}} {{index .Config.Labels "' + marker + '"}}'
            check(run(["docker", "inspect", "--format", fmt, remaining]) == f"{image} {update.run}")
            run(["docker", "rm", "-f", remaining])
    expected_status = {"snapshot": "saved", "verify": "verified", "restore": "restored"}
    check(report.get("status") == expected_status[action] and report.get("tables") == len(TABLES))
    counts = report.get("tableCounts")
    check(isinstance(counts, dict) and counts.keys() == TABLES)
    check(all(type(count) is int and count >= 0 for count in counts.values()))
    check(hex_digest(report.get("sha256")) and report.get("entries") == sum(counts.values()))
    record(work / (label + ".json"), report)
    return {key: report[key] for key in ("sha256", "tableCounts")}


def cutoff(archive):
    value = archive["createdAt"]
    check(bool(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value)))
    timestamp = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    delta = timestamp - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return Decimal(delta.days * 86400 + delta.seconds) + Decimal(delta.microseconds) / 1000000


def ttl_active(item, cutoff_value):
    value = item.get("expiresAt", {}).get("N")
    return value is None or Decimal(value) > cutoff_value


def inventory(path, report):
    archive = read(path)
    check(archive["scope"] == "current" and hex_digest(archive["sourceSha256"]))
    check(archive["sha256"] == report["sha256"])
    timestamp = cutoff(archive)
    tables = {row["name"]: row for row in archive["tables"]}
    check(len(tables) == len(archive["tables"]) and tables.keys() == TABLES)
    check(report["tableCounts"] == {name: row["count"] for name, row in tables.items()})
    check(all(hex_digest(row["sha256"]) for row in tables.values()))
    ttl = {}
    for name in TTL_TABLES:
        row = tables[name]
        items = {item["id"]["S"]: item for item in row["items"]}
        check(len(items) == row["count"] and all(ttl_active(item, timestamp) for item in items.values()))
        ttl[name] = (row["schema"], items)
    stable = {name: (row["count"], row["sha256"]) for name, row in tables.items() if name not in TTL_TABLES}
    return timestamp, archive["sourceSha256"], stable, ttl


def verify_unchanged(before, after):
    old_cutoff, old_source, old_stable, old_ttl = before
    new_cutoff, new_source, new_stable, new_ttl = after
    check(old_cutoff <= new_cutoff and old_source == new_source and old_stable == new_stable)
    for name in TTL_TABLES:
        old_schema, old_items = old_ttl[name]
        new_schema, new_items = new_ttl[name]
        check(old_schema == new_schema)
        # Both archives independently use their fixed cutoff. Compare all rows
        # still live at the later cutoff, including rows without numeric TTL.
        check(new_items == {key: item for key, item in old_items.items() if ttl_active(item, new_cutoff)})


def boot_id():
    value = BOOT_ID_FILE.read_text(encoding="ascii").strip()
    check(bool(re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value)))
    return value


def boot_gate(expected_boot, revision, image, *, update=UPDATE_100):
    """Allow controlled starts this boot and fully authorized activation on later boots."""
    work = update.work(STATE)
    private(work, directory=True)
    expected = identity(revision, image, update.run, update.version)
    gate = work / "reviewed-release.json"
    if absent(gate) or not includes(read(gate), expected):
        return False
    if expected_boot == boot_id():
        return True
    activation = work / "activation-authorized.json"
    return not absent(activation) and includes(read(activation), {**expected, "status": "activation-authorized"})


def rollback_target(image, candidate_ids, update=UPDATE_100):
    container = production_container()
    if container is None:
        return None, False, False, None
    fmt = "{{.Image}} " + LABEL_FORMAT + " {{.State.Running}} {{.HostConfig.RestartPolicy.Name}}"
    actual_image, run_id, running, policy = run(["docker", "inspect", "--format", fmt, container]).split()
    candidate = (actual_image, run_id) == (image, update.run)
    if candidate:
        candidate_ids.add(container)
    check((candidate or (actual_image, run_id) == (update.base_image, update.base_run)) and running in ["true", "false"])
    return container, candidate, running == "true", policy


def stopped():
    check(not run(["docker", "ps", "--filter", PROJECT, "-q"]))
    check(prop("ActiveState") in ["inactive", "failed"])


def best_effort(action, *args, **kwargs):
    try:
        action(*args, **kwargs)
        return True
    except BaseException:
        return False


def withdraw_review(gate):
    if not absent(gate):
        os.replace(gate, gate.with_name("blocked-release.json"))
        fsync_directory(gate.parent)


def owned_pin(pin, staged_pin, expected_pin):
    private(pin)
    check(pin.samefile(staged_pin) and pin.read_bytes() == expected_pin.encode())


def discover_for_rollback(image, candidate_ids, update=UPDATE_100):
    try:
        return rollback_target(image, candidate_ids, update)
    except BaseException:
        # Unknown topology cannot authorize a project-wide systemd stop.
        # Any already proven immutable IDs can still be stopped directly.
        return None


def quiesce_candidate(container):
    best_effort(run, ["docker", "update", "--restart", "no", container])
    best_effort(run, ["docker", "container", "stop", "--time", "20", container], timeout=35)


def rollback_candidate(work, pin, staged_pin, expected_pin, image, candidate_ids, update=UPDATE_100):
    accepted = work / "accepted.json"
    activation = work / "activation-authorized.json"
    gate = work / "reviewed-release.json"
    best_effort(unlink_synced, accepted)
    best_effort(unlink_synced, activation)
    best_effort(withdraw_review, gate)

    pinned = not absent(pin)
    owns_pin = pinned and best_effort(owned_pin, pin, staged_pin, expected_pin)

    attempted = set()

    def quiesce_remembered():
        for container in sorted(candidate_ids - attempted):
            quiesce_candidate(container)
            attempted.add(container)

    # The app may still be writing. Target verified IDs immediately, without
    # making another successful Docker discovery a prerequisite for stopping.
    quiesce_remembered()
    observed = discover_for_rollback(image, candidate_ids, update)
    if observed is None:
        observed = discover_for_rollback(image, candidate_ids, update)
    if observed is not None:
        _, candidate, running, _ = observed
        quiesce_remembered()
        if owns_pin and (candidate or not running):
            best_effort(run, ["systemctl", "stop", UNIT], timeout=120)
    # Cancelling a start may leave a container created after the first lookup.
    discover_for_rollback(image, candidate_ids, update)
    quiesce_remembered()

    check(all(absent(path) for path in (accepted, activation, gate)))
    fsync_directory(work)
    container, candidate, running, policy = rollback_target(image, candidate_ids, update)
    if candidate and (running or policy != "no"):
        quiesce_candidate(container)
        _, candidate, running, policy = rollback_target(image, candidate_ids, update)
    if candidate:
        check(not running and policy == "no")
    if pinned:
        check(owns_pin)
        # The accepted writer may have won a start race before our closed
        # pin was loaded. Keep that writer running and restore its unit.
        if candidate or not running:
            stopped()
        owned_pin(pin, staged_pin, expected_pin)
        unlink_synced(pin)


@contextmanager
def defer_acceptance_signals():
    if not hasattr(signal, "pthread_sigmask"):
        yield
        return
    signals = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP}
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def main(*, update=UPDATE_100, script=None, baseline_gate=baseline):
    try:
        with ExitStack() as cleanup:
            cutover(cleanup, update, script, baseline_gate)
    except BaseException:
        if phase != "accepted":
            raise


def report_accepted(proof):
    message = json.dumps({**proof, "status": "accepted"}, sort_keys=True) + "\n"
    if sys.stdout is sys.__stdout__:
        # Bypass the buffered stream so a closed pipe cannot cause another
        # failed flush and change the exit code at interpreter shutdown.
        os.write(sys.stdout.fileno(), message.encode("utf-8"))
    else:
        print(message, end="", flush=True)


def cutover(cleanup, update=UPDATE_100, script=None, baseline_gate=baseline):
    global phase
    phase = "arguments"
    os.umask(0o077)
    check(os.geteuid() == 0 and len(sys.argv) == 4)
    script = SCRIPT if script is None else script
    revision, image, run_id = sys.argv[1:]
    check(hex_digest(revision, size=40) and revision != update.base_revision)
    check(hex_digest(image, prefix="sha256:") and image != update.base_image and run_id == update.run)
    work = update.work(STATE)
    pin = DROPINS / update.pin_name
    gate = work / "reviewed-release.json"
    activation = work / "activation-authorized.json"
    accepted = work / "accepted.json"
    override = work / "image.override.yml"
    phase = "baseline-gates"
    trusted_directories(STATE)
    trusted_directories(DROPINS)
    private(STATE, directory=True)
    lock_path = STATE / "backup096.lock"
    private(lock_path)
    lock = cleanup.enter_context(lock_path.open("rb"))
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check(absent(pin) and absent(work))
    base, base_source, conditions, gate_files = baseline_gate()
    old_dropins = {name: DROPINS / name for name in (*OLD_DROPINS, *update.inherited_dropins)}
    for path in old_dropins.values():
        trusted_file(path)
    hashes = {path: digest(path) for path in old_dropins.values()}
    for path in (*gate_files, base / "accepted.json", base / "image.override.yml"):
        hashes[path] = digest(path)
    disk = os.statvfs(STATE)
    check(disk.f_bavail * disk.f_frsize >= 3 * 64 * 1024 * 1024 and disk.f_favail >= 32)
    dropin_disk = os.statvfs(DROPINS)
    check(dropin_disk.f_bavail * dropin_disk.f_frsize >= 4096 and dropin_disk.f_favail >= 2)

    phase = "candidate-source"
    build = update.build(STATE, revision)
    private(build, directory=True)
    provenance = verified_receipt(build, revision, image)
    check(provenance["ciRunId"] != update.base_ci_run)
    source = build / "source"
    private(source, directory=True)
    check(script == script.resolve() == source / "deploy" / update.script_name)
    production_compose = REPO / "deploy/compose.prod.yml"
    check(production_compose == production_compose.resolve())
    check(all(digest(root / "deploy/compose.prod.yml") == COMPOSE_SHA256 for root in [REPO, source, base_source]))
    check(read(source / "package.json").get("version") == update.version)
    for relative in ("lib/schema.ts", "lib/database-backup.ts", "scripts/database-backup.ts"):
        check(digest(source / relative) == digest(base_source / relative))
    this_boot = boot_id()
    boot_command = f"/usr/bin/python3 -B {script} --boot-gate {this_boot} {revision} {image}"
    expected_pin = pin_content(work, revision, boot_command)

    def unit(candidate=False):
        paths = list(old_dropins.values()) + ([pin] if candidate else [])
        check(prop("DropInPaths").split() == [str(path) for path in paths])
        check(prop("WorkingDirectory") == str(REPO) and prop("NeedDaemonReload") == "no" and prop("Restart") == "no")
        check(digest(production_compose) == COMPOSE_SHA256)
        check(all(digest(path) == value for path, value in hashes.items()))
        if candidate:
            private(pin)
            check(pin.read_bytes() == expected_pin.encode())
        cmd = compose(work if candidate else base)
        command("ExecStart", [cmd + " up --wait --wait-timeout 90"])
        command("ExecStop", [cmd + " stop"])
        command("ExecCondition", conditions + ([f"/usr/bin/test -f {gate}", boot_command] if candidate else []))

    phase = "preflight"
    unit()
    image_check(update.base_image, update.base_revision, update.base_version)
    image_check(image, revision, update.version)
    runtime = runtime_fingerprint()
    runtime_check(image)
    old_id = health(update.base_image, update.base_revision, "unless-stopped", update.base_run,
                    version=update.base_version, update=update)
    candidate_ids = set()
    freeze(False)
    oauth_start()
    ttl_check(update.base_image)
    check(runtime_fingerprint() == runtime)
    work.mkdir(mode=0o700)
    fsync_directory(STATE)
    proof = {**identity(revision, image, update.run, update.version), **provenance,
             "previousRevision": update.base_revision, "previousImage": update.base_image,
             "previousVersion": update.base_version, "previousRun": update.base_run, "oldContainer": old_id}
    publish(override, override_content(image, update.run, "no", True))
    with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{pin.stem}-", dir=DROPINS, delete=False) as staged:
        staged_pin = Path(staged.name)
        cleanup.callback(unlink_synced, staged_pin)
        staged.write(expected_pin.encode())
        staged.flush()
        os.fsync(staged.fileno())
    private(staged_pin)

    try:
        phase = "stop-writers"
        run(["systemctl", "stop", UNIT], timeout=120)
        stopped()
        phase = "pin-closed"
        os.link(staged_pin, pin)
        fsync_directory(DROPINS)
        run(["systemctl", "daemon-reload"])
        unit(True)
        check(not boot_gate(this_boot, revision, image, update=update))
        phase = "baseline-snapshot"
        stopped()
        before = backup(work, "baseline-capture", "snapshot", "before.json", update.base_image, update=update)
        phase = "baseline-verify"
        check(backup(work, "baseline-verify", "verify", "before.json", update.base_image, update=update) == before)
        phase = "baseline-isolated-restore"
        prefix = update.restore_prefix()
        check(backup(work, "baseline-restore", "restore", "before.json", update.base_image, prefix, update=update) == before)
        previous_inventory = inventory(work / "before.json", before)
        stopped()
        check(runtime_fingerprint() == runtime)
        proof.update(baselineBackupSha256=before["sha256"], baselineTableCounts=before["tableCounts"],
                     baselineRestorePrefix=prefix, restored=True)
        record(gate, proof)

        phase = "frozen-start"
        run(["systemctl", "start", UNIT], timeout=120)
        frozen_id = health(image, revision, "no", update.run, candidate_ids, version=update.version, update=update)
        freeze(True)
        ttl_check(image)
        phase = "frozen-snapshot"
        frozen = backup(work, "frozen-capture", "snapshot", "frozen.json", image, update=update)
        phase = "frozen-verify"
        check(backup(work, "frozen-verify", "verify", "frozen.json", image, update=update) == frozen)
        verify_unchanged(previous_inventory, inventory(work / "frozen.json", frozen))
        check(health(image, revision, "no", update.run, candidate_ids, version=update.version, update=update) == frozen_id)
        freeze(True)
        unit(True)
        check(runtime_fingerprint() == runtime)
        proof.update(frozenBackupSha256=frozen["sha256"], frozenTableCounts=frozen["tableCounts"],
                     frozenContainer=frozen_id, inventoryUnchanged=True, emailAccountsEnabled=False)
        record(work / "frozen-verified.json", {**proof, "status": "frozen-verified"})

        phase = "open-writes"
        run(["systemctl", "stop", UNIT], timeout=120)
        stopped()
        publish(override, override_content(image, update.run, "no", False))
        run(["systemctl", "start", UNIT], timeout=120)
        active_id = health(image, revision, "no", update.run, candidate_ids, version=update.version, update=update)
        freeze(False)
        oauth_start()
        check(runtime_fingerprint() == runtime)
        unit(True)
        phase = "authorize-restart"
        publish(override, override_content(image, update.run, "unless-stopped", False))
        # Only now may Docker restart the candidate independently of systemd.
        # This authorization survives reboot. The final acceptance does not
        # exist until the live restart policy and all service checks pass.
        proof.update(container=active_id, yandexOAuthStartVerified=True)
        record(activation, {**proof, "status": "activation-authorized"})
        run(["docker", "update", "--restart", "unless-stopped", active_id])
        check(health(image, revision, "unless-stopped", update.run, candidate_ids,
                     version=update.version, update=update) == active_id)
        check(runtime_fingerprint() == runtime)
        unit(True)
        phase = "accept-receipt"
        with defer_acceptance_signals():
            record(accepted, {**proof, "status": "accepted"})
            # The commit point is successful publication and directory fsync.
            phase = "accepted"
    except BaseException:
        if phase == "accepted":
            raise
        failed_phase = phase
        phase = "rollback"
        try:
            rollback_candidate(work, pin, staged_pin, expected_pin, image, candidate_ids, update)
            run(["systemctl", "daemon-reload"])
            unit()
            check_config(base, update.base_pin, update.base_revision, update.base_image, update.base_run,
                         boot_command=conditions[-1] if update.inherited_dropins else None)
            if prop("ActiveState") != "active":
                run(["systemctl", "start", UNIT], timeout=120)
            health(update.base_image, update.base_revision, "unless-stopped", update.base_run,
                   version=update.base_version, update=update)
            freeze(False)
            record(work / "rollback.json", {"status": "rolled-back", "phase": failed_phase,
                                           "revision": update.base_revision, "image": update.base_image,
                                           "dataRestored": False})
        except BaseException:
            phase = "rollback-incomplete"
            best_effort(record, work / "rollback-incomplete.json", {
                "status": "rollback-incomplete", "phase": failed_phase, "dataRestored": False,
            })
            raise
        phase = failed_phase + ":rolled-back-to-accepted-" + update.base_version.replace(".", "")
        raise
    report_accepted(proof)


def cli(*, update=UPDATE_100, script=None, baseline_gate=baseline):
    if len(sys.argv) == 5 and sys.argv[1] == "--boot-gate":
        try:
            sys.exit(0 if boot_gate(*sys.argv[2:], update=update) else 1)
        except Exception:
            sys.exit(1)

    def interrupt(_signum, _frame):
        raise InterruptedError("update interrupted")

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    try:
        main(update=update, script=script, baseline_gate=baseline_gate)
    except BaseException:
        if phase != "accepted":
            status = "rollback-incomplete" if phase == "rollback-incomplete" else "failed"
            print(json.dumps({"status": status, "phase": phase}), file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    cli()
