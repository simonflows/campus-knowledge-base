#!/usr/bin/env python3
"""Switch accepted 1.1.0 to 1.2.0 and fence 1.1.0 before enabling new writes."""
from importlib import import_module
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
from ci_image_load_120 import require_snapshot

engine = import_module("release-100-update")
previous = import_module("release-110-update")

SCRIPT = Path(__file__).absolute()
UPDATE = engine.Update(
    run="f120n27a", version="1.2.0", series="120",
    pin_name="31-release-120.conf", script_name=SCRIPT.name,
    base_run="f110n27a", base_revision="2ab9a3f0c70311cd7c4773b3f85e4e5c6fbc189f",
    base_image="sha256:98a4b4b0a7144c0a465d89da078ff542e7d57cde5054be622060e624801b88f3",
    base_version="1.1.0", base_ci_run=45943480267, base_pin="30-release-110.conf",
    inherited_dropins=("29-release-100-update.conf", "30-release-110.conf"),
    block_old_writer_after_open=True,
)
ACCEPTED_110_CI = {
    "ciRunId": UPDATE.base_ci_run,
    "ciArtifactId": 15173687335,
    "ciArtifactBytes": 315806823,
    "ciArtifactSha256": "sha256:89f6448345f02854600c298877d7f6d99a1106dbeaed1526a4b55af262cb1711",
    "gzipBytes": 313950902,
    "gzipSha256": "1c1b9eea9c364e9250d079022e9c5ba840b1dcd58fdf49c0a536469b704d8dfd",
    "sourceArchiveSha256": "408aa955f6b642d7ffeef30d977b954b93a475a53b9dddb3bf94bdf3998335c2",
    "sourceManifestSha256": "1e15e9f23c26e6856bd485d271aa8abff6f027aba2f5321415d03ea2e57d7fa9",
    "snapshotCommitted": "sha256:2fb3b8d8e60351b01d0a93d154ec8725a47f33b33d53d258c4e8d590bb40dc80",
}
ACCEPTED_110_BACKUPS = {
    "baselineBackupSha256": "f2c753684de04249a725e8dd2cfe58c3ec70e2c4eaa8255eb255510c9e77b189",
    "frozenBackupSha256": "cf4041cbbcfcd20f2e5f29a30a2be497a807d7ad267c02fb4106aed39e8248fc",
}
ACCEPTED_110_CONTAINER = "c49026d11f27a2fa6693bcb8d3c169dd55cf95da99e4bce180dddd0b872df512"


def baseline():
    """Bind the 1.1.0 proof on top of the previously accepted boot chain."""
    prior, _, conditions, gate_files = previous.baseline()
    base = engine.STATE / f"release110-{UPDATE.base_run}"
    build = engine.STATE / f"build110-{UPDATE.base_revision}"
    engine.private(base, directory=True)
    engine.private(build, directory=True)
    provenance = engine.verified_receipt(build, UPDATE.base_revision, UPDATE.base_image)
    engine.check(engine.includes(provenance, ACCEPTED_110_CI))
    source = build / "source"
    engine.check(engine.read(source / "package.json").get("version") == UPDATE.base_version)
    require_snapshot(UPDATE.base_image, provenance["snapshotCommitted"])

    reviewed_path = base / "reviewed-release.json"
    frozen_path = base / "frozen-verified.json"
    activation_path = base / "activation-authorized.json"
    gate, frozen, activation, accepted = [engine.read(path) for path in (
        reviewed_path, frozen_path, activation_path, base / "accepted.json",
    )]
    engine.check(engine.includes(gate, {
        **engine.identity(UPDATE.base_revision, UPDATE.base_image, UPDATE.base_run, UPDATE.base_version),
        **provenance, "previousRevision": previous.UPDATE.base_revision, "previousImage": previous.UPDATE.base_image,
        "previousRun": previous.UPDATE.base_run, "previousVersion": previous.UPDATE.base_version, "restored": True,
        "baselineRestorePrefix": previous.UPDATE.restore_prefix(),
    }))
    previous.proof_inventory(gate, "baseline")
    previous.proof_inventory(frozen, "frozen")
    engine.check(engine.includes(frozen, {
        **gate, **ACCEPTED_110_BACKUPS, "status": "frozen-verified", "inventoryUnchanged": True,
        "emailAccountsEnabled": False,
    }))
    engine.check(engine.includes(accepted, {
        **frozen, "status": "accepted", "yandexOAuthStartVerified": True, "container": ACCEPTED_110_CONTAINER,
    }))
    engine.check(engine.includes(activation, {**accepted, "status": "activation-authorized"})
                 and activation.keys() == accepted.keys())
    engine.check(all(engine.hex_digest(accepted.get(name)) for name in ("oldContainer", "frozenContainer")))

    pin = engine.DROPINS / UPDATE.base_pin
    engine.private(pin)
    prefix = f"/usr/bin/python3 -B {source / 'deploy/release-110-update.py'} --boot-gate "
    suffix = f" {UPDATE.base_revision} {UPDATE.base_image}"
    commands = [line.removeprefix("ExecCondition=") for line in pin.read_text(encoding="utf-8").splitlines()
                if line.startswith("ExecCondition=/usr/bin/python3 ")]
    engine.check(len(commands) == 1 and re.fullmatch(re.escape(prefix) + previous.BOOT_PATTERN + re.escape(suffix), commands[0]))
    boot_command = commands[0]
    engine.check_config(base, UPDATE.base_pin, UPDATE.base_revision, UPDATE.base_image, UPDATE.base_run,
                        boot_command=boot_command)
    return base, source, conditions + [f"/usr/bin/test -f {reviewed_path}", boot_command], (
        *gate_files, prior / "accepted.json", prior / "image.override.yml", reviewed_path, frozen_path, activation_path,
    )


def boot_gate(expected_boot, revision, image):
    return engine.boot_gate(expected_boot, revision, image, update=UPDATE)


def main():
    engine.main(update=UPDATE, script=SCRIPT, baseline_gate=baseline, snapshot_check=require_snapshot)


if __name__ == "__main__":
    engine.cli(update=UPDATE, script=SCRIPT, baseline_gate=baseline, snapshot_check=require_snapshot)
