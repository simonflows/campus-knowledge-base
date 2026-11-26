import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createElement, type ContextType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { folderIds, knowledgeSeedCards } from "../lib/knowledge";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";

const router: NonNullable<ContextType<typeof AppRouterContext>> = {
  back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {},
  bfcacheId: "test",
};
const modules = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css"))
      return { format: "commonjs", source: "module.exports = {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const component = import("../components/knowledge/knowledge-base").finally(() => modules.deregister());

async function renderCatalog(params: Record<string, string>, serverQuery = params.q) {
  const { KnowledgeBase } = await component;
  return renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(params) },
        createElement(KnowledgeBase, {
          initialCards: knowledgeSeedCards,
          initialCustomTypes: [],
          initialFolderId: params.folder,
          initialQuery: serverQuery,
          dbAvailable: true,
          currentUser: null,
        }),
      ),
    ),
  );
}

test("a search inside a university folder excludes matching cards from other universities", async () => {
  const html = await renderCatalog({ folder: folderIds.university("midis"), q: "эндопротезирования" });
  assert.match(html, /<h2[^>]*>МИДиС<\/h2>/);
  assert.match(html, /Ничего не найдено/);
  assert.doesNotMatch(html, /Открыть карточку: Программа реабилитации/);
});

test("global search can be selected explicitly and supports existing bare query links", async () => {
  const links: Record<string, string>[] = [
    { folder: folderIds.university("midis"), q: "эндопротезирования", scope: "all" },
    { q: "эндопротезирования" },
  ];
  for (const params of links) {
    const html = await renderCatalog(params);
    assert.match(html, /Во всех папках/);
    assert.match(html, /Открыть карточку: Программа реабилитации/);
  }
});

test("type and status filters are restored as folder-scoped filters after navigation", async () => {
  const folder = folderIds.university("midis");
  const projects = await renderCatalog({ folder, type: "project", status: "approved" });
  assert.match(projects, /Открыть карточку: Платформа сервисного дизайна/);
  assert.doesNotMatch(projects, /Открыть карточку: Программа реабилитации/);
  assert.doesNotMatch(projects, /Открыть карточку: Паспорт/);
  const pending = await renderCatalog({ folder, type: "project", status: "pending" });
  assert.match(pending, /Ничего не найдено/);
});

test("browser history restores the search from the current URL even with cached server props", async () => {
  const html = await renderCatalog({
    folder: folderIds.university("midis"),
    q: "эндопротезирования",
    type: "university",
    status: "approved",
  }, "");
  assert.ok(html.includes('value="эндопротезирования"'));
  assert.ok(html.includes("Ничего не найдено"));
});

test("turning off joint status clears both hidden participant fields for saving", async () => {
  await component;
  const { projectParticipantFields } = await import("../components/knowledge/knowledge-card-form");
  const project = knowledgeSeedCards.find((card) => card.id === "project-midis-service-design");
  assert.ok(project?.type === "project");
  const fields = projectParticipantFields(false, ["midis", "csu"], ["Внешняя организация"], true);
  const parsed = knowledgeCardInputSchema.safeParse({ ...project, ...fields });
  assert.equal(parsed.success, true, parsed.error?.issues.map(({ message }) => message).join(", "));
  assert.deepEqual(fields.participantUniversityIds, []);
  assert.deepEqual(fields.externalParticipantNames, []);
  const reinstated = projectParticipantFields(true, ["midis", "csu"], ["Внешняя организация"], true);
  assert.deepEqual(reinstated.participantUniversityIds, ["midis", "csu"]);
  assert.deepEqual(reinstated.externalParticipantNames, ["Внешняя организация"]);
});
