import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  cardTypeIcons,
  getFolderIcon,
} from "../components/knowledge/knowledge-icons";
import { demoLoginEnabled, authenticatePilot } from "../lib/pilot-auth";
import { folderIds, type KnowledgeFolderNode } from "../lib/knowledge";
import { installPilotFixture } from "./pilot-fixture";

test("public demo flags cannot enable profile login in production; real staff keys still work", () => {
  const names = [
    "NODE_ENV",
    "CAMPUS_DEMO_LOGIN",
    "SESSION_SECRET",
    "CAMPUS_PILOT_ACCOUNTS",
  ] as const;
  const original = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      CAMPUS_DEMO_LOGIN: "true",
    });
    assert.equal(demoLoginEnabled(), false);
    const fixture = installPilotFixture();
    process.env.CAMPUS_DEMO_LOGIN = "true";
    assert.equal(demoLoginEnabled(), false);
    const user = authenticatePilot(
      "qa-pr-midis",
      fixture.keys.get("demo-pr-midis")
    );
    assert.equal(user?.role, "university_pr");
    assert.equal(authenticatePilot("qa-pr-midis", "incorrect"), null);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else Object.assign(process.env, { [name]: original[name] });
    }
  }
});

test("folder and card categories share their symbols", () => {
  const node = (key: string): KnowledgeFolderNode => ({
    id: folderIds.subfolder("midis", key as "passport"),
    name: key,
    description: "",
    kind: "subfolder",
  });
  assert.equal(getFolderIcon(node("passport")), cardTypeIcons.university);
  assert.equal(getFolderIcon(node("infrastructure")), cardTypeIcons.laboratory);
  assert.equal(getFolderIcon(node("products")), cardTypeIcons.project);
  assert.equal(
    new Set(Object.values(cardTypeIcons)).size,
    Object.keys(cardTypeIcons).length
  );
});

test("package, lock and immutable image advertise the same release", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(pkg.version, "1.1.0");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.ok(
    readFileSync("Dockerfile", "utf8").includes(
      `org.opencontainers.image.version=${pkg.version}`
    )
  );
});
