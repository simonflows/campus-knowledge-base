#!/usr/bin/env python3
"""Verify and load the immutable Canon 1.2.0 image and its native snapshot."""
import json
import subprocess
import sys

sys.dont_write_bytecode = True
import ci_image_load_100 as release_image

VERSION = "1.2.0"
STATE = release_image.STATE
NAMESPACE = "build120"


def native_snapshot(chain):
    release_image.require(release_image.hex_digest(chain, prefix="sha256:"), "invalid native snapshot chain ID")
    result = subprocess.run([
        "/usr/bin/ctr", "--address", "/run/containerd/containerd.sock", "--namespace", "moby",
        "snapshots", "--snapshotter", "overlayfs", "info", chain,
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=30,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"})
    info = json.loads(result.stdout)
    release_image.require(isinstance(info, dict) and info.get("Name") == chain and info.get("Kind") == "Committed",
                          "exact native moby/overlayfs snapshot is not committed")


def require_snapshot(image, chain):
    release_image.require(release_image.image_chain(image) == chain, "native snapshot chain disagrees with image")
    native_snapshot(chain)


def verify_artifact(revision, run_id, bundle, output):
    return release_image.verify_artifact(revision, run_id, bundle, output, expected_version=VERSION)


def load_verified(revision, source):
    return release_image.load_verified(revision, source, state=STATE, namespace=NAMESPACE, expected_version=VERSION,
                                       snapshot_check=native_snapshot)


if __name__ == "__main__":
    release_image.main(verify=verify_artifact, load=load_verified, description=__doc__)
