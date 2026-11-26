import hashlib
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import ci_image_load_100 as staging


REVISION = "e" * 40
IMAGE_ID = "sha256:" + "f" * 64
IMAGE = b"fixture gzip bytes"
RUN_ID = 401
REPOSITORY = "simonflows/campus-knowledge-base"
TEST_UID = getattr(os, "geteuid", lambda: 0)()


def write_source(path, revision=REVISION, extra=None):
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": revision}) as archive:
        for name, data in [("source/", None), ("source/deploy/", None),
                           ("source/deploy/compose.prod.yml", b"services: {}\n"),
                           ("source/other.txt", b"complete tree\n")]:
            member = tarfile.TarInfo(name)
            if data is None:
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
            else:
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        if extra:
            archive.addfile(extra)


class CIProvenanceTests(unittest.TestCase):
    def fixture(self, directory):
        source = directory / "source.tar.gz"
        write_source(source)
        bundle = directory / "github.zip"
        with zipfile.ZipFile(bundle, "w") as archive:
            archive.writestr("canon-release-image.tar.gz", IMAGE)
            archive.writestr("canon-release-image.sha256",
                             hashlib.sha256(IMAGE).hexdigest() + "  canon-release-image.tar.gz\n")
            archive.writestr("canon-release-image.id", IMAGE_ID + "\n")
            archive.write(source, "canon-release-source.tar.gz")
        repo = {"id": 98, "full_name": REPOSITORY}
        run = {"id": RUN_ID, "name": "CI", "path": ".github/workflows/ci.yml@main", "run_attempt": 1,
               "event": "push", "status": "completed", "conclusion": "success", "head_branch": "main",
               "head_sha": REVISION, "repository": repo, "head_repository": repo}
        job = {"id": 402, "run_id": RUN_ID, "head_sha": REVISION, "head_branch": "main",
               "name": "Quality gate", "status": "completed", "conclusion": "success"}
        artifact = {"id": 403, "name": "canon-release-image", "expired": False,
                    "size_in_bytes": bundle.stat().st_size,
                    "digest": "sha256:" + hashlib.sha256(bundle.read_bytes()).hexdigest(),
                    "workflow_run": {"id": RUN_ID, "repository_id": 98, "head_repository_id": 98,
                                     "head_branch": "main", "head_sha": REVISION}}
        paths = {f"actions/runs/{RUN_ID}": run,
                 f"actions/runs/{RUN_ID}/attempts/1/jobs?per_page=100": {"total_count": 1, "jobs": [job]},
                 f"actions/runs/{RUN_ID}/artifacts?per_page=100": {"total_count": 1, "artifacts": [artifact]}}
        return bundle, paths, run, job, artifact

    def test_export_binds_exact_github_zip_image_and_source(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            bundle, paths, _, _, artifact = self.fixture(directory)
            with patch.object(staging, "github", paths.__getitem__):
                proof = staging.verify_artifact(REVISION, RUN_ID, bundle, directory / "verified")
            self.assertEqual(proof["ciArtifactSha256"], artifact["digest"])
            self.assertEqual(proof["image"], IMAGE_ID)
            self.assertEqual(proof["gzipSha256"], hashlib.sha256(IMAGE).hexdigest())
            self.assertEqual(proof["sourceArchiveSha256"], hashlib.sha256((directory / "source.tar.gz").read_bytes()).hexdigest())

    def test_rejects_unproven_workflow_job_or_zip(self):
        for field, wrong in [("event", "pull_request"), ("head_branch", "staging"), ("head_sha", "1" * 40),
                             ("path", ".github/workflows/other.yml@main"),
                             ("job.conclusion", "skipped"), ("artifact.digest", "sha256:" + "1" * 64)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                bundle, paths, run, job, artifact = self.fixture(directory)
                if field.startswith("job."):
                    job[field[4:]] = wrong
                elif field.startswith("artifact."):
                    artifact[field[9:]] = wrong
                else:
                    run[field] = wrong
                with patch.object(staging, "github", paths.__getitem__), self.assertRaises(RuntimeError):
                    staging.verify_artifact(REVISION, RUN_ID, bundle, directory / "verified")
                self.assertFalse((directory / "verified/ci-provenance.json").exists())

    def test_full_tree_detects_changes_missing_files_and_untracked_files(self):
        for change in ["modify", "delete", "new"]:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                source = directory / "source.tar.gz"
                tree = directory / "source"
                write_source(source)
                expected = staging.source_manifest(source, REVISION, tree)
                self.assertEqual(staging.tree_manifest(tree, owner=TEST_UID), expected)
                if change == "modify":
                    (tree / "other.txt").write_bytes(b"tampered outside compose and package")
                elif change == "delete":
                    (tree / "other.txt").unlink()
                else:
                    (tree / "unexpected.txt").write_bytes(b"extra")
                    (tree / "unexpected.txt").chmod(0o600)
                self.assertNotEqual(staging.tree_manifest(tree, owner=TEST_UID), expected)

    def test_wrong_archive_revision_and_unsafe_members_are_rejected(self):
        for revision, member_path in [("a" * 40, None), (REVISION, "source/../outside"),
                                      (REVISION, "source/.git"), (REVISION, "source/node_modules"),
                                      (REVISION, "source/link")]:
            with self.subTest(member_path=member_path), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                source = directory / "source.tar.gz"
                extra = tarfile.TarInfo(member_path) if member_path else None
                if member_path == "source/link":
                    extra.type = tarfile.SYMTYPE
                    extra.linkname = "../outside"
                write_source(source, revision, extra)
                with self.assertRaises(RuntimeError):
                    staging.source_manifest(source, REVISION, directory / "source")
                self.assertFalse((directory / "outside").exists())


if __name__ == "__main__":
    unittest.main()
