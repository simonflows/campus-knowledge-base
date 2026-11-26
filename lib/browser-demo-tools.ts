import { z } from "zod";
import { buildAnalyticsReport } from "./analytics";
import {
  assistantQuestion,
  findAssistantGuide,
  isCampusStatisticQuestion,
} from "./assistant-query";
import { approvedDemoCards, demoUser, visibleDemoCards } from "./browser-demo";
import { demoError, type DemoHandler } from "./browser-demo-http";
import { demoCardVersionId } from "./browser-demo-version";
import type { CanonChatAnswer } from "./canon-ai";
import { buildCanonSources, resolveCanonReference } from "./canon-context";
import { findCampusServices } from "./campus-services";
import { buildCanonicalRewrite, checkFactText } from "./fact-check";
import { summarizeRewrite } from "./fact-report";
import { findHomeCards } from "./home-card-search";
import { searchKnowledgeCards } from "./knowledge-search";
import { analyticsQuerySchema } from "./validation/analytics";
import { factCheckInputSchema } from "./validation/fact-check";

const chatInput = z.object({ message: z.string().trim().min(2).max(2000) });

export const handleDemoTools: DemoHandler = (call) => {
  const path = call.url.pathname;
  if (path === "/api/search" && call.method === "GET") {
    const state = call.state;
    const query = z
      .string()
      .trim()
      .max(2000)
      .parse(call.url.searchParams.get("q") ?? "");
    return Response.json({
      services: findCampusServices(query, false),
      cards: findHomeCards(visibleDemoCards(state), query, demoUser(state)),
    });
  }
  if (
    call.method !== "POST" ||
    !["/api/fact-check", "/api/analytics", "/api/assistant"].includes(path)
  )
    return;
  const state = call.state;
  const cards = approvedDemoCards(state);
  const user = demoUser(state);
  if (path === "/api/fact-check") {
    const { text, mode, flashAssist, useAi } = factCheckInputSchema.parse(
      call.body()
    );
    const versions = new Map(
      cards.map((card) => [card.id, demoCardVersionId(card)])
    );
    const versioned = (report: ReturnType<typeof checkFactText>) => ({
      ...report,
      findings: report.findings.map((finding) => ({
        ...finding,
        ...(finding.sourceCardId &&
          versions.has(finding.sourceCardId) && {
            sourceVersionId: versions.get(finding.sourceCardId),
          }),
      })),
    });
    const result = versioned(checkFactText(text, cards));
    if (mode === "rewrite") {
      const rewrite = buildCanonicalRewrite(text, cards);
      const checked = rewrite ? checkFactText(rewrite.plainText, cards) : null;
      return Response.json({
        ...result,
        rewrite: rewrite && {
          ...rewrite,
          sourceVersions: Object.fromEntries(
            rewrite.sourceCardIds.flatMap((id) =>
              versions.has(id) ? [[id, versions.get(id)!]] : []
            )
          ),
        },
        rewriteAi: { status: "local" },
        rewriteCheck: checked ? summarizeRewrite(versioned(checked)) : null,
        ...(!rewrite && {
          rewriteError:
            "В учебных карточках недостаточно сведений по теме текста.",
        }),
      });
    }
    const fragments = result.findings
      .filter((item) => item.level !== "green")
      .map((item) => item.quote)
      .filter(Boolean)
      .slice(0, 6);
    return Response.json({
      ...result,
      ...(useAi &&
        user.role !== "guest" && {
          ai: {
            status: "ready",
            checkedAt: new Date().toISOString(),
            claims: [],
            sources: [],
          },
        }),
      ...(flashAssist &&
        user.role !== "guest" && {
          flashAssist: { status: "ready", fragments },
        }),
    });
  }
  if (path === "/api/analytics") {
    if (user.role === "guest")
      return demoError("Аналитика доступна учебным ролям сотрудников.", 403);
    const { query, flashAssist, useAi } = analyticsQuerySchema.parse(
      call.body()
    );
    const report = buildAnalyticsReport(query, cards, state.cardTypes);
    return Response.json({
      ...report,
      ...(useAi && {
        ai: {
          status: "local",
          originalQuery: query,
          message:
            "Демо-имитация ИИ. Сводка рассчитана в браузере по выбранным критериям.",
          citations: [],
          actions: [],
        },
      }),
      ...(flashAssist && {
        flashAssist: { status: "ready", suggestion: null },
      }),
    });
  }
  const { message } = chatInput.parse(call.body());
  const asSources = (selected: typeof cards) =>
    buildCanonSources(
      selected,
      Object.fromEntries(
        selected.map((card) => [card.id, demoCardVersionId(card)])
      )
    );
  const guide = findAssistantGuide(
    message,
    asSources(cards),
    cards
  );
  if (guide)
    return Response.json({
      status: "local",
      ...guide,
    } satisfies CanonChatAnswer);
  const matched = isCampusStatisticQuestion(message)
    ? []
    : searchKnowledgeCards(cards, assistantQuestion(message)).slice(0, 4);
  const selected = asSources(matched);
  const citations = selected.flatMap((source) => {
    const fact = source.facts.find(
      ({ field, text }) =>
        field === "referenceDescription" && text.length <= 1200
    );
    const reference =
      fact &&
      resolveCanonReference({ sourceId: source.id, factId: fact.id }, selected);
    return reference ? [reference] : [];
  });
  const actions = findCampusServices(message, false)
    .slice(0, 3)
    .map(({ title, href }) => ({ label: title, href }));
  if (!actions.length)
    actions.push({
      label: "Открыть поиск в справочнике",
      href: `/knowledge?q=${encodeURIComponent(message)}`,
    });
  const answer: CanonChatAnswer = {
    status: "local",
    citations,
    actions,
    message: citations.length
      ? "Демо-имитация ответа ИИ. В учебной базе найдены подходящие сведения."
      : "В учебных карточках по этому вопросу ничего не найдено. Попробуйте название вуза, проекта или лаборатории.",
  };
  return Response.json(answer);
};
