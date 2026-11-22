"use client";

import { AnalyticsWorkspace } from "@/components/analytics/analytics-workspace";
import { SmartEditorWorkspace } from "@/components/editor/smart-editor-workspace";
import { FactCheckWorkspace } from "@/components/fact-check/fact-check-workspace";
import { HomeDashboard } from "@/components/home-dashboard";
import { KnowledgeBase } from "@/components/knowledge/knowledge-base";
import { RequestsWorkspace } from "@/components/requests/requests-workspace";
import { WorkWorkspace } from "@/components/work/work-workspace";
import { normalizeWorkSection } from "@/components/work/work-state";
import { AppLink } from "@/components/navigation/workspace-navigation";
import { getAnalyticsExamples } from "@/lib/analytics";
import { demoAccounts } from "@/lib/auth";
import {
  approvedDemoCards,
  demoArticles,
  demoUser,
  visibleDemoCards,
  type BrowserDemoState,
} from "@/lib/browser-demo";
import { visibleDemoRequests } from "@/lib/browser-demo-collaboration";
import type { DemoLocation } from "@/lib/browser-demo-navigation";
import { universities } from "@/lib/data";
import {
  folderIds,
  getUniversityIdFromFolder,
  type CampusCard,
} from "@/lib/knowledge";

const owners = demoAccounts
  .filter(({ role }) => ["university_owner", "rio", "chkk"].includes(role))
  .map(({ id, role, universityId, ownershipLabel }) => ({
    id,
    role,
    universityId,
    ownershipLabel,
  }));

function linkedId(value: string | null) {
  return value && value.length <= 100 && /^[a-z0-9][a-z0-9._-]*$/i.test(value)
    ? value
    : undefined;
}

export function DemoPageContent({
  state,
  location,
  account,
}: {
  state: BrowserDemoState;
  location: DemoLocation;
  account: React.ReactNode;
}) {
  const { pathname, search } = location;
  const params = new URLSearchParams(search);
  const user = demoUser(state);
  const cards = approvedDemoCards(state);
  const articles = demoArticles(state);
  const staff = user.role !== "guest";
  const visibleCards = visibleDemoCards(state);
  const customTypes = (state.cardTypes ?? []).map((type) => ({
    ...type,
    cardCount: visibleCards.filter(
      (card) => card.type === "custom" && card.customTypeId === type.id
    ).length,
  }));
  switch (pathname) {
    case "/knowledge": {
      const approved = params.get("version") === "approved";
      const folder = params.get("folder");
      const university = folder ? getUniversityIdFromFolder(folder) : null;
      const folderArticles =
        university && folder === folderIds.subfolder(university, "articles")
          ? articles.filter((article) => article.universityId === university)
          : undefined;
      return (
        <KnowledgeBase
          key={search}
          initialCards={approved ? cards : visibleCards}
          initialCardId={params.get("card")}
          initialCustomTypes={customTypes}
          initialAction={approved ? null : params.get("action")}
          initialFolderId={folder}
          initialFolderArticles={folderArticles}
          initialQuery={params.get("q") ?? ""}
          dbAvailable
          currentUser={approved ? null : user}
          ownerCandidates={user.role === "admin" ? owners : []}
        />
      );
    }
    case "/editor": {
      const draft = linkedId(params.get("draft"));
      return (
        <SmartEditorWorkspace
          key={search}
          initialArticles={articles}
          cardsCount={cards.length}
          dbAvailable
          currentUser={user}
          flashAssistAvailable={staff}
          initialDocumentId={draft}
          initialArticleId={draft ? undefined : linkedId(params.get("article"))}
        />
      );
    }
    case "/check":
      return (
        <FactCheckWorkspace
          cardsCount={cards.length}
          flashAssistAvailable={staff}
        />
      );
    case "/analytics":
      return staff ? (
        <AnalyticsWorkspace
          cardsCount={cards.length}
          dbAvailable
          flashAssistAvailable
          dynamicExamples={getAnalyticsExamples(cards, customTypes)}
        />
      ) : (
        <DemoStaffAccess />
      );
    case "/requests":
      return (
        <RequestsWorkspace
          key={search}
          initialItems={visibleDemoRequests(state)}
          user={user}
          available={staff}
          initialQuestion={params.get("q") ?? ""}
          initialCardId={linkedId(params.get("card")) ?? null}
          initialRequestId={linkedId(params.get("request"))}
        />
      );
    case "/work":
      return staff ? (
        <WorkWorkspace
          section={normalizeWorkSection(
            params.get("tab") ?? undefined,
            user.role === "admin"
          )}
          record={linkedId(params.get("record"))}
          create={params.get("new") === "1"}
          admin={user.role === "admin"}
        />
      ) : (
        <DemoStaffAccess />
      );
    case "/login":
      return (
        <section className="atlas-wrap campus-workspace">
          <h1 className="text-2xl font-semibold">Учебные роли</h1>
          <p className="my-3 max-w-prose">
            Переключайте роли, чтобы пройти согласование или ответить на запрос
            от другого вуза.
          </p>
          {account}
        </section>
      );
    default: {
      const passport =
        cards.find(
          (card): card is CampusCard =>
            card.type === "campus" && card.id === "campus-passport"
        ) ?? null;
      return (
        <HomeDashboard
          passport={passport}
          universities={universities}
          cardsCount={cards.length}
          showExampleData={false}
          hasMidisPassport={cards.some(
            (card) => card.id === "university-midis"
          )}
        />
      );
    }
  }
}

function DemoStaffAccess() {
  return (
    <section className="atlas-wrap campus-workspace">
      <h1 className="text-2xl font-semibold">Раздел доступен сотрудникам</h1>
      <AppLink className="desk-text-link" href="/login">
        Выбрать учебную роль сотрудника
      </AppLink>
    </section>
  );
}
