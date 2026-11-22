import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { DELETE } from "../app/api/auth/session/route";
import { canEditCard, canSeeCard, getDemoAccount, toSessionUser } from "../lib/auth";
import * as channel from "../lib/bridge/channel";
import { computeSelector } from "../lib/bridge/element-selector";
import { init as initErrors } from "../lib/bridge/errors";
import * as inspector from "../lib/bridge/inspector";
import type { CustomCard } from "../lib/knowledge";

const appOrigin = "https://canon.example.test";
const previewOrigin = "https://preview.example.test";

test("logout sets a non-cacheable response and expires the host-only session cookie", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("Unexpected network call"));
  process.env.CAMPUS_PUBLIC_ORIGIN = appOrigin;
  const response = await DELETE(new NextRequest(appOrigin + "/api/auth/session", {
    method: "DELETE",
    headers: { origin: appOrigin },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const cookie = response.cookies.get("__Host-vibecraft-session");
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.path === "/" && !cookie.domain);
  assert.equal(cookie.maxAge, 0);
});

test("a university submitter cannot edit a draft outside their current university", () => {
  const profile = getDemoAccount("demo-owner-csu");
  assert.ok(profile);
  const submittingUser = toSessionUser(profile);
  const transferredUser = { ...submittingUser, universityId: "susu" };
  const draft: CustomCard = {
    id: "draft-fixture",
    type: "custom",
    customTypeId: "fixture",
    title: "Черновик для проверки",
    owners: [],
    folderId: "01_universities/csu/products",
    referenceDescription: "",
    stopFormula: "",
    createdAt: "",
    updatedAt: "",
    status: "pending",
    submittedBy: submittingUser.id,
    customFields: {},
  };

  assert.equal(canEditCard(submittingUser, draft), true);
  assert.equal(canSeeCard(submittingUser, draft), true);
  assert.equal(canEditCard(transferredUser, draft), false);
});

test("a cross-university request author can read their rejected candidate without editing it", () => {
  const author = toSessionUser(getDemoAccount("demo-owner-susu")!);
  const outsider = toSessionUser(getDemoAccount("demo-owner-csu")!);
  const card: CustomCard = {
    id: "request-fixture", type: "custom", customTypeId: "fixture",
    title: "Ответ другого вуза", owners: [], ownerIds: ["fixture-midis-owner"],
    folderId: "01_universities/midis/products", referenceDescription: "",
    stopFormula: "", createdAt: "", updatedAt: "", status: "rejected",
    submittedBy: author.id, customFields: {},
  };
  assert.equal(canSeeCard(author, card), true);
  assert.equal(canEditCard(author, card), false);
  assert.equal(canSeeCard(outsider, card), false);
});

function replaceGlobal(key: string, value: object) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  return () => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  };
}

function fixturePreview() {
  const deliveries: { type: string; payload: unknown }[] = [];
  const parent = {
    postMessage(message: (typeof deliveries)[number]) {
      deliveries.push(structuredClone(message));
    },
  };
  const frame = Object.assign(new EventTarget(), { parent });
  const restoreWindow = replaceGlobal("window", frame);
  const close = channel.init(previewOrigin);
  assert.ok(close);
  const send = (data: { type: string; payload?: unknown }) => {
    frame.dispatchEvent(Object.assign(new Event("message"), {
      data: { ...data, version: 1 },
      origin: previewOrigin,
      source: parent,
    }));
  };
  send({ type: "ping", payload: { secret: "fixture-handshake" } });
  return {
    deliveries,
    send,
    close() {
      close();
      restoreWindow();
    },
  };
}

test("an invalid toggle leaves the inspector state unchanged", (context) => {
  const { send, close } = fixturePreview();
  const stopInspector = inspector.init();
  context.after(() => {
    stopInspector();
    close();
  });
  send({ type: "toggle-inspector", payload: { enabled: "false" } });
  assert.equal(inspector.getState().active, false);
  send({ type: "toggle-inspector", payload: { enabled: true } });
  assert.equal(inspector.getState().active, true);
  send({ type: "toggle-inspector", payload: { enabled: false } });
  assert.equal(inspector.getState().active, false);
});

test("preview console forwarding accepts ordinary uncloneable arguments", (context) => {
  const { deliveries, close } = fixturePreview();
  const restoreDocument = replaceGlobal("document", { body: {} });
  const restoreObserver = replaceGlobal("MutationObserver", class {
    observe() {}
    disconnect() {}
  });
  const original = context.mock.method(console, "log", () => {});
  const stopErrors = initErrors();
  context.after(() => {
    stopErrors();
    close();
    restoreObserver();
    restoreDocument();
  });
  const input = [Symbol("fixture"), function testCallback() {}];
  assert.doesNotThrow(() => console.log(...input));
  assert.equal(original.mock.callCount(), 1);
  assert.deepEqual(deliveries.at(-1), {
    version: 1,
    type: "console",
    payload: {
      level: "log",
      args: ["Symbol(fixture)", String(input[1])],
    },
  });
  assert.doesNotThrow(() => console.log(Object.create(null)));
  assert.deepEqual(deliveries.at(-1)?.payload, { level: "log", args: ["[Unprintable value]"] });
});

test("preview element selectors escape CSS identifiers and identify the preview root", (context) => {
  context.after(replaceGlobal("CSS", {
    escape: (id: string) => id.replace(/[:/]/g, (character) => "\\" + character),
  }));
  const root = { tagName: "BODY", id: "" } as Element;
  const withId = { id: "section:authors" } as Element;
  const withClasses = {
    id: "",
    tagName: "DIV",
    classList: ["sm:flex", "w-1/2"],
    parentElement: null,
  } as unknown as Element;
  assert.equal(computeSelector(withId, root), "#section\\:authors");
  assert.equal(computeSelector(withClasses, root), "div.sm\\:flex.w-1\\/2");
  assert.equal(computeSelector(root, root), "body");
});
