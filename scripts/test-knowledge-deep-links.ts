import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { knowledgeSeedCards } from "../lib/knowledge";
import type { SessionUser } from "../lib/auth";
import type { InformationRequest } from "../lib/information-requests";

const router: NonNullable<React.ContextType<typeof AppRouterContext>> = {
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
const components = Promise.all([
  import("../components/knowledge/knowledge-base"),
  import("../components/requests/requests-workspace"),
]).finally(() => modules.deregister());

test("approved links open the approved card, exact cv links open history", async () => {
  const [{ KnowledgeBase }] = await components;
  const id = "campus-passport";
  const render = (version: string) => renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams({ card: id, version }) },
        createElement(KnowledgeBase, {
          initialCards: knowledgeSeedCards, initialCardId: id, initialCustomTypes: [],
          dbAvailable: true, currentUser: null,
        }),
      ),
    ),
  );
  assert.doesNotMatch(render("approved"), /Загружаем зафиксированную версию/);
  assert.match(render("approved"), /Паспорт кампуса/);
  assert.match(render("cv-20261122-test-exact"), /Загружаем зафиксированную версию/);
});

test("a missing request link has the same neutral state as an inaccessible one", async () => {
  const [, { RequestsWorkspace }] = await components;
  const user: SessionUser = {
    id: "test-pr", name: "Редактор", organization: "МИДиС", position: "Редактор",
    role: "university_pr", universityId: "midis", ownershipLabel: "Редактор",
    ownerAliases: [], organizationAliases: [],
  };
  const item: InformationRequest = {
    id: "accessible", subject: "Другой доступный запрос",
    question: "Текст из другого запроса не должен открыться по этой ссылке.",
    authorId: user.id, authorName: user.name, authorOrganization: user.organization,
    recipientUniversityId: "csu", linkedCardId: null, status: "open", answer: null,
    evidenceUrl: null, answeredBy: null, candidateCardId: null, createdAt: "2026-11-22",
    updatedAt: "2026-11-22", revision: 1, creationDigest: "", lastOperationId: null,
    lastOperationDigest: null,
  };
  const render = (id: string, items = [item]) => renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(RequestsWorkspace, {
        initialItems: items, initialCardId: null, initialQuestion: "",
        initialRequestId: id, user, available: true,
      }),
    ),
  );
  for (const id of ["missing", "inaccessible"]) {
    const html = render(id);
    assert.match(html, /Запрос недоступен/);
    assert.match(html, /К списку запросов/);
    assert.doesNotMatch(html, /Текст из другого запроса/);
    assert.match(render(id, []), /Запрос недоступен/);
  }
  assert.match(render("accessible"), /Текст из другого запроса/);
});
