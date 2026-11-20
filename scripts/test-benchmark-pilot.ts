import assert from "node:assert/strict";
import { test } from "node:test";

import { runWithAiProvider } from "../lib/ai-providers";
import { buildAnalyticsReport } from "../lib/analytics";
import {
  assessBenchmarkOutput,
  BENCHMARK_SCENARIO_IDS,
  getBenchmarkMessages,
  getBenchmarkScenario,
  type BenchmarkResponse,
} from "../lib/benchmark";
import { checkFactText } from "../lib/fact-check";
import {
  buildDeterministicArticleDraft,
  groundGeneratedArticle,
  normalizeGeneratedArticle,
  isGroundedArticleText,
  selectUniversityMetricCards,
  serializeCardForPrompt,
} from "../lib/editor";
import {
  knowledgeSeedCards,
  universityPassportSeeds,
  type CardTypeDefinition,
  type CustomCard,
  type ProjectCard,
  type UniversityCard,
} from "../lib/knowledge";

const realProject = knowledgeSeedCards.find(
  (card): card is ProjectCard =>
    card.type === "project" && card.id === "joint-midis-susmu-trauma"
);
assert.ok(realProject);

const publishedPassport: UniversityCard = {
  ...universityPassportSeeds.find((card) => card.universityId === "midis")!,
  structuredMetrics: [
    {
      id: "test-actual",
      label: "Квота мест",
      value: 120,
      unit: "мест",
      year: 2026,
      kind: "actual",
      evidenceUrl: "https://example.org/quota/actual",
      owner: "Проверяющий",
      verifiedAt: "2026-11-20",
    },
    {
      id: "test-plan",
      label: "Квота мест",
      value: 180,
      unit: "мест",
      year: 2027,
      kind: "plan",
      evidenceUrl: "https://example.org/quota/plan",
      owner: "Проверяющий",
      verifiedAt: "2026-11-20",
    },
  ],
};
const pendingPassport: UniversityCard = {
  ...publishedPassport,
  status: "pending",
  approvedSnapshot: publishedPassport,
  structuredMetrics: [
    { ...publishedPassport.structuredMetrics[0], value: 999 },
  ],
};

test("Benchmark uses three reproducible public inputs and recognises scenario-specific outputs", () => {
  for (const id of BENCHMARK_SCENARIO_IDS) {
    assert.equal(getBenchmarkScenario(id).id, id);
    const messages = JSON.stringify(getBenchmarkMessages(id));
    assert.doesNotMatch(
      messages,
      /originalOwners|@|персональный email|ФИО владельца/iu
    );
    assert.deepEqual(getBenchmarkMessages(id), getBenchmarkMessages(id));
    assert.equal(assessBenchmarkOutput(id, "error: detail").output, null);
  }
  assert.equal(getBenchmarkScenario("fact-check").criteria.length, 6);
  const facts = assessBenchmarkOutput(
    "fact-check",
    JSON.stringify({
      findings: [
        {
          check: "placement",
          verdict: "red",
          source: "LAB",
          correction: "В публикации УНК планируется.",
        },
      ],
    })
  );
  assert.equal(facts.structure.filter((check) => check.passed).length, 2);
  const validArticle = assessBenchmarkOutput(
    "article",
    JSON.stringify({
      title: "Виртуальный травмпункт для студентов",
      lead: "МИДиС и ЮУГМУ вместе разрабатывают виртуальный травмпункт.",
      sections: [
        {
          heading: "Участники",
          body: "Сотрудничают два вуза.",
          sources: ["TRAUMA"],
        },
        {
          heading: "Практика",
          body: "Осмотр пациента в виртуальной среде.",
          sources: ["NEWS"],
        },
      ],
      sources: ["TRAUMA", "NEWS"],
    })
  );
  assert.ok(validArticle.structure.every((check) => check.passed));
  assert.match(validArticle.output ?? "", /\[NEWS\]/);
  const analytics = assessBenchmarkOutput(
    "analytics",
    JSON.stringify({
      total: 1,
      rows: [
        {
          source: "MEDAI",
          university: "ЮУГМУ",
          partner: "ООО «ЭВА ЛАБ»",
          status: "обсуждение и отбор идей",
        },
      ],
    })
  );
  assert.ok(analytics.structure.every((check) => check.passed));
});

