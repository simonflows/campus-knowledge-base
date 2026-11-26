import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAssistantAnswer } from "../components/assistant/assistant-answer";

const external = {
  status: "ready", mode: "web", message: "Сведения из интернета.", citations: [], actions: [],
  externalSources: [{ id: "1", title: "Университет", url: "https://www.susu.ru/ru/news" }],
};

test("internet answers retain their separate evidence type and safe outbound links", () => {
  const parsed = parseAssistantAnswer(external);
  assert.equal(parsed?.mode, "web");
  assert.equal(parsed?.externalSources?.[0].url, external.externalSources[0].url);
  assert.deepEqual(parsed?.citations, []);
});

test("internet evidence cannot be presented as approved canon or an unsafe link", () => {
  assert.equal(parseAssistantAnswer({ ...external, mode: "canon" }), null);
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "https://secret@example.com/", "http://127.0.0.1/private", "http://[::1]/", "http://metadata.google.internal/"]) {
    const parsed = parseAssistantAnswer({ ...external, externalSources: [{ id: "1", title: "Источник", url }] });
    assert.ok(parsed === null || parsed.externalSources?.length === 0, url);
  }
});
