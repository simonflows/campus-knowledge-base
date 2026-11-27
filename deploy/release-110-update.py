#!/usr/bin/env python3
"""Switch accepted Canon 1.0.0 to immutable 1.1.0 without a working-schema change."""
from importlib import import_module
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
engine = import_module("release-100-update")

SCRIPT = Path(__file__).absolute()
UPDATE = engine.Update(
    run="f110n27a", version="1.1.0", series="110",
    pin_name="30-release-110.conf", script_name=SCRIPT.name,
    base_run="f100n26b", base_revision="c1405c6987bd22b0c740c935c0af28625dc79fa7",
    base_image="sha256:7e8eecacabbbfeaf56ab5bf8737a73757487ef9bdff1e6fc7d3f3cbc5419543b",
    base_version="1.0.0", base_ci_run=45748848661, base_pin="29-release-100-update.conf",
    inherited_dropins=("29-release-100-update.conf",),
)
BOOT_PATTERN = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"


def proof_inventory(proof, kind):
    engine.check(engine.hex_digest(proof.get(kind + "BackupSha256")))
    counts = proof.get(kind + "TableCounts")
    engine.check(isinstance(counts, dict) and counts.keys() == engine.TABLES)
    engine.check(all(type(count) is int and count >= 0 for count in counts.values()))


def baseline():
    """Extend the inherited conditions with both gates for the accepted 1.0.0 update."""
    _, _, conditions, gate_files = engine.baseline()
    base = engine.STATE / f"release100-{UPDATE.base_run}"
    build = engine.STATE / f"build100-{UPDATE.base_revision}"
    engine.private(base, directory=True)
    engine.private(build, directory=True)
    provenance = engine.verified_receipt(build, UPDATE.base_revision, UPDATE.base_image)
    engine.check(engine.includes(provenance, {
        "ciRunId": UPDATE.base_ci_run,
        "ciArtifactId": 15084817585,
        "ciArtifactSha256": "sha256:ab5a49d715920693b45307e02bcbf3c2dd31563650e1a673331e4e4a74599a95",
        "snapshotCommitted": "sha256:14cc64b8c5390335deb8ca00d8fb3f6a533d7e989ac37c89efcd8f663fd4bf50",
    }))
    source = build / "source"
    engine.check(engine.read(source / "package.json").get("version") == UPDATE.base_version)
    reviewed_path = base / "reviewed-release.json"
    frozen_path = base / "frozen-verified.json"
    activation_path = base / "activation-authorized.json"
    gate, frozen, activation, accepted = [engine.read(path) for path in (
        reviewed_path, frozen_path, activation_path, base / "accepted.json",
    )]
    engine.check(engine.includes(gate, {
        **engine.identity(UPDATE.base_revision, UPDATE.base_image, UPDATE.base_run, UPDATE.base_version),
        **provenance, "previousRevision": engine.BASE_REV, "previousImage": engine.BASE_IMAGE,
        "previousRun": engine.BASE_RUN, "previousVersion": "1.0.0", "restored": True,
        "baselineRestorePrefix": "qa095-100-f100n26b-old-",
    }))
    proof_inventory(gate, "baseline")
    proof_inventory(frozen, "frozen")
    engine.check(engine.includes(frozen, {
        **gate, "status": "frozen-verified", "inventoryUnchanged": True, "emailAccountsEnabled": False,
    }))
    engine.check(engine.includes(accepted, {**frozen, "status": "accepted", "yandexOAuthStartVerified": True}))
    engine.check(activation == {**accepted, "status": "activation-authorized"})
    engine.check(all(engine.hex_digest(accepted.get(name)) for name in ("oldContainer", "frozenContainer", "container")))

    pin = engine.DROPINS / UPDATE.base_pin
    engine.private(pin)
    prefix = f"/usr/bin/python3 -B {source / 'deploy/release-100-update.py'} --boot-gate "
    suffix = f" {UPDATE.base_revision} {UPDATE.base_image}"
    commands = [line.removeprefix("ExecCondition=") for line in pin.read_text(encoding="utf-8").splitlines()
                if line.startswith("ExecCondition=/usr/bin/python3 ")]
    engine.check(len(commands) == 1 and re.fullmatch(re.escape(prefix) + BOOT_PATTERN + re.escape(suffix), commands[0]))
    boot_command = commands[0]
    engine.check_config(base, UPDATE.base_pin, UPDATE.base_revision, UPDATE.base_image, UPDATE.base_run,
                        boot_command=boot_command)
    return base, source, conditions + [f"/usr/bin/test -f {reviewed_path}", boot_command], (
        *gate_files, reviewed_path, frozen_path, activation_path,
    )


def main():
    engine.main(update=UPDATE, script=SCRIPT, baseline_gate=baseline)


if __name__ == "__main__":
    engine.cli(update=UPDATE, script=SCRIPT, baseline_gate=baseline)
