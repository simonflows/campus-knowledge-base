import assert from "node:assert/strict";
import { test } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDemoAccount, toSessionUser } from "../lib/auth";
import { docClient, resetDbAvailableCache } from "../lib/db";
import {
  groundGeneratedArticle,
  isGroundedArticleText,
  normalizeGeneratedArticle,
  selectRelevantCards,
} from "../lib/editor";
import candidates from "../data/pilot-0.9.5-candidates.json";
import verification from "../data/pilot-0.9.5-verification.json";
import { assistEditorial } from "../lib/editor-assist";
import {
  editorialContentSchema,
  type EditorialDocument,
  type EditorialRevision,
} from "../lib/editorial";
import {
  knowledgeSeedCards,
  type KnowledgeCard,
  type ProjectCard,
  type UniversityCard,
} from "../lib/knowledge";
import {
  describeApprovedCardVersion,
  getCardVersionId,
} from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";
import { checkEditorialEvidence } from "../lib/editorial-evidence";

const midis = knowledgeSeedCards.find(
  (card): card is UniversityCard => card.id === "university-midis"
)!;
const susu = knowledgeSeedCards.find(
  (card): card is UniversityCard => card.id === "university-susu"
)!;
const passport = {
  ...midis,
  structuredMetrics: [
    {
      id: "midis-actual-quota",
      label: "Квота мест",
      value: 120,
      unit: "мест",
      year: 2026,
      kind: "actual",
      evidenceUrl: "https://example.org/actual",
      verifiedAt: "2026-10-01T00:00:00.000Z",
      owner: "Проверяющий",
    },
    {
      id: "midis-planned-quota",
      label: "Квота мест",
      value: 180,
      unit: "мест",
      year: 2027,
      kind: "plan",
      evidenceUrl: "https://example.org/plan",
      verifiedAt: "2026-10-01T00:00:00.000Z",
      owner: "Проверяющий",
    },
  ],
} satisfies UniversityCard;

test("a complete canonical paragraph keeps its scope and cannot vouch for a detached sentence", () => {
  const source = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const card: KnowledgeCard = { ...source, status: "approved", referenceDescription: "Гипотетический учебный сценарий. Робот KUKA лечит пациентов." };
  assert.equal(checkEditorialEvidence("Робот KUKA лечит пациентов.", [card]).canPublish, false);
  const faithful = checkEditorialEvidence(card.referenceDescription, [card]);
  assert.equal(faithful.canPublish, true);
  const repeated = checkEditorialEvidence(card.referenceDescription + "\nРобот KUKA лечит пациентов.", [card]);
  assert.equal(repeated.canPublish, false);
});

test("a faithful multiline canonical unit stays verified without confirming a detached duplicate", () => {
  const source = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const card: KnowledgeCard = { ...source, status: "approved", referenceDescription: "Публикация лаборатории описывает учебную песочницу.\n\nОтдельный раздел посвящён стендовому экспонату." };
  assert.equal(checkEditorialEvidence(card.referenceDescription, [card]).canPublish, true);
  assert.equal(checkEditorialEvidence(card.referenceDescription + ` [${card.id}]`, [card]).canPublish, true);
  assert.equal(checkEditorialEvidence(card.referenceDescription + "\nОтдельный раздел посвящён стендовому экспонату.", [card]).canPublish, false);
});

test("source selection keeps every subject restriction and accepts equipment transliteration", () => {
  const approved = new Set(verification.approvedIds);
  const cards = candidates.cards
    .filter(({ card }) => approved.has(card.id))
    .map(({ card }) => ({ ...card, status: "approved" })) as KnowledgeCard[];
  assert.equal(cards.length, 16);
  for (const query of [
    "Робот KUKA",
    "робот кука",
    "Подготовь материал о центре промышленного дизайна МИДиС",
    "Напиши короткую статью о роботе KUKA",
  ]) {
    assert.equal(
      selectRelevantCards(cards, query)[0]?.card.id,
      "lab-midis-kuka",
      query
    );
  }
  for (const query of [
    "Робот KUKA компании FANUC",
    "Статья про робота KUKA на Луне",
    "Подготовь статью о роботе KUKA в МГТУ",
    "В МИДиС нет робота KUKA",
  ]) {
    assert.deepEqual(selectRelevantCards(cards, query), [], query);
  }
  assert.equal(
    selectRelevantCards(
      knowledgeSeedCards,
      "Напиши статью о сотрудничестве МИДиС и ЮУГМУ по виртуальному травмпункту с опорой на уже вышедший материал ЮУГМУ"
    )[0]?.card.id,
    "joint-midis-susmu-trauma"
  );
});

test("structured metric paraphrases preserve the cited university, year, kind and unit", () => {
  const valid = "МИДиС за 2026 год получил квоту в 120 мест.";
  assert.ok(
    isGroundedArticleText(valid + " [" + midis.id + "]", [passport, susu])
  );
  for (const text of [
    valid + " [" + susu.id + "]",
    "МИДиС за 2026 год получил квоту в 180 мест. [" + midis.id + "]",
    "МИДиС планирует 120 мест в 2026 году. [" + midis.id + "]",
    "МИДиС за 120 год получил квоту в 2026 мест. [" + midis.id + "]",
    valid.replace("квоту в", "стипендии для") + " [" + midis.id + "]",
    valid + " [unknown-card]",
  ]) {
    assert.equal(isGroundedArticleText(text, [passport, susu]), false, text);
  }
});

