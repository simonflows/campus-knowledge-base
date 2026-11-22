"use client";

import { onMessage, offMessage, postMessage } from "./channel";

function getUrlPayload() {
  return {
    href: window.location.href,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function sendUrl() {
  postMessage({ type: "url", payload: getUrlPayload() });
}

function sendRouteChange() {
  postMessage({ type: "route-change", payload: getUrlPayload() });
}

export function getPreviewNavigationUrl(
  value: unknown,
  currentHref: string,
  basePath: string
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const current = new URL(currentHref);
    const target = new URL(value, current);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.origin !== current.origin ||
      target.username ||
      target.password ||
      (basePath &&
        target.pathname !== basePath &&
        !target.pathname.startsWith(`${basePath}/`))
    ) return null;
    return target.href;
  } catch {
    return null;
  }
}

export function init(basePath: string) {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    sendRouteChange();
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    sendRouteChange();
  };

  window.addEventListener("popstate", sendRouteChange);

  const handleGetUrl = () => {
    sendUrl();
  };

  const handleNavigate = (message: { payload?: unknown }) => {
    const payload = message.payload as { url?: unknown } | undefined;
    const url = getPreviewNavigationUrl(payload?.url, window.location.href, basePath);
    if (url) window.location.assign(url);
  };

  onMessage("get-url", handleGetUrl);
  onMessage("navigate", handleNavigate);

  sendUrl();

  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", sendRouteChange);
    offMessage("get-url");
    offMessage("navigate");
  };
}
