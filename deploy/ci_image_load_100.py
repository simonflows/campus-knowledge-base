#!/usr/bin/env python3
"""Verify the GitHub release bundle on the operator host and load it on the VM."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile


REPOSITORY = "simonflows/campus-knowledge-base"
WORKFLOW = ".github/workflows/ci.yml"
JOB = "Quality gate"
ARTIFACT = "canon-release-image"
IMAGE_ARCHIVE = "canon-release-image.tar.gz"
SOURCE_ARCHIVE = "canon-release-source.tar.gz"
PROVENANCE = "ci-provenance.json"
RECEIPT = "ci-image-receipt.json"
STATE = Path("/var/lib/canon")
CHUNK = 1024 * 1024
MIN_CONTAINERD_BYTES = 1_460_000_000
FORBIDDEN = {".git", "node_modules", ".next", "__pycache__"}
PROOF_FIELDS = frozenset({"schema", "repository", "revision", "ciWorkflow", "ciRunId", "ciRunAttempt",
    "ciQualityJobId", "ciQualityConclusion", "ciArtifactId", "ciArtifactSha256", "ciArtifactBytes",
    "image", "gzipSha256", "gzipBytes", "sourceArchiveSha256", "sourceManifestSha256"})


def require(ok, problem):
    if not ok:
        raise RuntimeError(problem)


def hex_digest(value, size=64, prefix=""):
    return isinstance(value, str) and bool(re.fullmatch(prefix + rf"[0-9a-f]{{{size}}}", value))


def positive_integer(value):
    return type(value) is int and value > 0


def hash_stream(source, target=None, expected_bytes=None):
    digest = hashlib.sha256()
    size = 0
    while data := source.read(CHUNK):
        size += len(data)
        if expected_bytes is not None:
            require(size <= expected_bytes, "stream exceeds verified length")
        digest.update(data)
        if target is not None:
            target.write(data)
    if expected_bytes is not None:
        require(size == expected_bytes, "stream ends before verified length")
    return digest.hexdigest(), size


def hash_file(path):
    with path.open("rb") as source:
        return hash_stream(source)[0]


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_exact(path, mode):
    info = path.lstat()
    expected_type = stat.S_ISDIR if mode == 0o700 else stat.S_ISREG
    require(expected_type(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == mode,
            "input permissions or owner")


def new_json(path, proof):
    # Same-directory hard link publishes one complete receipt without replacement.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        staging = Path(handle.name)
        try:
            json.dump(proof, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
            os.link(staging, path)
        finally:
            staging.unlink(missing_ok=True)
            if os.name != "nt":
                fsync_directory(path.parent)


def github(path):
    result = subprocess.run(["gh", "api", "--hostname", "github.com", f"repos/{REPOSITORY}/{path}"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60, check=True)
    return json.loads(result.stdout)


def github_proof(revision, run_id):
    require(hex_digest(revision, size=40) and positive_integer(run_id), "invalid commit or CI run ID")
    run_path = f"actions/runs/{run_id}"
    run = github(run_path)
    repository = run.get("repository") or {}
    head = run.get("head_repository") or {}
    attempt = run.get("run_attempt")
    require(run.get("id") == run_id and run.get("name") == "CI" and
            run.get("path") in {WORKFLOW, WORKFLOW + "@main", WORKFLOW + "@refs/heads/main"} and
            run.get("status") == "completed" and run.get("conclusion") == "success" and
            run.get("head_branch") == "main" and run.get("event") == "push" and run.get("head_sha") == revision and
            positive_integer(attempt) and positive_integer(repository.get("id")) and
            repository.get("full_name") == REPOSITORY and head.get("id") == repository["id"],
            "GitHub CI is not a successful main push of the candidate commit")
    jobs = github(f"{run_path}/attempts/{attempt}/jobs?per_page=100")
    require(jobs["total_count"] == len(jobs["jobs"]), "GitHub CI jobs list is incomplete")
    gate, = [job for job in jobs["jobs"] if job.get("name") == JOB]
    require(positive_integer(gate.get("id")) and gate.get("status") == "completed" and
            gate.get("conclusion") == "success" and gate.get("run_id") == run_id and
            gate.get("head_branch") == "main" and gate.get("head_sha") == revision,
            "mandatory GitHub Quality gate did not succeed on the candidate")
    artifacts = github(f"{run_path}/artifacts?per_page=100")
    require(artifacts["total_count"] == len(artifacts["artifacts"]), "GitHub artifacts list is incomplete")
    artifact, = [item for item in artifacts["artifacts"] if item.get("name") == ARTIFACT]
    artifact_run = artifact.get("workflow_run") or {}
    require(positive_integer(artifact.get("id")) and artifact.get("expired") is False and
            positive_integer(artifact.get("size_in_bytes")) and hex_digest(artifact.get("digest"), prefix="sha256:") and
            artifact_run.get("id") == run_id and artifact_run.get("head_sha") == revision and
            artifact_run.get("head_branch") == "main" and
            artifact_run.get("repository_id") == artifact_run.get("head_repository_id") == repository["id"],
            "GitHub artifact is unavailable or not bound to the candidate CI run")
    return {"schema": 1, "repository": REPOSITORY, "revision": revision, "ciWorkflow": WORKFLOW,
            "ciRunId": run_id, "ciRunAttempt": attempt, "ciQualityJobId": gate["id"], "ciQualityConclusion": "success",
            "ciArtifactId": artifact["id"], "ciArtifactSha256": artifact["digest"],
            "ciArtifactBytes": artifact["size_in_bytes"]}


def manifest_digest(entries):
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def safe_component(name):
    return (name not in {"", ".", ".."} and name.casefold() not in FORBIDDEN and
            not any(character in "\\:" or ord(character) < 32 for character in name))


def source_manifest(path, revision, target=None):
    entries = {}
    with tarfile.open(path, "r:gz") as archive:
        require(archive.pax_headers.get("comment") == revision, "Git archive commit does not match CI")
        for member in archive:
            components = member.name.split("/")
            require(components[0] == "source" and all(map(safe_component, components)) and
                    (member.isdir() or member.isreg()), "unsafe Git archive member")
            name = "/".join(components[1:])
            parent = name.rpartition("/")[0]
            require(name not in entries and (entries.get(parent) == ["dir"] if name else member.isdir()),
                    "duplicate Git archive member or missing directory")
            output = target.joinpath(*components[1:]) if target is not None else None
            if member.isdir():
                entries[name] = ["dir"]
                if output is not None:
                    output.mkdir(mode=0o700)
                continue
            executable = bool(member.mode & 0o111)
            with archive.extractfile(member) as data:
                if output is None:
                    digest, _ = hash_stream(data, expected_bytes=member.size)
                else:
                    with output.open("xb") as handle:
                        digest, _ = hash_stream(data, handle, expected_bytes=member.size)
                        handle.flush()
                        output.chmod(0o700 if executable else 0o600)
                        os.fsync(handle.fileno())
            entries[name] = ["file", executable, digest]
    require(entries.get("") == ["dir"] and len(entries) > 1, "empty Git archive")
    if target is not None and os.name != "nt":
        for name, entry in reversed(list(entries.items())):
            if entry == ["dir"]:
                fsync_directory(target / name)
        fsync_directory(target.parent)
    return manifest_digest(entries)


def tree_manifest(root, owner=0):
    entries = {}

    def read(path, relative):
        mode = path.lstat()
        directory = stat.S_ISDIR(mode.st_mode)
        executable = bool(mode.st_mode & 0o111)
        require(directory or stat.S_ISREG(mode.st_mode), "unexpected staged source entry type")
        if os.name != "nt":
            require(mode.st_uid == owner and stat.S_IMODE(mode.st_mode) == (0o700 if directory or executable else 0o600),
                    "staged source permissions or owner")
        entries[relative] = ["dir"] if directory else ["file", executable, hash_file(path)]
        if directory:
            for child in path.iterdir():
                require(safe_component(child.name), "unsafe staged source name")
                name = relative + "/" + child.name if relative else child.name
                read(child, name)

    read(root, "")
    return manifest_digest(entries)


def verify_artifact(revision, run_id, bundle, output):
    proof = github_proof(revision, run_id)
    with bundle.open("rb") as source:
        digest, _ = hash_stream(source, expected_bytes=proof["ciArtifactBytes"])
        require("sha256:" + digest == proof["ciArtifactSha256"], "ZIP digest disagrees with authenticated GitHub metadata")
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            require(sorted(archive.namelist()) == sorted([IMAGE_ARCHIVE, SOURCE_ARCHIVE,
                    "canon-release-image.sha256", "canon-release-image.id"]), "unexpected GitHub artifact files")
            require(all(archive.getinfo(name).file_size <= 256 for name in
                        ["canon-release-image.sha256", "canon-release-image.id"]), "invalid image metadata size")
            image = archive.read("canon-release-image.id").decode("ascii").strip()
            checksum = archive.read("canon-release-image.sha256").decode("ascii").split()
            require(hex_digest(image, prefix="sha256:") and len(checksum) == 2 and
                    checksum[1] == IMAGE_ARCHIVE and hex_digest(checksum[0]), "invalid CI image metadata")
            output.mkdir(mode=0o700)
            digests = {}
            for name in [IMAGE_ARCHIVE, SOURCE_ARCHIVE]:
                with archive.open(name) as item, (output / name).open("xb") as handle:
                    digests[name] = hash_stream(item, handle, archive.getinfo(name).file_size)
            gzip_sha, gzip_bytes = digests[IMAGE_ARCHIVE]
            require(gzip_sha == checksum[0] and gzip_bytes > 0, "CI gzip digest mismatch")
            proof.update(image=image, gzipSha256=gzip_sha, gzipBytes=gzip_bytes,
                         sourceArchiveSha256=digests[SOURCE_ARCHIVE][0],
                         sourceManifestSha256=source_manifest(output / SOURCE_ARCHIVE, revision))
    new_json(output / PROVENANCE, proof)
    return proof


def validate_source(build, revision, proof):
    require(proof.keys() == PROOF_FIELDS and proof.get("schema") == 1 and
            proof.get("repository") == REPOSITORY and proof.get("revision") == revision and
            hex_digest(revision, size=40) and proof.get("ciWorkflow") == WORKFLOW and
            proof.get("ciQualityConclusion") == "success" and
            all(positive_integer(proof.get(key)) for key in ["ciRunId", "ciRunAttempt", "ciQualityJobId",
                "ciArtifactId", "ciArtifactBytes", "gzipBytes"]) and
            all(hex_digest(proof.get(key)) for key in ["gzipSha256", "sourceArchiveSha256", "sourceManifestSha256"]) and
            all(hex_digest(proof.get(key), prefix="sha256:") for key in ["image", "ciArtifactSha256"]),
            "invalid authenticated CI provenance")
    archive = build / SOURCE_ARCHIVE
    private_exact(archive, 0o600)
    require(hash_file(archive) == proof["sourceArchiveSha256"], "source archive differs from GitHub artifact")
    return archive


def load_image(source, proof):
    with tempfile.TemporaryFile() as output:
        with subprocess.Popen(["/usr/bin/docker", "load"], stdin=subprocess.PIPE,
                              stdout=output, stderr=subprocess.STDOUT) as docker:
            try:
                with docker.stdin as handle:
                    digest, _ = hash_stream(source, handle, proof["gzipBytes"])
                require(digest == proof["gzipSha256"], "streamed gzip differs from GitHub artifact")
                require(docker.wait(timeout=600) == 0, "Docker image load failed")
            except BaseException:
                docker.kill()
                raise
        output.seek(0)
        report = output.read(65536).lower()
        require(not re.search(rb"error unpacking|no space left|failed to (?:unpack|extract)", report),
                "Docker reported an incomplete unpack")


def docker_command(*args):
    result = subprocess.run(["/usr/bin/docker", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=60, check=True)
    return result.stdout.decode().strip()


def image_snapshot(proof):
    revision = proof["revision"]
    image = proof["image"]
    fmt = ('{{.Id}} {{.Os}} {{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} '
           '{{index .Config.Labels "org.opencontainers.image.version"}}')
    require(docker_command("image", "inspect", "--format", fmt, "campus-kb:" + revision) ==
            f"{image} linux amd64 {revision} 1.0.0", "loaded image identity and labels differ from CI")
    layers = json.loads(docker_command("image", "inspect", "--format", "{{json .RootFS.Layers}}", image))
    require(layers and all(hex_digest(layer, prefix="sha256:") for layer in layers), "invalid image filesystem layers")
    chain = layers[0]
    for layer in layers[1:]:
        chain = "sha256:" + hashlib.sha256((chain + " " + layer).encode("ascii")).hexdigest()
    # Docker must construct a container from the imported snapshot. No code runs.
    container = docker_command("create", "--pull", "never", "--network", "none", "--entrypoint", "/bin/true", image)
    require(hex_digest(container), "invalid snapshot probe container ID")
    docker_command("rm", container)
    return chain


def load_verified(revision, source):
    require(os.geteuid() == 0 and hex_digest(revision, size=40), "root and exact commit required")
    private_exact(STATE, 0o700)
    require(STATE.resolve() == STATE, "release state parent contains a symlink")
    build = STATE / f"build100-{revision}"
    private_exact(build, 0o700)
    require({item.name for item in build.iterdir()} == {PROVENANCE, SOURCE_ARCHIVE}, "candidate staging is not fresh")
    private_exact(build / PROVENANCE, 0o600)
    proof = json.loads((build / PROVENANCE).read_text(encoding="utf-8"))
    archive = validate_source(build, revision, proof)
    target = build / "source"
    require(source_manifest(archive, revision, target) == tree_manifest(target) == proof["sourceManifestSha256"],
            "extracted source tree differs from GitHub artifact")
    disk = os.statvfs("/var/lib/containerd")
    require(disk.f_bavail * disk.f_frsize >= MIN_CONTAINERD_BYTES, "insufficient Docker unpack space")
    load_image(source, proof)
    receipt = {**proof, "loaded": True, "snapshotCommitted": image_snapshot(proof)}
    new_json(build / RECEIPT, receipt)
    return receipt


def verified_receipt(build, revision, image):
    private_exact(build / PROVENANCE, 0o600)
    private_exact(build / RECEIPT, 0o600)
    proof = json.loads((build / PROVENANCE).read_text(encoding="utf-8"))
    receipt = json.loads((build / RECEIPT).read_text(encoding="utf-8"))
    archive = validate_source(build, revision, proof)
    require(proof["image"] == image and receipt.get("loaded") is True and
            hex_digest(receipt.get("snapshotCommitted"), prefix="sha256:") and
            receipt == {**proof, "loaded": True, "snapshotCommitted": receipt["snapshotCommitted"]},
            "Docker load receipt disagrees with authenticated CI provenance")
    require(source_manifest(archive, revision) == tree_manifest(build / "source") == proof["sourceManifestSha256"],
            "staged source no longer matches the complete Git archive")
    return {key: value for key, value in receipt.items() if key not in {"schema", "revision", "image", "loaded"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("revision")
    verify.add_argument("run_id", type=int)
    verify.add_argument("bundle", type=Path)
    verify.add_argument("output", type=Path)
    load = commands.add_parser("load")
    load.add_argument("revision")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == "verify":
            proof = verify_artifact(args.revision, args.run_id, args.bundle, args.output)
        else:
            for key in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]:
                os.environ.pop(key, None)
            proof = load_verified(args.revision, sys.stdin.buffer)
        print(json.dumps(proof, sort_keys=True))
    except RuntimeError as error:
        sys.exit(str(error))
    except Exception as error:
        sys.exit(f"release image {args.command} failed ({type(error).__name__})")


if __name__ == "__main__":
    main()
