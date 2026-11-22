import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.CAMPUS_QA_IMAGE_ORIGIN ?? "http://127.0.0.1:8080";
assert.ok(["http://127.0.0.1:8080", "http://127.0.0.2:8080"].includes(base), "Image acceptance must use an isolated loopback origin");
const origin = "https://canon.invalid";
const login = "ci-coordinator";

async function prepare(directory) {
  const accessKey = randomBytes(32).toString("base64url");
  const row = {
    login,
    name: "CI Coordinator",
    profile: "demo-admin",
    keyHash: createHash("sha256").update(accessKey).digest("hex"),
  };
  const runtime =
    [
      "CAMPUS_PUBLIC_ORIGIN=" + origin,
      "DOCUMENT_API_ENDPOINT=https://qa-document-api:8443",
      "DOCUMENT_API_REGION=us-east-1",
      "AWS_ACCESS_KEY_ID=campusLocalTest",
      "AWS_SECRET_ACCESS_KEY=localTestOnly",
      "SESSION_SECRET=" + randomBytes(32).toString("hex"),
      "CAMPUS_PILOT_ACCOUNTS=" + JSON.stringify([row]),
    ].join("\n") + "\n";
  const options = { flag: "wx", mode: 0o600 };
  await writeFile(join(directory, "runtime.env"), runtime, options);
  await writeFile(join(directory, "client.key"), accessKey, options);
}

function call(path, options) {
  return fetch(base + path, {
    redirect: "error",
    signal: AbortSignal.timeout(6000),
    ...options,
  });
}

async function waitFor(path, expected) {
  const deadline = Date.now() + 60_000;
  do {
    const response = await call(path).catch(() => null);
    if (response) {
      await response.arrayBuffer();
      if (response.status === expected) return;
    }
    await delay(750);
  } while (Date.now() < deadline);
  throw new Error(`${path} did not return HTTP ${expected}`);
}

async function verify(directory) {
  const marker = process.env.CAMPUS_QA_MARKER;
  assert.match(marker ?? "", /^qa-marker-[0-9a-f-]{36}$/);
  await waitFor("/api/ready", 200);
  if (process.env.CAMPUS_QA_EXPECT_REVISION) {
    assert.match(process.env.CAMPUS_QA_EXPECT_REVISION, /^[0-9a-f]{40}$/);
    const release = await call("/api/version");
    assert.equal(release.status, 200);
    const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
    assert.deepEqual(await release.json(), { version: packageVersion, revision: process.env.CAMPUS_QA_EXPECT_REVISION });
  }
  const published = await call("/api/articles/" + marker);
  assert.equal(published.status, 200);
  assert.equal((await published.json()).title, "Disposable QA " + marker);
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const session = await call("/api/auth/session", {
    method: "POST",
    headers,
    body: JSON.stringify({
      accountId: login,
      accessKey: await readFile(join(directory, "client.key"), "utf8"),
    }),
  });
  assert.equal(session.status, 200, "Fixture account must sign in");
  assert.equal((await session.json()).user.id, "pilot-" + login);
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  assert.ok(
    cookie?.startsWith("__Host-vibecraft-session="),
    "A session cookie is required"
  );
  const title = "CI draft " + randomUUID();
  const created = await call("/api/editor/drafts", {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({ content: { title } }),
  });
  assert.equal(created.status, 201);
  const draft = await created.json();
  assert.match(draft.id, /^[0-9a-f-]{36}$/);
  const readback = await call("/api/editor/drafts/" + draft.id, {
    headers: { Cookie: cookie },
  });
  assert.equal(readback.status, 200);
  const { document, revisions } = await readback.json();
  assert.equal(document.id, draft.id);
  assert.equal(document.ownerId, "pilot-" + login);
  assert.equal(document.content.title, title);
  assert.ok(
    revisions.some(
      (revision) =>
        revision.id === draft.revisionId && revision.content.title === title
    )
  );
  console.log(
    "PASS production image readiness, fixture publication, pilot sign-in, draft and revision readback"
  );
}

const directory = process.env.CAMPUS_QA_IMAGE_DIR;
assert.ok(
  directory,
  "Set CAMPUS_QA_IMAGE_DIR to the temporary fixture directory"
);
switch (process.argv[2]) {
  case "prepare":
    await prepare(directory);
    break;
  case "empty":
    await waitFor("/api/health", 200);
    await waitFor("/api/ready", 503);
    break;
  case "verify":
    await verify(directory);
    break;
  default:
    throw new Error("Expected prepare, empty or verify");
}
