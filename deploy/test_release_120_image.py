"""Check CI binding and native snapshot attestation without Docker or GitHub."""
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import ci_image_load_100 as shared
import ci_image_load_120 as loader
from test_release_110_image import artifact
from test_release_ci_image_100 import IMAGE, IMAGE_ID, REVISION, RUN_ID

CHAIN = "sha256:" + "1" * 64
SNAPSHOT_COMMAND = ["/usr/bin/ctr", "--address", "/run/containerd/containerd.sock", "--namespace", "moby",
                    "snapshots", "--snapshotter", "overlayfs", "info", CHAIN]


class Image120Tests(unittest.TestCase):
    def test_authenticated_110_artifact_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, responses = artifact(root, "1.1.0")
            output = root / "verified"
            with patch.object(shared, "github", responses.__getitem__), self.assertRaises(RuntimeError):
                loader.verify_artifact(REVISION, RUN_ID, bundle, output)
            self.assertFalse((output / shared.PROVENANCE).exists())

    def test_staging_receipt_requires_exact_committed_native_snapshot(self):
        for name, kind in [(CHAIN, "Committed"), (CHAIN, "Active"), ("sha256:" + "2" * 64, "Committed")]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                bundle, responses = artifact(root, "1.2.0")
                build = root / f"build120-{REVISION}"
                with patch.object(shared, "github", responses.__getitem__):
                    proof = loader.verify_artifact(REVISION, RUN_ID, bundle, build)
                (build / shared.IMAGE_ARCHIVE).unlink()

                def docker(*args):
                    if args[:2] == ("image", "inspect") and args[-1] == "campus-kb:" + REVISION:
                        return f"{IMAGE_ID} linux amd64 {REVISION} 1.2.0"
                    if args == ("image", "inspect", "--format", "{{json .RootFS.Layers}}", IMAGE_ID):
                        return json.dumps([CHAIN])
                    if args == ("create", "--pull", "never", "--network", "none", "--entrypoint", "/bin/true", IMAGE_ID):
                        return "a" * 64
                    if args == ("rm", "a" * 64):
                        return "a" * 64
                    self.fail(f"unexpected Docker arguments: {args}")

                def ctr(args, **kwargs):
                    self.assertEqual(args, SNAPSHOT_COMMAND)
                    self.assertTrue(kwargs["check"])
                    return SimpleNamespace(stdout=json.dumps({"Name": name, "Kind": kind}).encode())

                def load_stream(stream, stream_proof):
                    self.assertEqual(shared.hash_stream(stream), (stream_proof["gzipSha256"], stream_proof["gzipBytes"]))

                owner = getattr(os, "geteuid", lambda: 0)()
                manifest = shared.tree_manifest
                with patch.object(loader, "STATE", root), \
                     patch.object(shared, "private_exact", lambda path, _: self.assertTrue(path.exists())), \
                     patch.object(shared, "tree_manifest", lambda path: manifest(path, owner)), \
                     patch.object(os, "geteuid", lambda: 0, create=True), \
                     patch.object(os, "statvfs", lambda _: SimpleNamespace(f_bavail=1_000_000, f_frsize=4096), create=True), \
                     patch.object(shared, "load_image", load_stream), patch.object(shared, "docker_command", docker), \
                     patch.object(subprocess, "run", ctr):
                    if (name, kind) == (CHAIN, "Committed"):
                        receipt = loader.load_verified(REVISION, io.BytesIO(IMAGE))
                        self.assertEqual(receipt, {**proof, "loaded": True, "snapshotCommitted": CHAIN})
                        self.assertEqual(json.loads((build / shared.RECEIPT).read_text()), receipt)
                    else:
                        with self.assertRaises(RuntimeError):
                            loader.load_verified(REVISION, io.BytesIO(IMAGE))
                        self.assertFalse((build / shared.RECEIPT).exists())

    def test_live_snapshot_check_rejects_receipt_for_another_chain(self):
        with patch.object(shared, "docker_command", return_value=json.dumps([CHAIN])), \
             patch.object(subprocess, "run", side_effect=AssertionError("queried unrelated native chain")):
            with self.assertRaises(RuntimeError):
                loader.require_snapshot(IMAGE_ID, "sha256:" + "2" * 64)