test("Legacy editor requests for Alibaba return to local assembly without external traffic", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail("Unapproved editor text must never reach the network");
  };
  try {
    const result = await runWithAiProvider(
      [
        {
          role: "user",
          text: "Частный черновик и непредназначенные для публикации сведения",
        },
      ],
      "alibaba"
    );
    assert.equal(result.provider, "canonical");
    assert.equal(result.text, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Analytics uses published revisions, filters projects with partners, and links to the published card", () => {
  const project: ProjectCard = {
    ...realProject,
    id: "public-medical",
    sphere: "Медицина",
    industrialPartner: "ООО «ЭВА ЛАБ»",
    status: "approved",
  };
  const noPartner: ProjectCard = {
    ...project,
    id: "no-partner",
    industrialPartner: "не указан",
  };
  const pending: ProjectCard = {
    ...project,
    id: "pending-project",
    status: "pending",
  };
  const unrelated: ProjectCard = {
    ...project,
    id: "unrelated",
    sphere: "Металлургия",
  };
  const otherPartner: ProjectCard = {
    ...project,
    id: "other-partner",
    industrialPartner: "ООО «МедСервис»",
  };
  const cards = [project, noPartner, pending, unrelated, otherPartner];
  const report = buildAnalyticsReport(
    "Собери проекты с партнёром ООО «ЭВА ЛАБ» в сфере медицины",
    cards
  );
  assert.deepEqual(
    report.cards.map((card) => card.id),
    [project.id]
  );
  assert.equal(
    report.cards[0].sourceHref,
    "/knowledge?card=public-medical&version=approved"
  );
  assert.deepEqual(
    buildAnalyticsReport(
      "Собери проекты с индустриальными партнёрами в сфере медицины",
      cards
    ).cards.map((card) => card.id),
    [project.id, otherPartner.id]
  );
  const university = buildAnalyticsReport("Покажи паспорт вуза МИДиС", [
    pendingPassport,
  ]);
  assert.deepEqual(
    university.cards.map((card) => card.id),
    [publishedPassport.id]
  );
  assert.match(
    university.cards[0].figures.join("\n"),
    /120 мест \(2026, факт\)/
  );
  assert.doesNotMatch(university.cards[0].figures.join("\n"), /999/);

  const customType: CardTypeDefinition = {
    id: "custom-school",
    name: "Летняя школа",
    description: "",
    createdAt: "",
    updatedAt: "",
    fields: [],
  };
  const custom: CustomCard = {
    ...publishedPassport,
    id: "school",
    type: "custom",
    customTypeId: customType.id,
    customFields: {},
  };
  const customReport = buildAnalyticsReport(
    "Покажи карточки типа «Летняя школа»",
    [custom],
    [customType]
  );
  assert.equal(customReport.cards[0].cardTypeLabel, customType.name);
});

test("Editor cites a confirmed scoped metric and rejects contradictory or unsupported quantities", () => {
  const query = "Напиши статью о фактической квоте мест МИДиС за 2026 год";
  const selected = selectUniversityMetricCards(query, [pendingPassport]);
  assert.equal(selected?.[0].structuredMetrics[0].value, 120);
  assert.equal(selected?.[0].structuredMetrics.length, 1);
  assert.equal(
    selectUniversityMetricCards("Напиши о квоте мест МИДиС за 2030 год", [
      pendingPassport,
    ])?.[0].structuredMetrics.length,
    0
  );
  const serialized = serializeCardForPrompt(selected![0]);
  assert.match(serialized, /https:\/\/example\.org\/quota\/actual/);
  assert.doesNotMatch(serialized, /Проверяющий|999/);

  const article = buildDeterministicArticleDraft({
    query,
    selectedCards: selected!,
    matchedArticles: [],
    referenceChunks: [],
  });
  assert.equal(article.suggestedUniversityId, "midis");
  assert.match(
    article.lead,
    /2026 год \(факт\).*120 мест.*\[university-midis\]/
  );
  assert.deepEqual(article.sourceCardIds, [publishedPassport.id]);
  const check = checkFactText(article.lead, [pendingPassport]);
  assert.ok(
    check.findings.some(
      (finding) =>
        finding.level === "green" &&
        finding.sourceUrl === publishedPassport.structuredMetrics[0].evidenceUrl
    ),
    JSON.stringify(check.findings)
  );
  assert.ok(isGroundedArticleText(article.lead, selected!));
  const modelResponse = {
    title: "Квота МИДиС",
    lead: "МИДиС за 2026 год получил квоту в 120 мест. [university-midis]",
    sections: [
      {
        heading: "Официальная карточка",
        level: 2,
        chunks: ["Указана фактическая квота."],
      },
    ],
    sourceCardIds: [publishedPassport.id],
  };
  const context = { selectedCards: [publishedPassport], matchedArticles: [] };
  const correct = normalizeGeneratedArticle(modelResponse, context);
  assert.equal(groundGeneratedArticle(correct, [publishedPassport]), null);
  const bad = normalizeGeneratedArticle(
    {
      ...modelResponse,
      lead: `МИДиС за 2026 год получил квоту в 180 мест. [${publishedPassport.id}]`,
    },
    context
  );
  assert.match(
    groundGeneratedArticle(bad, [publishedPassport]) ?? "",
    /противоречие/
  );

  assert.equal(
    isGroundedArticleText(
      "МИДиС за 2026 год получил квоту в 999 мест.",
      selected!
    ),
    false
  );
  assert.equal(
    isGroundedArticleText(
      "В 2029 году расходы составили 7,5 млн ₽.",
      selected!
    ),
    false
  );
});

