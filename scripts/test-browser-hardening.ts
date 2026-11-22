import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as channel from "../lib/bridge/channel";
import { getTrustedPreviewOrigin } from "../lib/bridge/config";
import { getPreviewNavigationUrl } from "../lib/bridge/router";
import { editorialContentSchema } from "../lib/editorial";
import * as recovery from "../lib/editorial-recovery";
import { EDITORIAL_SESSION_ENDED } from "../lib/editorial-session-cleanup";

const trustedOrigin = "https://preview.example.test";
const ownerId = "editor-fixture";
const content = editorialContentSchema.parse({ title: "Редакционный текст" });
const draftKey = recovery.RECOVERY_PREFIX + ownerId + ":new";

function replaceGlobal(context: TestContext, key: string, value: object) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

test("preview stays disabled without an exact development origin", () => {
  assert.equal(getTrustedPreviewOrigin("production", trustedOrigin), null);
  assert.equal(getTrustedPreviewOrigin("test", trustedOrigin), null);
  assert.equal(getTrustedPreviewOrigin("development", undefined), null);
  assert.equal(getTrustedPreviewOrigin("development", "*"), null);
  assert.equal(getTrustedPreviewOrigin("development", trustedOrigin + "/app"), null);
  assert.equal(getTrustedPreviewOrigin("development", trustedOrigin + "/"), trustedOrigin);
});

test("preview navigation stays inside the configured app", () => {
  const current = "https://campus.example.test/campus/library";
  assert.equal(getPreviewNavigationUrl("/campus/editor", current, "/campus"), "https://campus.example.test/campus/editor");
  assert.equal(getPreviewNavigationUrl("https://other.example.test/campus/editor", current, "/campus"), null);
  assert.equal(getPreviewNavigationUrl("/campus-resources", current, "/campus"), null);
  assert.equal(getPreviewNavigationUrl(undefined, current, "/campus"), null);
});

test("preview commands require handshake, exact parent, and configured origin", (context) => {
  const deliveries: { message: unknown; origin: string }[] = [];
  const parent = {
    postMessage(message: unknown, origin: string) {
      deliveries.push({ message, origin });
    },
  };
  const frame: EventTarget & { parent: object } = Object.assign(new EventTarget(), { parent });
  replaceGlobal(context, "window", frame);
  assert.equal(channel.init("*"), null);
  frame.parent = frame;
  assert.equal(channel.init(trustedOrigin), null);
  frame.parent = parent;
  const cleanup = channel.init(trustedOrigin);
  assert.ok(cleanup);
  try {
    let commandCount = 0;
    channel.onMessage("get-url", () => commandCount++);
    const receive = (origin: string, source: object, data: object) => {
      frame.dispatchEvent(Object.assign(new Event("message"), { origin, source, data }));
    };
    const harmlessCommand = { type: "get-url", version: 1 };
    receive(trustedOrigin, parent, harmlessCommand);
    assert.equal(commandCount, 0, "the preview must first complete the handshake");
    const ping = { type: "ping", version: 1, payload: { secret: "test-handshake" } };
    receive(trustedOrigin, {}, ping);
    receive("https://other.example.test", parent, ping);
    assert.equal(channel.isBridgeReady(), false);
    receive(trustedOrigin, parent, ping);
    assert.equal(channel.isBridgeReady(), true);
    assert.deepEqual(deliveries, [{ message: ping, origin: trustedOrigin }]);
    receive("https://other.example.test", parent, harmlessCommand);
    receive(trustedOrigin, {}, harmlessCommand);
    assert.equal(commandCount, 0);
    receive(trustedOrigin, parent, harmlessCommand);
    assert.equal(commandCount, 1);
  } finally {
    cleanup();
  }
});

class FakeStorage {
  getItem(key: string): string | null {
    return Object.getOwnPropertyDescriptor(this, key)?.value ?? null;
  }
  setItem(key: string, value: string) {
    Object.defineProperty(this, key, { configurable: true, enumerable: true, writable: true, value });
  }
  removeItem(key: string) {
    Reflect.deleteProperty(this, key);
  }
}

function installStorage(context: TestContext) {
  const local = new FakeStorage();
  const session = new FakeStorage();
  replaceGlobal(context, "localStorage", local);
  replaceGlobal(context, "sessionStorage", session);
  return { local, session };
}

