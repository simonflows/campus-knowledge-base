"""No network or real secrets: validation for the Lockbox materializer."""
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest

if os.name == "nt":
    sys.modules.setdefault("fcntl", types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None))
SPEC = importlib.util.spec_from_file_location("runtime100", Path(__file__).with_name("lockbox-runtime.py"))
APP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APP)
ENDPOINT = "https://docapi.serverless.yandexcloud.net/disposable-test"
ORIGIN = "https://canon.example.test"
BASE = dict(AWS_ACCESS_KEY_ID="fixture-key", AWS_SECRET_ACCESS_KEY="fixture-secret", DOCUMENT_API_ENDPOINT=ENDPOINT,
            YANDEX_DISK_OAUTH_TOKEN="fixture-disk", YANDEX_AI_STUDIO_API_KEY="fixture-ai")
ENV = dict(YANDEX_AI_STUDIO_FOLDER_ID="a" * 20, CAMPUS_YANDEX_OAUTH_ENABLED="true",
           CAMPUS_WEB_SEARCH_ENABLED="true", CAMPUS_TRUST_PROXY="true")


def payload(values):
    return {"entries": [{"key": key, "textValue": value} for key, value in values.items()]}


class RuntimeValidation(unittest.TestCase):
    def test_preserves_existing_credentials_and_adds_only_validated_operator_configuration(self):
        data = {**BASE, "YANDEX_OAUTH_CLIENT_ID": "fixture-client", "YANDEX_OAUTH_CLIENT_SECRET": "fixture-oauth"}
        result = APP.runtime_values(payload({**data, "UNEXPECTED_SECRET": "ignored"}), ENDPOINT, ORIGIN, ENV)
        self.assertTrue(all(result[key] == value for key, value in data.items()))
        self.assertNotIn("UNEXPECTED_SECRET", result)
        self.assertEqual(result["CAMPUS_EMAIL_ACCOUNTS_ENABLED"], "false")
        self.assertEqual(result["CAMPUS_WEB_SEARCH_USE_METADATA"], "true")
        self.assertEqual(result["CAMPUS_PUBLIC_ORIGIN"], ORIGIN)

    def test_legacy_payload_remains_supported_with_public_auth_off(self):
        result = APP.runtime_values(payload(BASE), ENDPOINT, ORIGIN, {"YANDEX_AI_STUDIO_FOLDER_ID": "a" * 20})
        self.assertEqual(result["CAMPUS_YANDEX_OAUTH_ENABLED"], "false")
        self.assertNotIn("YANDEX_OAUTH_CLIENT_SECRET", result)

    def test_missing_pair_duplicate_wrong_endpoint_and_invalid_origins_are_rejected(self):
        data = {**BASE, "YANDEX_OAUTH_CLIENT_ID": "fixture-client", "YANDEX_OAUTH_CLIENT_SECRET": "fixture-oauth"}
        cases = [(payload(BASE), ENDPOINT, ORIGIN, ENV),
                 (payload({**BASE, "YANDEX_OAUTH_CLIENT_ID": "fixture-client"}), ENDPOINT, ORIGIN, ENV),
                 ({"entries": payload(data)["entries"] + [{"key": "AWS_ACCESS_KEY_ID", "textValue": "duplicate"}]}, ENDPOINT, ORIGIN, ENV),
                 (payload(data), ENDPOINT + "wrong", ORIGIN, ENV)]
        cases += [(payload(data), ENDPOINT, origin, ENV) for origin in
                  ("http://canon.example.test", "https://name:pass@canon.example.test", ORIGIN + "/path", ORIGIN + "?x=1")]
        cases += [(payload(data), ENDPOINT, ORIGIN, {**ENV, "CAMPUS_EMAIL_ACCOUNTS_ENABLED": "true"}),
                  (payload(data), ENDPOINT, ORIGIN, {**ENV, "CAMPUS_TRUST_PROXY": "yes"}),
                  (payload({**data, "YANDEX_OAUTH_CLIENT_SECRET": "invalid\nvalue"}), ENDPOINT, ORIGIN, ENV),
                  (payload({**data, "YANDEX_OAUTH_CLIENT_SECRET": "   "}), ENDPOINT, ORIGIN, ENV)]
        for args in cases:
            with self.assertRaises(ValueError):
                APP.runtime_values(*args)


if __name__ == "__main__":
    unittest.main()
