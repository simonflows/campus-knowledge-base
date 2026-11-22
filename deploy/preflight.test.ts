import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fakeSecret = "synthetic-test-value".repeat(2);
const account = {
  login: "pilot-test",
  name: "Тестовый редактор",
  profile: "demo-pr-midis",
  keyHash: "a".repeat(64),
};
const settings: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  NEXT_PUBLIC_DEMO_MODE: "false",
  CAMPUS_DEMO_LOGIN: "false",
  CAMPUS_LOCAL_DEMO: "false",
  CAMPUS_FULL_LOCAL_DEMO: "false",
  SEED_DEMO_ARTICLES: "false",
  USE_DATABASE: "true",
  CAMPUS_PUBLIC_ORIGIN: "https://pilot.example",
  DOCUMENT_API_ENDPOINT: "https://document-api.example/folder/database",
  AWS_ACCESS_KEY_ID: fakeSecret,
  AWS_SECRET_ACCESS_KEY: fakeSecret,
  SESSION_SECRET: fakeSecret,
  CAMPUS_PILOT_ACCOUNTS: JSON.stringify([account]),
};

function runPreflight(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "deploy/preflight.ts"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...settings,
        ...overrides,
      },
    }
  );
}

test("preflight accepts a complete pilot configuration offline", () => {
  const result = runPreflight();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(fakeSecret));
});

test("preflight reports invalid configuration without printing supplied values", () => {
  const result = runPreflight({
    CAMPUS_DEMO_LOGIN: "true",
    CAMPUS_PUBLIC_ORIGIN: "http://pilot.example/path",
    DOCUMENT_API_ENDPOINT: `https://${fakeSecret}@document-api.example/db`,
    AWS_SECRET_ACCESS_KEY: "",
    SESSION_SECRET: "short",
  });
  assert.equal(result.status, 1);
  for (const name of [
    "CAMPUS_DEMO_LOGIN",
    "CAMPUS_PUBLIC_ORIGIN",
    "DOCUMENT_API_ENDPOINT",
    "AWS_SECRET_ACCESS_KEY",
    "SESSION_SECRET",
  ]) {
    assert.match(result.stderr, new RegExp(name));
  }
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  assert.doesNotMatch(result.stdout + result.stderr, /short/);
});

test("preflight rejects duplicate personal accounts as the application does", () => {
  const result = runPreflight({
    CAMPUS_PILOT_ACCOUNTS: JSON.stringify([account, account]),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CAMPUS_PILOT_ACCOUNTS/);
  assert.doesNotMatch(result.stderr, /pilot-test/);
});
