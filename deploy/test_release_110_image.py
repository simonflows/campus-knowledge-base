"""Release image verification without Docker, GitHub or production data."""
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import ci_image_load_100 as shared
import ci_image_load_110 as loader
import test_release_ci_image_100 as legacy_fixture
from test_release_ci_image_100 import IMAGE, IMAGE_ID, REVISION, RUN_ID


def artifact(directory, version):
    bundle, responses, _, _, meta = legacy_fixture.CIProvenanceTests().fixture(directory)
    source = directory / "source.tar.gz"
    with tarfile.open(source, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": REVISION}) as archive:
        root = tarfile.TarInfo("source")
        root.type = tarfile.DIRTYPE
        archive.addfile(root)
        data = json.dumps({"name": "campus-kb", "version": version}).encode()
        member = tarfile.TarInfo("source/package.json")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr(shared.IMAGE_ARCHIVE, IMAGE)
        archive.writestr("canon-release-image.sha256", hashlib.sha256(IMAGE).hexdigest() + "  " + shared.IMAGE_ARCHIVE)
        archive.writestr("canon-release-image.id", IMAGE_ID)
        archive.write(source, shared.SOURCE_ARCHIVE)
    meta.update(size_in_bytes=bundle.stat().st_size, digest="sha256:" + hashlib.sha256(bundle.read_bytes()).hexdigest())
    return bundle, responses


class Image110Tests(unittest.TestCase):
    def test_candidate_requires_110_source_even_from_authentic_ci(self):
        for version in ["1.0.0", "1.1.0"]:
            with self.subTest(version=version), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                bundle, responses = artifact(directory, version)
                output = directory / "verified"
                with patch.object(shared, "github", responses.__getitem__):
                    if version == "1.1.0":
                        proof = loader.verify_artifact(REVISION, RUN_ID, bundle, output)
                        self.assertEqual(proof["image"], IMAGE_ID)
                        self.assertTrue((output / shared.PROVENANCE).is_file())
                    else:
                        with self.assertRaises(RuntimeError):
                            loader.verify_artifact(REVISION, RUN_ID, bundle, output)
                        self.assertFalse((output / shared.PROVENANCE).exists())

    def test_vm_writes_new_receipt_only_for_exact_110_label_and_complete_layers(self):
        for label in ["1.0.0", "1.1.0"]:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                state = Path(tmp).resolve()
                bundle, responses = artifact(state, "1.1.0")
                build = state / f"build110-{REVISION}"
                with patch.object(shared, "github", responses.__getitem__):
                    shared.verify_artifact(REVISION, RUN_ID, bundle, build)
                (build / shared.IMAGE_ARCHIVE).unlink()
                calls = []
                layer = "sha256:" + "1" * 64
                probe = "a" * 64

                def docker(*args):
                    calls.append(args)
                    if args[:2] == ("image", "inspect"):
                        if args[-1] == "campus-kb:" + REVISION:
                            return f"{IMAGE_ID} linux amd64 {REVISION} {label}"
                        if args[-1] == IMAGE_ID:
                            return json.dumps([layer])
                    if args == ("create", "--pull", "never", "--network", "none", "--entrypoint", "/bin/true", IMAGE_ID):
                        return probe
                    if args == ("rm", probe):
                        return probe
                    raise AssertionError(args)

                def load_gzip(stream, proof):
                    self.assertEqual(shared.hash_stream(stream), (proof["gzipSha256"], proof["gzipBytes"]))

                owner = getattr(os, "geteuid", lambda: 0)()
                tree_manifest = shared.tree_manifest
                disk = type("Disk", (), {"f_bavail": 1000000, "f_frsize": 4096})()
                with patch.object(loader, "STATE", state), \
                     patch.object(shared, "private_exact", lambda path, _: self.assertTrue(path.exists())), \
                     patch.object(shared, "tree_manifest", lambda path: tree_manifest(path, owner)), \
                     patch.object(os, "geteuid", lambda: 0, create=True), \
                     patch.object(os, "statvfs", lambda _: disk, create=True), \
                     patch.object(shared, "load_image", load_gzip), patch.object(shared, "docker_command", docker):
                    if label == "1.1.0":
                        receipt = loader.load_verified(REVISION, io.BytesIO(IMAGE))
                        self.assertEqual(receipt["snapshotCommitted"], layer)
                        self.assertEqual(json.loads((build / shared.RECEIPT).read_text()), receipt)
                        self.assertEqual(calls[-1], ("rm", probe))
                    else:
                        with self.assertRaises(RuntimeError):
                            loader.load_verified(REVISION, io.BytesIO(IMAGE))
                        self.assertFalse((build / shared.RECEIPT).exists())
                        self.assertEqual(len(calls), 1)
                self.assertFalse((state / f"build100-{REVISION}").exists())
