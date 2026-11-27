import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const requireActual = createRequire(import.meta.url);
const source = readFileSync("components/auth/login-screen.tsx", "utf8");
const transpiled = ts.transpileModule(source, {
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
});
assert.deepEqual(
  (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ),
  [],
  "LoginScreen must parse without compiler recovery"
);
const compiled = transpiled.outputText;
const loaded = {
  exports: {} as {
    LoginScreen: React.ComponentType<{
      currentUser: null;
      demo: boolean;
      yandexEnabled: boolean;
    }>;
  },
};
vm.runInNewContext(compiled, {
  module: loaded,
  exports: loaded.exports,
  process,
  console,
  require: (name: string) => {
    if (name.endsWith(".css")) return {};
    if (name === "@/components/workspace-masthead")
      return { WorkspaceMasthead: () => null };
    if (name === "@/components/auth/yandex-sign-in-button")
      return {
        YandexSignInButton: () =>
          React.createElement(
            "button",
            { type: "submit" },
            "Войти с Яндекс ID"
          ),
      };
    if (name === "next/navigation")
      return { useRouter: () => ({ refresh() {}, push() {} }) };
    return requireActual(
      name.startsWith("@/") ? path.resolve(name.slice(2)) : name
    );
  },
});
for (const demo of [false, true])
  test(`retired public demo is absent with local fixture login ${demo}; OAuth remains native POST`, () => {
    const html = renderToStaticMarkup(
      React.createElement(loaded.exports.LoginScreen, {
        currentUser: null,
        demo,
        yandexEnabled: true,
      })
    );
    assert.doesNotMatch(html, /href="[^\"]*\/demo|Попробовать в демо-режиме/);
    assert.match(
      html,
      /action="\/api\/auth\/yandex\/start\?next=%2Fknowledge"/
    );
    const forms = html.match(/<form\b[^>]*>/gi) ?? [];
    assert.ok(forms.length > 0);
    for (const form of forms) assert.match(form, /\bmethod="post"/i);
  });