test(
  "Local HTTP pilot returns reference scenarios and rejects unapproved paid calls",
  { skip: !process.argv.includes("--http") },
  async () => {
    const base =
      process.env.CAMPUS_BENCHMARK_HTTP_ORIGIN ?? "http://localhost:8080";
    const post = (endpoint: string, body: unknown, headers?: HeadersInit) =>
      fetch(`${base}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const reference = await post("/api/benchmark", {
      scenario: "all",
      mode: "reference",
    });
    assert.equal(reference.status, 200);
    const benchmark = (await reference.json()) as BenchmarkResponse;
    assert.equal(benchmark.mode, "reference");
    assert.equal(benchmark.scenarios.length, 3);
    assert.doesNotMatch(
      JSON.stringify(benchmark),
      /originalOwners|anonymizedOwners|@/u
    );
    for (const scenario of benchmark.scenarios) {
      for (const platform of [scenario.yandex, scenario.alibaba]) {
        assert.equal(platform.mode, "skipped");
        assert.equal(platform.latencyMs, null);
        assert.equal(platform.usage, null);
      }
    }
    console.log(
      "Connected providers (configuration booleans only)",
      benchmark.livePlatforms
    );
    assert.equal(
      (await post("/api/benchmark", { scenario: "article", mode: "live" }))
        .status,
      401
    );
    assert.equal(
      (
        await post("/api/benchmark", {
          scenario: "article",
          query: "Never accept caller prompt text",
        })
      ).status,
      400
    );
    assert.equal(
      (
        await post(
          "/api/benchmark",
          { scenario: "article" },
          { Origin: "https://example.org" }
        )
      ).status,
      403
    );

    const analytics = await post("/api/analytics", {
      query: "Покажи паспорт вуза МИДиС",
    });
    assert.equal(analytics.status, 200);
    const report = await analytics.json();
    assert.equal(report.cards[0]?.id, "university-midis");
    const source = await fetch(new URL(report.cards[0].sourceHref, base));
    assert.equal(source.status, 200);
    assert.match(await source.text(), /Паспорт вуза: МИДиС/);

    const accountId = process.env.CAMPUS_BENCHMARK_HTTP_ACCOUNT;
    const accessKey = process.env.CAMPUS_BENCHMARK_HTTP_ACCESS_KEY;
    if (!accountId || !accessKey) return;

    const session = await post("/api/auth/session", {
      accountId,
      accessKey,
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal(
      (
        await post(
          "/api/benchmark",
          { scenario: "article", mode: "live" },
          { Cookie: cookie }
        )
      ).status,
      403
    );

    const missing = await post(
      "/api/editor/generate",
      {
        query: "Напиши статью о квоте мест МИДиС за 2100 год",
        provider: "canonical",
      },
      { Cookie: cookie }
    );
    assert.equal(missing.status, 200);
    assert.equal((await missing.json()).noData, true);
  }
);
