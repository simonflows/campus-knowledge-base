import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { diskRegistryId, verifyLegacyDiskSummary, YandexDiskError } from "../lib/yandex-disk";

const folder = ["QA-legacy-summary"];
const content = Buffer.from('"Synthetic data"\r\n');
const hash = createHash("sha256").update(content).digest("hex").slice(0, 20);
const metadataHost = "cloud-api.yandex.net";
const firstLink = "https://downloader.disk.yandex.net/initial";
const storageLink = "https://files.storage.yandex.net:443/archive?signature=synthetic";
const oauth = "synthetic-test-token";

function registry() {
  return {
    id: diskRegistryId("cards", folder), kind: "disk-registry" as const,
    versionId: "qa-version", entityId: "qa-entity", fingerprint: "qa-fingerprint",
    summaryPath: `${folder[0]}/summary--${hash}.csv`, confirmedAt: "2026-01-01T00:00:00.000Z",
  };
}

function installFetch(context: TestContext, respond: (url: URL, attempt: number) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const prior = process.env.YANDEX_DISK_OAUTH_TOKEN;
  process.env.YANDEX_DISK_OAUTH_TOKEN = oauth;
  context.after(() => {
    if (prior === undefined) delete process.env.YANDEX_DISK_OAUTH_TOKEN;
    else process.env.YANDEX_DISK_OAUTH_TOKEN = prior;
  });
  context.mock.method(globalThis, "fetch", async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const headers = new Headers(init.headers);
    if (url.hostname === metadataHost) {
      assert.equal(url.pathname, "/v1/disk/resources/download");
      assert.ok(url.searchParams.get("path")?.endsWith(registry().summaryPath));
      assert.equal(init.redirect, "error");
      assert.equal(headers.get("Authorization"), `OAuth ${oauth}`);
    } else {
      for (const name of ["authorization", "proxy-authorization", "cookie"]) assert.equal(headers.get(name), null);
    }
    const response = respond(url, calls.length);
    if (init.redirect === "error" && [301, 302, 303, 307, 308].includes(response.status)) {
      throw new TypeError("Fetch rejected a redirect");
    }
    return response;
  });
  return calls;
}

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

test("legacy CSV is verified after a signed Disk link redirects to the storage CDN", async context => {
  const calls = installFetch(context, (url, n) => {
    if (n === 1) return Response.json({ href: firstLink });
    if (n === 2) return redirect(storageLink);
    assert.equal(url.hostname, "files.storage.yandex.net");
    assert.equal(url.searchParams.get("signature"), "synthetic");
    return new Response(content);
  });
  const signal = AbortSignal.timeout(1_000);
  assert.equal(await verifyLegacyDiskSummary(registry(), signal), true);
  assert.equal(calls.length, 3);
  for (const { init } of calls) assert.equal(init.signal, signal);
  assert.ok(calls.slice(1).every(call => call.init.redirect === "manual"));
});

test("two individually validated redirects can include a relative path", async context => {
  const calls = installFetch(context, (_url, n) => {
    if (n === 1) return Response.json({ href: firstLink });
    if (n === 2) return redirect("/next", 307);
    if (n === 3) return redirect(storageLink, 308);
    return new Response(content);
  });
  assert.equal(await verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), true);
  assert.deepEqual(calls.slice(1).map(call => [call.url.hostname, call.url.pathname]), [
    ["downloader.disk.yandex.net", "/initial"], ["downloader.disk.yandex.net", "/next"],
    ["files.storage.yandex.net", "/archive"],
  ]);
});

test("storage subdomains also work as the first signed destination", async context => {
  const calls = installFetch(context, (_url, n) => n === 1 ? Response.json({ href: storageLink }) : new Response(content));
  assert.equal(await verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), true);
  assert.equal(calls.length, 2);
});

test("a third redirect is rejected without opening its destination", async context => {
  const calls = installFetch(context, (_url, n) => n === 1 ? Response.json({ href: firstLink }) : redirect(`/step-${n}`));
  await assert.rejects(verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), YandexDiskError);
  assert.equal(calls.length, 4);
});

for (const forbidden of [
  "https://other.yandex.net/file", "https://storage.yandex.net/file", "https://files.storage.yandex.net.evil.test/file",
  "http://files.storage.yandex.net/file", "https://name:pass@files.storage.yandex.net/file",
  "https://files.storage.yandex.net:444/file", "https://files.storage.yandex.net/file#fragment",
  "https://files.storage.yandex.net/file#", "https://.storage.yandex.net/file", "https://",
]) {
  for (const where of ["metadata", "redirect"]) {
    test(`reject an unapproved ${where} destination without following it (${forbidden})`, async context => {
      const calls = installFetch(context, (_url, n) => {
        if (n === 1) return Response.json({ href: where === "metadata" ? forbidden : firstLink });
        return redirect(forbidden);
      });
      await assert.rejects(verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), YandexDiskError);
      assert.equal(calls.length, where === "metadata" ? 1 : 2);
    });
  }
}

test("legacy missing metadata or missing final file still returns false", async context => {
  let index = 0;
  const calls = installFetch(context, () => {
    index++;
    if (index === 2) return Response.json({ href: firstLink });
    if (index === 3) return redirect(storageLink);
    return new Response(null, { status: 404 });
  });
  assert.equal(await verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), false);
  assert.equal(await verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), false);
  assert.equal(calls.length, 4);
});

test("a bytes mismatch still fails verification after redirect", async context => {
  installFetch(context, (_url, n) => n === 1 ? Response.json({ href: firstLink })
    : n === 2 ? redirect(storageLink) : new Response("Other bytes"));
  assert.equal(await verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), false);
});

test("download remains stream-bounded at eight million bytes", async context => {
  let cancelled = false;
  installFetch(context, (_url, n) => n === 1 ? Response.json({ href: firstLink })
    : n === 2 ? redirect(storageLink) : new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8_000_001)); },
      cancel() { cancelled = true; },
    })));
  assert.equal(await verifyLegacyDiskSummary(registry(), AbortSignal.timeout(1_000)), false);
  assert.equal(cancelled, true);
});

test("aborting between the signed request and its redirect does not open the CDN", async context => {
  const controller = new AbortController();
  const calls = installFetch(context, (_url, n) => {
    if (n === 1) return Response.json({ href: firstLink });
    controller.abort();
    return redirect(storageLink);
  });
  await assert.rejects(verifyLegacyDiskSummary(registry(), controller.signal), { name: "AbortError" });
  assert.equal(calls.length, 2);
});