test("one supported title cannot vouch for a fabricated fact or a transferred metric", () => {
  const card = knowledgeSeedCards.find(
    (candidate): candidate is ProjectCard =>
      candidate.id === "project-susu-digital-twin"
  )!;
  const other = knowledgeSeedCards.find(
    (candidate): candidate is ProjectCard =>
      candidate.id === "project-mgtu-metal-quality"
  )!;
  const ctx = { selectedCards: [card, other], matchedArticles: [] };
  const title = "Проект «" + card.title + "»";
  const makeDraft = (lead: string) =>
    normalizeGeneratedArticle(
      {
        title,
        lead,
        sections: [
          {
            heading: "Официальные данные",
            level: 2,
            chunks: [card.referenceDescription],
          },
        ],
        sourceCardIds: [card.id, other.id],
      },
      ctx
    );
  assert.equal(
    groundGeneratedArticle(
      makeDraft(card.referenceDescription),
      ctx.selectedCards
    ),
    null
  );
  for (const lead of [
    title + ". Экспедиция получила международную награду.",
    title + ". Система снизила брак на 7%. [" + other.id + "]",
    title + " принёс 18 млн рублей выручки. [" + card.id + "]",
  ]) {
    assert.ok(groundGeneratedArticle(makeDraft(lead), ctx.selectedCards), lead);
  }
});

test("live editor help uses the approved version and reports a stale pin without changing it", async (context) => {
  const environment = {
    USE_DATABASE: "true",
    DOCUMENT_API_ENDPOINT: "https://fixture.invalid",
    OUTPUT_MODE: "fixture",
    CAMPUS_LOCAL_DEMO: "false",
    YANDEX_AI_STUDIO_API_KEY: "synthetic",
    YANDEX_AI_STUDIO_FOLDER_ID: "synthetic",
    YANDEX_AI_STUDIO_MODEL_URI: "gpt://synthetic/aliceai-llm-flash",
  };
  const oldEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  resetDbAvailableCache();
  context.after(() => {
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDbAvailableCache();
  });
  const current = {
    ...passport,
    referenceDescription: "Данные актуального паспорта МИДиС прошли проверку.",
  };
  const oldVersion = describeApprovedCardVersion(passport, {
    recordedAt: passport.updatedAt,
    legacyBaseline: true,
  });
  const author = toSessionUser(getDemoAccount("demo-admin")!);
  const content = editorialContentSchema.parse({
    title: passport.title,
    lead: passport.referenceDescription,
    universityId: "midis",
    sourceCardIds: [passport.id],
    sourceCardTitles: [passport.title],
    sourceVersions: [{ cardId: passport.id, versionId: oldVersion.id }],
    sections: [
      {
        id: "section",
        heading: "Сведения",
        level: 2,
        chunks: [{ id: "chunk", content: passport.referenceDescription }],
      },
    ],
  });
  const document: EditorialDocument = {
    id: "qa-draft",
    originalId: "qa-draft",
    channel: "Оригинал",
    version: 1,
    revisionId: "qa-revision",
    submittedRevisionId: null,
    approvedRevisionId: null,
    status: "draft",
    ownerId: author.id,
    ownerName: author.name,
    content,
    events: [],
    createdAt: passport.createdAt,
    updatedAt: passport.updatedAt,
  };
  const revision: EditorialRevision = {
    id: document.revisionId,
    documentId: document.id,
    number: 1,
    content,
    actorId: author.id,
    actorName: author.name,
    createdAt: document.createdAt,
  };
  const rows = new Map<string, unknown>([
    [TableName.KNOWLEDGE_CARDS, current],
    [TableName.KNOWLEDGE_CARD_VERSIONS, oldVersion],
    [TableName.EDITORIAL_DOCUMENTS, document],
    [TableName.EDITORIAL_REVISIONS, revision],
  ]);
  const db = context.mock.method(
    docClient,
    "send",
    async (command: unknown) => {
      if (command instanceof ListTablesCommand) return {};
      assert.ok(command instanceof GetCommand, "Help only reads records");
      return { Item: rows.get(command.input.TableName ?? "") };
    }
  );
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    async (_url: string, request: RequestInit) => {
      const input = JSON.parse(String(request.body)).messages[1].content;
      assert.match(input, /Данные актуального паспорта/);
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                title: current.title,
                lead: current.referenceDescription,
                body: current.referenceDescription,
              }),
            },
          },
        ],
      });
    }
  );
  const output = await assistEditorial(
    author,
    {
      documentId: document.id,
      revisionId: document.revisionId,
      version: document.version,
      action: "variant",
      channel: "Сайт",
    },
    new Request("http://localhost:8080")
  );
  assert.equal(output.status, "ready");
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(Reflect.get(output, "staleSources"), [
    {
      cardId: current.id,
      versionId: getCardVersionId(current),
      title: current.title,
    },
  ]);
  assert.deepEqual(content.sourceVersions, [
    { cardId: passport.id, versionId: oldVersion.id },
  ]);
  assert.equal(
    db.mock.calls.some(
      ({ arguments: [command] }) =>
        command instanceof GetCommand &&
        command.input.TableName === TableName.KNOWLEDGE_CARD_VERSIONS
    ),
    false
  );
});
