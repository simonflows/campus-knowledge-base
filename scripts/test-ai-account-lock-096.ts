import assert from "node:assert/strict";
import { test } from "node:test";
import { runLimitedAi } from "../lib/flash-assist";

test("an active account stays locked beyond the cooldown and releases on completion", async () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  let release!: () => void;
  let first: ReturnType<typeof runLimitedAi> | undefined;
  try {
    first = runLimitedAi(new Request("https://canon.invalid/api/ai"), "qa-active-lock", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "first";
    });
    now += 11_000;
    const second = await runLimitedAi(new Request("https://canon.invalid/api/ai"), "qa-active-lock", async () => "second");
    assert.deepEqual(second, { status: "busy" });
    release();
    assert.deepEqual(await first, { status: "ready", value: "first" });
    assert.deepEqual(await runLimitedAi(new Request("https://canon.invalid/api/ai"), "qa-active-lock", async () => "next"), { status: "ready", value: "next" });
  } finally {
    release?.();
    await first;
    Date.now = originalNow;
  }
});

test("failed operations release the account while retaining the start cooldown", async () => {
  const originalNow = Date.now;
  let now = 3_000_000;
  Date.now = () => now;
  try {
    const request = new Request("https://canon.invalid/api/ai");
    assert.deepEqual(await runLimitedAi(request, "qa-failed-lock", async () => { throw new Error("synthetic"); }), { status: "failed" });
    assert.deepEqual(await runLimitedAi(request, "qa-failed-lock", async () => "early"), { status: "busy" });
    now += 11_000;
    assert.deepEqual(await runLimitedAi(request, "qa-failed-lock", async () => "recovered"), { status: "ready", value: "recovered" });
  } finally {
    Date.now = originalNow;
  }
});
