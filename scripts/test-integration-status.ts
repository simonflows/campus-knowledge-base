import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function testIntegrationStatus() {
  const project = process.cwd();
  const directory = await mkdtemp(path.join(tmpdir(), "campus-status-test-"));
  const placeholder = "test-config-value";
  const settings = {
    YANDEX_AI_STUDIO_API_KEY: placeholder,
    YANDEX_AI_STUDIO_FOLDER_ID: placeholder,
    YANDEX_AI_STUDIO_MODEL_URI: `gpt://${placeholder}/custom`,
    YANDEX_DISK_OAUTH_TOKEN: placeholder,
    ALIBABA_DASHSCOPE_API_KEY: placeholder,
    ALIBABA_MODEL_NAME: placeholder,
    ALIBABA_DASHSCOPE_BASE_URL: "https://test-config-value.invalid",
  };

  try {
    const fixtureFile = path.join(directory, ".env.local");
    const contents = "SYNTHETIC_MARKER=untouched\n";
    await writeFile(fixtureFile, contents);
    execFileSync(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--tsconfig",
        path.join(project, "tsconfig.json"),
        path.join(project, "scripts/test-integration-status.ts"),
        "--fixture",
      ],
      {
        cwd: directory,
        env: {
          ...settings,
          NODE_ENV: "test",
          OUTPUT_MODE: "export",
          CAMPUS_DEMO_LOGIN: "true",
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
        timeout: 30000,
      }
    );

    const instructions = execFileSync(
      process.execPath,
      [path.join(project, "scripts/setup-keys.mjs")],
      {
        cwd: directory,
        encoding: "utf8",
        input: "",
        env: { ...settings, NODE_ENV: "test" },
        timeout: 5000,
      }
    );
    for (const name of Object.keys(settings))
      assert.ok(instructions.includes(name));
    assert.ok(!instructions.includes(placeholder));
    assert.equal(await readFile(fixtureFile, "utf8"), contents);
    assert.deepEqual(await readdir(directory), [".env.local"]);
    console.log(
      "PASS public integration flags, protected setup in both modes and read-only CLI"
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
}

async function checkRoutes() {
  const { GET, POST } = await import("../app/api/system/status/route");
  const { getYandexModelLabel } = await import("../lib/yandex-ai");
  assert.ok(!getYandexModelLabel().includes("test-config-value"));

  const response = await GET();
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { timestamp, ...status } = await response.json();
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.deepEqual(status, {
    storageMode: "static-export",
    yandexAi: { configured: true },
    alibabaAi: { configured: true },
    yandexDisk: { configured: true },
  });

  for (const mode of ["development", "production"]) {
    Object.assign(process.env, { NODE_ENV: mode });
    const request = new Request("http://localhost:8080/api/system/status", {
      method: "POST",
      body: JSON.stringify({ YANDEX_AI_STUDIO_API_KEY: "replacement" }),
    });
    assert.equal((await POST(request)).status, 403);
    assert.equal(request.bodyUsed, false);
    assert.equal(process.env.YANDEX_AI_STUDIO_API_KEY, "test-config-value");
  }
}

if (process.argv.includes("--fixture")) {
  checkRoutes().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
