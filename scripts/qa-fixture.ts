import assert from "node:assert/strict";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { docClient } from "../lib/db";
import { articleSeed } from "../lib/articles";
import { TableName } from "../lib/schema";

export function requireDisposableDatabase() {
  assert.equal(process.env.CAMPUS_QA_DISPOSABLE, "yes", "Use an isolated in-memory QA database and set CAMPUS_QA_DISPOSABLE=yes");
  assert.equal(process.env.DOCUMENT_API_ENDPOINT, "http://127.0.0.1:8000", "Only the loopback QA Document API is allowed");
  assert.ok(process.env.AWS_ACCESS_KEY_ID === "campusLocalTest", "Use only the fixture identity");
  assert.ok(process.env.AWS_SECRET_ACCESS_KEY === "localTestOnly", "Use only synthetic fixture credentials");
}

export async function markDisposableFixture() {
  requireDisposableDatabase();
  const id = "qa-marker-" + randomUUID();
  await docClient.send(new PutCommand({
    TableName: TableName.ARTICLES,
    Item: { ...articleSeed[0], id, title: "Disposable QA " + id, approval: { approvedBy: "qa-fixture", approvedAt: new Date().toISOString(), revisionId: id } },
    ConditionExpression: "attribute_not_exists(id)",
  }));
  console.log(id);
}

export async function requireFixtureDatabase() {
  requireDisposableDatabase();
  const id = process.env.CAMPUS_QA_MARKER;
  assert.match(id || "", /^qa-marker-[0-9a-f-]{36}$/, "Create a marker on the disposable fixture first");
  const { Item } = await docClient.send(new GetCommand({ TableName: TableName.ARTICLES, Key: { id }, ConsistentRead: true }));
  assert.equal(Item?.title, "Disposable QA " + id, "QA marker absent in this database");
  return id!;
}

export async function requireFixtureServer() {
  const id = await requireFixtureDatabase();
  const base = process.env.CAMPUS_QA_ORIGIN || "http://localhost:8080";
  assert.ok(["http://localhost:8080", "http://127.0.0.1:8080", "http://127.0.0.2:8080"].includes(base), "QA server must use loopback port 8080");
  const response = await fetch(base + "/api/articles/" + id, { redirect: "error" });
  assert.equal(response.status, 200, "Server must read the marked disposable database");
  assert.equal((await response.json()).title, "Disposable QA " + id);
  return base;
}
