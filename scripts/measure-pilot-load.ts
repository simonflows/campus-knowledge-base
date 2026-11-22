import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { requireFixtureServer } from "./qa-fixture";
import { storageUnavailableMessage } from "../lib/runtime-storage-policy";

type Credentials = { accountId: string; accessKey: string };
type Sample = { path: string; operation: "read" | "write"; ms: number; status: number; valid: boolean };

function percentile95(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0);
}

export async function measurePilotLoad(credentials: Credentials, profile: "smoke" | "pilot") {
  const base = await requireFixtureServer();
  const session = await fetch(new URL("/api/auth/session", base), {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(session.status, 200, "The dedicated fixture user must be able to sign in");
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = { cookie, origin: base, "content-type": "application/json" };
  const readPaths = [
    { path: "/", expected: 'id="campus-title"' },
    { path: "/knowledge?card=project-susu-digital-twin", expected: "project-susu-digital-twin" },
    { path: "/api/search?q=" + encodeURIComponent("виртуальный тренажёр"), expected: "joint-midis-susmu-trauma" },
    { path: "/api/editor/drafts", expected: '"documents":[' },
  ];

  async function sample(
    path: string,
    operation: Sample["operation"],
    samples: Sample[],
    init?: RequestInit,
    expected?: string,
  ) {
    const start = performance.now();
    let status = 0;
    let body = "";
    try {
      const response = await fetch(new URL(path, base), {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      status = response.status;
      body = await response.text();
    } catch {
      status = 0;
    }
    const valid = status > 0 && status < 400 &&
      (!expected || (body.includes(expected) && !body.includes(storageUnavailableMessage)));
    samples.push({ path, operation, ms: performance.now() - start, status, valid });
    return { status, body, valid };
  }

  for (const { path, expected } of readPaths) {
    const { valid } = await sample(path, "read", [], undefined, expected);
    assert.ok(valid, `Load warm-up failed for ${path}`);
  }

  for (const [users, minutes] of [[20, 30], [40, 10]] as const) {
    const samples: Sample[] = [];
    let checkedWrites = 0;
    let lostWrites = 0;
    const end = Date.now() + minutes * 60_000;
    let round = 0;
    do {
      const cycle = round++;
      await Promise.all(Array.from({ length: users }, async (_, user) => {
        if (user !== 0 || (profile === "pilot" && cycle % 5 !== 0)) {
          const { path, expected } = readPaths[(user + cycle) % readPaths.length];
          await sample(path, "read", samples, undefined, expected);
          return;
        }
        const title = "Синтетическая проверка " + randomUUID();
        const write = await sample("/api/editor/drafts", "write", samples, {
          method: "POST",
          body: JSON.stringify({ content: { title, universityId: "midis" } }),
        });
        if (write.status !== 201) return;
        const created = JSON.parse(write.body) as { id: string };
        const read = await sample("/api/editor/drafts/" + encodeURIComponent(created.id), "read", samples);
        checkedWrites++;
        if (read.status !== 200 || (JSON.parse(read.body) as { document: { content: { title?: string } } }).document?.content?.title !== title) {
          lostWrites++;
        }
      }));
      if (profile === "pilot") await delay(1500);
    } while (profile === "pilot" ? Date.now() < end : round < 3);

    const errors = samples.filter(entry => !entry.valid);
    const readP95 = percentile95(samples.filter(s => s.operation === "read").map(s => s.ms));
    const writeP95 = percentile95(samples.filter(s => s.operation === "write").map(s => s.ms));
    const errorRate = errors.length / samples.length;
    const result = {
      profile, users, requests: samples.length, readP95, writeP95,
      errors: errors.length, checkedWrites, lostWrites,
    };
    console.log("Pilot load:", JSON.stringify(result));
    assert.ok(checkedWrites > 0 && lostWrites === 0, "Reported draft writes must be readable");
    assert.ok(errorRate < 0.01, `Unexpected HTTP or network errors: ${errors.map(s => s.status + " " + s.path.replace(/\/api\/editor\/drafts\/.*/, "/api/editor/drafts/:id")).join(", ")}`);
    if (profile === "pilot") {
      assert.ok(readP95 <= 1000, "Read p95 exceeds the 1 s pilot target");
      assert.ok(writeP95 <= 2000, "Write p95 exceeds the 2 s pilot target");
    }
  }
}
