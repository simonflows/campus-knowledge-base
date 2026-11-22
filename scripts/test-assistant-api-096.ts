import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards } from "../lib/knowledge";

const origin = "https://assistant-fixture.invalid";
test("assistant validates origin/body, reads only approved cards and never invokes a provider for a guest", async context => {
  const route = await import("../app/api/assistant/route").catch(() => null);
  assert.ok(route, "Assistant API is missing");
  const settings = { USE_DATABASE: "true", DOCUMENT_API_ENDPOINT: origin, CAMPUS_PUBLIC_ORIGIN: origin, CAMPUS_DEMO_LOGIN: "false", CAMPUS_LOCAL_DEMO: "false" };
  Object.assign(process.env, settings);
  delete process.env.SESSION_SECRET;
  resetDbAvailableCache();
  context.mock.method(globalThis, "fetch", () => assert.fail("No external or paid request is allowed"));
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof ScanCommand && command.input.TableName === "knowledge-cards") return { Items: knowledgeSeedCards };
    assert.fail("Assistant must not read private documents or write data");
  });
  context.after(() => { for (const name of Object.keys(settings)) delete process.env[name]; resetDbAvailableCache(); });
  function run(input: unknown, requestOrigin = origin) {
    const request = new NextRequest(origin + "/api/assistant", { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(input) });
    const requestStore = createRequestStoreForAPI(request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
    return workAsyncStorage.run({} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () => workUnitAsyncStorage.run(requestStore, () => route!.POST(request)));
  }
  assert.equal((await run({ message: "доступ" }, "https://other.invalid")).status, 403);
  assert.equal((await run({ message: "x".repeat(2001) })).status, 400);
  const response = await run({ message: "Как получить доступ?" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "local");
  assert.ok(result.message.includes("логин"));
  assert.ok(result.actions.some((action: { href: string }) => action.href === "/login"));
});
