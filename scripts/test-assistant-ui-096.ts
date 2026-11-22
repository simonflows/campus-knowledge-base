import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAssistantAnswer,
  safeAssistantHref,
} from "../components/assistant/assistant-answer";

test("assistant links stay on the allowed product routes", () => {
  assert.equal(
    safeAssistantHref("/knowledge?card=card-1&version=cv-1"),
    "/knowledge?card=card-1&version=cv-1"
  );
  assert.equal(safeAssistantHref("/editor"), "/editor");
  assert.equal(safeAssistantHref("https://example.org"), null);
  assert.equal(safeAssistantHref("//example.org/knowledge"), null);
  assert.equal(safeAssistantHref("/api/assistant"), null);
});

test("a busy reply retains local citations and removes invalid actions", () => {
  const citation = {
    cardId: "card-1",
    versionId: "cv-1",
    sourceId: "s1",
    factId: "f1",
    title: "Учебная карточка",
    quote: "Точный фрагмент",
    field: "title",
    label: "Название",
    href: "/knowledge?card=card-1&version=cv-1",
  };
  const answer = parseAssistantAnswer({
    status: "busy",
    message: "Активен локальный поиск",
    citations: [citation],
    actions: [
      { label: "Открыть редактор", href: "/editor" },
      { label: "Недопустимый адрес", href: "https://example.org" },
    ],
  });
  assert.deepEqual(answer, {
    status: "busy",
    message: "Активен локальный поиск",
    citations: [citation],
    actions: [{ label: "Открыть редактор", href: "/editor" }],
  });
  assert.equal(parseAssistantAnswer({ message: "Неполный ответ" }), null);
});
