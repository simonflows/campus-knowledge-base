#!/usr/bin/env python3
"""Materialize the Canon runtime configuration without logging secret values."""

import fcntl
import json
import os
import re
import stat
import sys
import tempfile
import warnings
from getpass import GetPassWarning, getpass
from hashlib import sha256
from pathlib import Path
from secrets import token_hex
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class RefuseRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = build_opener(ProxyHandler({}), RefuseRedirects())


def request_json(url, headers):
    with HTTP.open(Request(url, headers=headers), timeout=15) as response:
        return json.load(response)


def read_private(path):
    try:
        descriptor = os.open(path, os.O_NOFOLLOW | os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, encoding="utf-8") as private_file:
        info = os.fstat(private_file.fileno())
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise ValueError("Unsafe private settings file")
        return private_file.read()


def atomic_write(destination, contents, *, create_only=False):
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=destination.parent, delete=False
    ) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
            if create_only:
                os.link(temporary, destination)
            else:
                os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)


def configure(secret_id, expected_endpoint, origin):
    if not re.fullmatch(r"[a-z0-9]{20}", secret_id):
        raise ValueError("Invalid Lockbox secret ID")
    if not expected_endpoint.startswith("https://docapi.serverless.yandexcloud.net/"):
        raise ValueError("Invalid YDB endpoint")
    token = request_json(
        "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
        {"Metadata-Flavor": "Google"},
    )["access_token"]
    result = request_json(
        f"https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/{secret_id}/payload",
        {"Authorization": f"Bearer {token}"},
    )
    fields = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DOCUMENT_API_ENDPOINT"}
    disk_token_field = "YANDEX_DISK_OAUTH_TOKEN"
    ai_key_field = "YANDEX_AI_STUDIO_API_KEY"
    allowed_fields = fields | {disk_token_field, ai_key_field}
    values = {
        entry["key"]: entry["textValue"]
        for entry in result["entries"]
        if entry["key"] in allowed_fields
    }
    if not fields <= values.keys() or values["DOCUMENT_API_ENDPOINT"] != expected_endpoint:
        raise ValueError("Missing database settings or unexpected YDB endpoint")
    if disk_token_field in values:
        values["YANDEX_DISK_ROOT_MODE"] = "app"
    if ai_key_field in values:
        ai_folder = os.environ.get("YANDEX_AI_STUDIO_FOLDER_ID", "")
        if not re.fullmatch(r"[a-z0-9]{20}", ai_folder):
            raise ValueError("Missing or invalid AI Studio folder ID")
        values["YANDEX_AI_STUDIO_FOLDER_ID"] = ai_folder
        values["YANDEX_AI_STUDIO_MODEL_URI"] = f"gpt://{ai_folder}/aliceai-llm-flash"

    runtime_dir = Path("/run/campus")
    state_dir = Path("/var/lib/canon")
    for directory in (runtime_dir, state_dir):
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_uid != 0:
            raise ValueError("Unsafe runtime settings directory")
        directory.chmod(0o700)

    accounts = read_private(state_dir / "accounts.json")
    if accounts is not None:
        session = state_dir / "session-secret"
        signing_key = read_private(session)
        if signing_key is None:
            signing_key = token_hex(32)
            atomic_write(session, signing_key)
        values.update(
            CAMPUS_PUBLIC_ORIGIN=origin,
            SESSION_SECRET=signing_key.removesuffix("\n").removesuffix("\r"),
            CAMPUS_PILOT_ACCOUNTS=json.dumps(
                json.loads(accounts),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )

    for value in values.values():
        if not isinstance(value, str) or not value or any(c in value for c in "\r\n\0"):
            raise ValueError("Invalid runtime setting")
    atomic_write(
        runtime_dir / "runtime.env",
        "".join(f"{name}={value}\n" for name, value in sorted(values.items())),
    )
    print("Runtime file prepared" if accounts is not None else "Database settings prepared")


def configure_owner(*, reset=False, from_stdin=False):
    if os.geteuid() != 0 or (from_stdin == sys.stdin.isatty()):
        raise ValueError("Run owner setup with sudo and the expected input mode")
    destination = Path("/var/lib/canon/accounts.json")
    existing = read_private(destination)
    if reset:
        previous = json.loads(existing or "[]")
        if len(previous) != 1 or (previous[0].get("login"), previous[0].get("profile")) != (
            "kanon-owner", "demo-admin"
        ):
            raise ValueError("Reset requires an existing standalone owner")
    elif existing is not None:
        raise ValueError("An account configuration already exists")

    if from_stdin:
        digest = re.fullmatch(rb"([0-9a-f]{64})(?:\r?\n)?", sys.stdin.buffer.read(67))
        if digest is None:
            raise ValueError("Invalid SHA-256 digest")
        key_hash = digest[1].decode("ascii")
    else:
        with warnings.catch_warnings():
            warnings.simplefilter("error", GetPassWarning)
            key = getpass("New access key for kanon-owner (43 ASCII letters or digits, - or _): ")
            if not re.fullmatch(r"[A-Za-z0-9_-]{43}", key):
                raise ValueError("The access key must be exactly 43 base64url characters")
            if key != getpass("Repeat the access key: "):
                raise ValueError("Access keys did not match")
        key_hash = sha256(key.encode()).hexdigest()
    owner = {
        "login": "kanon-owner",
        "name": "Администратор Канона",
        "profile": "demo-admin",
        "keyHash": key_hash,
    }
    lock_path = destination.with_name("accounts.lock")
    descriptor = os.open(lock_path, os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if read_private(destination) != existing:
            raise ValueError("Account configuration changed during input")
        if reset:
            owner = {**previous[0], "keyHash": owner["keyHash"]}
        atomic_write(destination, json.dumps([owner], ensure_ascii=False), create_only=not reset)
    print("Owner login: kanon-owner")


if __name__ == "__main__":
    try:
        if sys.argv[1:] in (["--create-owner"], ["--reset-owner"]):
            configure_owner(reset=sys.argv[1] == "--reset-owner")
        elif sys.argv[1:] == ["--reset-owner-from-hash"]:
            configure_owner(reset=True, from_stdin=True)
        else:
            configure(*sys.argv[1:])
    except Exception as error:
        status = getattr(error, "code", None)
        print(
            f"Could not prepare runtime settings: {type(error).__name__}"
            + (f" (HTTP {status})" if isinstance(status, int) else ""),
            file=sys.stderr,
        )
        sys.exit(1)
