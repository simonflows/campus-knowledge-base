#!/usr/bin/env python3
"""Verify and load the immutable CI artifact for Canon 1.1.0."""
import sys

sys.dont_write_bytecode = True
import ci_image_load_100 as release_image

VERSION = "1.1.0"
STATE = release_image.STATE
NAMESPACE = "build110"


def verify_artifact(revision, run_id, bundle, output):
    return release_image.verify_artifact(revision, run_id, bundle, output, expected_version=VERSION)


def load_verified(revision, source):
    return release_image.load_verified(revision, source, state=STATE, namespace=NAMESPACE, expected_version=VERSION)


if __name__ == "__main__":
    release_image.main(verify=verify_artifact, load=load_verified, description=__doc__)