test("new unsaved text is recovered only from the current tab and for its owner", (context) => {
  const { local, session } = installStorage(context);
  assert.equal(recovery.saveEditorialRecovery(ownerId, null, 0, content), true);
  assert.equal(local.getItem(draftKey), null, "a draft must not be stored across browser sessions");
  assert.ok(session.getItem(draftKey));
  assert.deepEqual(recovery.readEditorialRecovery("other-editor"), []);
  assert.deepEqual(recovery.readEditorialRecovery(ownerId).map((copy) => copy.content), [content]);
});

test("a tab copy expires after eight hours", (context) => {
  const { session } = installStorage(context);
  const now = Date.now();
  const clock = context.mock.method(Date, "now", () => now);
  assert.ok(recovery.saveEditorialRecovery(ownerId, null, 0, content));
  clock.mock.mockImplementation(() => now + 8 * 60 * 60 * 1000);
  assert.deepEqual(recovery.readEditorialRecovery(ownerId), []);
  assert.equal(session.getItem(draftKey), null);
});

test("migration keeps a legacy copy until it can save the owner's text in the tab", (context) => {
  const { local, session } = installStorage(context);
  const otherKey = recovery.RECOVERY_PREFIX + "other-editor:new";
  const record = { ownerId, documentId: null, version: 0, savedAt: Date.now(), content };
  const legacy = JSON.stringify(record);
  local.setItem(draftKey, legacy);
  local.setItem(otherKey, JSON.stringify({ ...record, ownerId: "other-editor" }));
  const writes = context.mock.method(session, "setItem", () => {
    throw new Error("fixture storage quota");
  });
  recovery.migrateEditorialRecovery(ownerId);
  assert.equal(local.getItem(draftKey), legacy);
  assert.equal(recovery.saveEditorialRecovery(ownerId, null, 1, content), false);
  writes.mock.restore();
  recovery.migrateEditorialRecovery(ownerId);
  assert.deepEqual(recovery.readEditorialRecovery(ownerId), [record]);
  assert.equal(local.getItem(draftKey), null);
  assert.ok(local.getItem(otherKey));
});

test("migration leaves a conflicting legacy draft intact", (context) => {
  const { local } = installStorage(context);
  const record = { ownerId, documentId: null, version: 0, savedAt: Date.now(), content };
  const legacy = JSON.stringify(record);
  const current = { ...content, title: "Текст в открытой вкладке" };
  assert.ok(recovery.saveEditorialRecovery(ownerId, null, 0, current));
  local.setItem(draftKey, legacy);
  recovery.migrateEditorialRecovery(ownerId);
  assert.equal(local.getItem(draftKey), legacy);
  assert.deepEqual(recovery.readEditorialRecovery(ownerId).map((copy) => copy.content), [current]);
});

test("successful session end clears copies without reading the drafts or unrelated storage", (context) => {
  const { local, session } = installStorage(context);
  const frame = new EventTarget();
  replaceGlobal(context, "window", frame);
  let ended = false;
  frame.addEventListener(EDITORIAL_SESSION_ENDED, () => { ended = true; });
  local.setItem(draftKey, "legacy editorial fixture");
  local.setItem("unrelated", "local preference");
  session.setItem("unrelated", "session preference");
  assert.ok(recovery.saveEditorialRecovery(ownerId, null, 0, content));
  const anotherTab = Object.assign(new FakeStorage(), session);
  const readLocal = context.mock.method(local, "getItem", () => {
    assert.fail("local copies must be erased by key alone at logout");
  });
  recovery.clearEditorialRecovery();
  assert.equal(readLocal.mock.callCount(), 0);
  readLocal.mock.restore();
  assert.equal(ended, true);
  assert.equal(local.getItem(draftKey), null);
  assert.equal(session.getItem(draftKey), null);
  assert.equal(local.getItem("unrelated"), "local preference");
  assert.equal(session.getItem("unrelated"), "session preference");
  Object.assign(session, anotherTab);
  assert.ok(session.getItem(draftKey));
  assert.deepEqual(recovery.readEditorialRecovery(ownerId), []);
  assert.equal(session.getItem(draftKey), null);
});
