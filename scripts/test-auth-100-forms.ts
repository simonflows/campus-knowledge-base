import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { EmailAccountForm } from "../components/auth/email-account-form";

for (const mode of ["login", "verify", "reset"] as const) {
  test("server-rendered account form cannot submit a password in the URL: " + mode, () => {
    const html = renderToStaticMarkup(createElement(
      AppRouterContext.Provider,
      { value: { back() {}, forward() {}, push() {}, replace() {}, refresh() {}, prefetch() {}, bfcacheId: "fixture" } },
      createElement(EmailAccountForm, { initialMode: mode, basePath: "", returnTo: "/knowledge" }),
    ));
    assert.match(html, /<form\b[^>]*\bmethod="post"/i);
    const password = html.match(/<input\b[^>]*\btype="password"[^>]*>/i);
    assert.ok(password);
    assert.doesNotMatch(password[0], /\bname=/i);
    const button = html.match(/<button\b[^>]*\btype="submit"[^>]*>/i);
    assert.ok(button);
    assert.match(button[0], /\bdisabled(?:=""|\s|>)/i);
  });
}
