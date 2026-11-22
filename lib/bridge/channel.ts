"use client";

import { getTrustedPreviewOrigin } from "./config";
import {
  BRIDGE_VERSION,
  isValidMessage,
  type BridgeMessage,
  type BridgePayload,
} from "./types";

interface MessageHandler {
  (message: BridgeMessage<BridgePayload>): void;
}

let preview: { parent: Window; origin: string } | null = null;
let secret: string | null = null;
const handlers = new Map<string, MessageHandler>();

export function isBridgeReady(): boolean {
  return secret !== null;
}

export function getParentWindow(): Window | null {
  return isBridgeReady() ? preview?.parent ?? null : null;
}

export function getSecret(): string | null {
  return secret;
}

export function postMessage(
  message: Omit<BridgeMessage<BridgePayload>, "version">
) {
  if (!preview || !isBridgeReady()) return;
  preview.parent.postMessage(
    { ...message, version: BRIDGE_VERSION },
    preview.origin
  );
}

export function onMessage(type: string, handler: MessageHandler) {
  handlers.set(type, handler);
}

export function offMessage(type: string) {
  handlers.delete(type);
}

function handleMessage(event: MessageEvent) {
  if (!preview || event.source !== preview.parent || event.origin !== preview.origin) return;

  const data = event.data;
  if (!isValidMessage(data)) {
    return;
  }

  if (data.type === "ping") {
    const payload = data.payload as { secret?: string };
    if (typeof payload?.secret !== "string" || !payload.secret) return;
    secret ??= payload.secret;
    if (payload.secret !== secret) return;
    postMessage({ type: "ping", payload: { secret } });
  }

  if (!isBridgeReady()) return;
  handlers.get(data.type)?.(data);
}

export function init(trustedOrigin: string) {
  const origin = getTrustedPreviewOrigin("development", trustedOrigin);
  if (!origin || window.parent === window) return null;
  preview = { parent: window.parent, origin };
  window.addEventListener("message", handleMessage);
  return () => {
    window.removeEventListener("message", handleMessage);
    preview = null;
    secret = null;
    handlers.clear();
  };
}
