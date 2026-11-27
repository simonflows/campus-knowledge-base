import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locator, Page } from "playwright-core";
import { KnowledgeCardForm } from "../components/knowledge/knowledge-card-form";
import { KnowledgeModerationPanel } from "../components/knowledge/knowledge-moderation-panel";
import { KnowledgeTypeConstructor } from "../components/knowledge/knowledge-type-constructor";
import {
  indicatorDraft,
  indicatorPayload,
  indicatorDraftError,
} from "../components/knowledge/strategy-editors";
import { StrategyCardView } from "../components/knowledge/strategy-views";
import { demoAccounts } from "../lib/auth";
import {
  folderIds,
  type CustomCard,
  type KnowledgeCard,
} from "../lib/knowledge";
import {
  managedStrategyTypes,
  OFFICIAL_DOCUMENT_TYPE_ID,
  ROADMAP_INDICATOR_TYPE_ID,
  roadmapIndicatorDataSchema,
  type StrategyOptions,
} from "../lib/strategy";

const types = managedStrategyTypes().map((type) => ({ ...type, cardCount: 0 }));
const coordinator = demoAccounts.find(({ role }) => role === "admin")!;
const now = "2026-11-27T08:00:00.000Z";
const evidence = {
  document: { cardId: "fixture-document", versionId: `cv-${"a".repeat(64)}` },
  clauseId: "fixture-fact",
};
const indicator: CustomCard = {
  id: "fixture-indicator",
  type: "custom",
  customTypeId: ROADMAP_INDICATOR_TYPE_ID,
  folderId: folderIds.customType(ROADMAP_INDICATOR_TYPE_ID),
  title: "Тестовый показатель",
  owners: ["Тестовый ответственный"],
  customFields: {},
  referenceDescription: "",
  stopFormula: "",
  createdAt: now,
  updatedAt: now,
  status: "pending",
  roadmapIndicator: {
    definition: "Тестовое определение",
    unit: "шт.",
    scope: { kind: "campus" },
    relatedCardIds: [],
    actual: { value: 0, date: "2026-11-25", evidence },
  },
};

if (process.argv[1]?.endsWith("test-strategy-ui-120.ts")) {
  test("встроенный документ открывает форму метаданных из своей папки", () => {
    const html = renderToStaticMarkup(
      createElement(KnowledgeCardForm, {
        cards: [],
        customTypes: types,
        dbAvailable: true,
        currentUser: coordinator,
        defaultFolderId: folderIds.customType(OFFICIAL_DOCUMENT_TYPE_ID),
        onCreated() {},
        onCancel() {},
      })
    );
    assert.match(html, /Организация-источник/);
    assert.match(html, /Редакция документа/);
    assert.match(html, /Проверенные выдержки/);
    assert.doesNotMatch(html, /Поля типа «Официальный документ»/);
  });

  test("встроенные типы видны в конструкторе без изменения и удаления", () => {
    const html = renderToStaticMarkup(
      createElement(KnowledgeTypeConstructor, {
        customTypes: types,
        dbAvailable: true,
        onCreated() {},
        onUpdated() {},
        onDeleted() {},
        onClose() {},
      })
    );
    assert.match(html, /Официальный документ/);
    assert.match(html, /Встроенный тип/);
    assert.doesNotMatch(html, /aria-label="Изменить тип Официальный документ"/);
    assert.doesNotMatch(html, /aria-label="Удалить тип Показатель"/);
  });

  test("координатор подтверждает нулевой факт независимо от отсутствующего плана", () => {
    const render = (card: CustomCard) =>
      renderToStaticMarkup(
        createElement(KnowledgeModerationPanel, {
          cards: [card],
          onCardUpdated() {},
          onOpenCard() {},
        })
      );
    const pending = render(indicator);
    assert.match(pending, /Откройте карточку/);
    assert.doesNotMatch(pending, /Подтвердить факт/);
    assert.doesNotMatch(pending, /Подтвердить план/);
    const approvalDisabled = (html: string) =>
      html
        .split("</button>")
        .some(
          (button) =>
            /<button[^>]*disabled=""[^>]*>/.test(button) &&
            button.endsWith("Одобрить")
        );
    assert.equal(approvalDisabled(pending), true);

    const confirmed = render({
      ...indicator,
      confirmedIndicatorSlots: ["actual"],
    });
    assert.doesNotMatch(confirmed, /Откройте карточку/);
    assert.doesNotMatch(confirmed, /Подтвердить факт/);
    assert.equal(approvalDisabled(confirmed), false);
  });

  test("число 0 сохраняется в форме и выводится в ожидающей подтверждения редакции", () => {
    const draft = indicatorDraft(indicator.roadmapIndicator);
    assert.equal(draft.plan.value, "");
    assert.equal(draft.actual.value, "0");
    const parsed = roadmapIndicatorDataSchema.parse(indicatorPayload(draft));
    assert.equal(parsed.plan, undefined);
    assert.equal(parsed.actual?.value, 0);

    const html = renderToStaticMarkup(
      createElement(StrategyCardView, { card: indicator })
    );
    assert.match(html, /Нет подтверждённых данных/);
    assert.match(html, /0 шт\./);
    assert.match(html, /На подтверждении/);
  });

  test("partial measurements require explicit completion or clear and exponent values round-trip", () => {
    const draft = indicatorDraft(indicator.roadmapIndicator);
    draft.actual.value = "";
    assert.match(
      indicatorDraftError(draft) ?? "",
      /введите значение или очистите/
    );
    assert.equal(
      roadmapIndicatorDataSchema.safeParse(indicatorPayload(draft)).success,
      false
    );
    draft.actual.value = "1e-7";
    assert.equal(indicatorPayload(draft).actual?.value, 1e-7);
    draft.actual.value = "1e-999";
    assert.equal(
      roadmapIndicatorDataSchema.safeParse(indicatorPayload(draft)).success,
      false
    );
  });
}

export async function runStrategyUi(page: Page, base: string) {
  const { requireFixtureServer } = await import("./qa-fixture");
  assert.equal(
    base,
    "http://127.0.0.2:8080",
    "Ввод разрешён только на изолированном сервере QA"
  );
  assert.equal(await requireFixtureServer(), base);

  const suffix = randomUUID().slice(0, 8);
  const documentTitle = `Документ QA ${suffix}`;
  const projectTitle = `Проект QA ${suffix}`;
  const indicatorTitle = `Показатель QA ${suffix}`;
  const editor = page.locator(".data-index-editor form");
  const responsePath = "/api/knowledge/cards";

  async function startCard(folder: string, title: string, managed: boolean) {
    await page.goto(`${base}/knowledge?${new URLSearchParams({ folder })}`);
    await page
      .getByRole("button", { name: "Добавить карточку", exact: true })
      .first()
      .click();
    await editor.getByLabel("Название", { exact: true }).fill(title);
    await editor
      .getByLabel(managed ? "Ответственные" : "Владельцы карточки", {
        exact: true,
      })
      .fill("Ответственный QA");
  }

  async function openDisclosure(container: Page | Locator, title: string) {
    const summary = container
      .locator("summary")
      .filter({ has: page.getByText(title, { exact: true }) })
      .first();
    await summary.press("Enter");
    assert.equal(
      await summary.evaluate(
        (element) => (element.parentElement as HTMLDetailsElement).open
      ),
      true
    );
  }

  async function writeCard(
    button: Locator,
    path = responsePath
  ): Promise<KnowledgeCard> {
    const [response] = await Promise.all([
      page.waitForResponse(
        (request) =>
          new URL(request.url()).pathname === path &&
          request.request().method() === "POST"
      ),
      button.click(),
    ]);
    const data = await response.json();
    assert.ok(
      response.ok(),
      `${path}: ${response.status()} ${data.error ?? ""}`
    );
    return data as KnowledgeCard;
  }

  async function chooseDocument(container: Locator, label: string) {
    const select = container.getByLabel(label, { exact: true });
    await select
      .getByRole("option", { name: `${documentTitle} · QA 1` })
      .waitFor({ state: "attached" });
    await select.selectOption({ label: `${documentTitle} · QA 1` });
  }

  async function noOverflow() {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => window.document.documentElement.scrollWidth <= innerWidth + 1
        ),
        true,
        `Переполнение на ширине ${width}`
      );
    }
  }

  await startCard(
    folderIds.customType(OFFICIAL_DOCUMENT_TYPE_ID),
    documentTitle,
    true
  );
  await editor
    .getByLabel("Вид документа", { exact: true })
    .selectOption("roadmap");
  await editor
    .getByLabel("Организация-источник", { exact: true })
    .fill("Организация QA");
  await editor
    .getByLabel("Ссылка на официальный документ", { exact: true })
    .fill("https://example.org/canon-qa");
  await editor.getByLabel("Дата документа", { exact: true }).fill("2026-11-25");
  await editor.getByLabel("Редакция документа", { exact: true }).fill("QA 1");
  await openDisclosure(editor, "Направления документа");
  await editor.getByRole("button", { name: "Добавить направление" }).click();
  await editor
    .getByLabel("Название направления", { exact: true })
    .fill("Направление QA");
  await openDisclosure(editor, "Проверенные выдержки");
  for (const [index, item] of [
    {
      kind: "plan",
      locator: "Пункт QA 1",
      text: "Плановое количество в контуре кампуса к 1 августа 2027 года составляет 6 шт.",
    },
    {
      kind: "actual",
      locator: "Пункт QA 2",
      text: "Подтверждённое количество в контуре кампуса на 25 ноября 2026 года составляет 0 шт.",
    },
  ].entries()) {
    await editor.getByRole("button", { name: "Добавить выдержку" }).click();
    const clause = editor.getByRole("group", {
      name: `Выдержка ${index + 1}`,
      exact: true,
    });
    await clause
      .getByLabel("Пункт или страница", { exact: true })
      .fill(item.locator);
    await clause
      .getByLabel("Что подтверждает выдержка", { exact: true })
      .selectOption(item.kind);
    await clause.getByLabel("Текст выдержки", { exact: true }).fill(item.text);
    await clause.getByRole("checkbox", { name: "Направление QA" }).check();
  }
  await noOverflow();
  const document = await writeCard(
    editor.getByRole("button", {
      name: "Отправить на подтверждение",
      exact: true,
    })
  );
  assert.equal(document.status, "pending");
  const approve = page.getByRole("button", { name: "Одобрить", exact: true });
  assert.equal(
    (await writeCard(approve, `${responsePath}/${document.id}/moderation`))
      .status,
    "approved"
  );

  await startCard(folderIds.subfolder("susu", "products"), projectTitle, false);
  await editor
    .getByLabel("Сфера / отрасль", { exact: true })
    .fill("Исследования QA");
  await editor
    .getByLabel("Индустриальный партнёр", { exact: true })
    .fill("Партнёр QA");
  await editor
    .getByLabel("Стадия готовности", { exact: true })
    .selectOption("Идея");
  await editor.getByLabel("Контур", { exact: true }).selectOption("кампус");
  await editor
    .getByLabel("Эталонное описание", { exact: true })
    .fill("Проект для изолированной проверки связей.");
  await editor
    .getByLabel("Ограничения для ИИ (стоп-формула)", { exact: true })
    .fill("Пример применяется только при тестировании.");
  await openDisclosure(editor, "Связь со стратегией и дорожной картой");
  await editor
    .getByRole("button", { name: "Добавить связь", exact: true })
    .click();
  await chooseDocument(editor, "Документ стратегии или дорожной карты");
  await editor
    .getByLabel("Направление", { exact: true })
    .selectOption({ label: "Направление QA" });
  await editor
    .getByLabel("Пункт документа", { exact: true })
    .selectOption({ label: "Пункт QA 1" });
  await chooseDocument(editor, "Подтверждающий документ");
  await editor
    .getByLabel("Подтверждающая выдержка", { exact: true })
    .selectOption({ label: "Пункт QA 1" });
  await editor
    .getByLabel("Как карточка связана с документом", { exact: true })
    .fill("Связь с тестовым направлением по пункту QA 1.");
  const project = await writeCard(
    editor.getByRole("button", { name: "Сохранить карточку", exact: true })
  );
  assert.equal(project.status, "pending");
  assert.equal(project.strategyLinks?.[0].document.cardId, document.id);
  assert.equal(
    (await writeCard(approve, `${responsePath}/${project.id}/moderation`))
      .status,
    "approved"
  );

  await startCard(
    folderIds.customType(ROADMAP_INDICATOR_TYPE_ID),
    indicatorTitle,
    true
  );
  await editor
    .getByLabel("Определение показателя", { exact: true })
    .fill("Тестовое количество объектов в контуре кампуса.");
  await editor.getByLabel("Единица измерения", { exact: true }).fill("шт.");
  for (const item of [
    {
      title: "План",
      value: "6",
      valueLabel: "Плановое значение",
      date: "2027-08-01",
      dateLabel: "Плановый срок",
      locator: "Пункт QA 1",
    },
    {
      title: "Факт",
      value: "0",
      valueLabel: "Фактическое значение",
      date: "2026-11-25",
      dateLabel: "Дата актуальности факта",
      locator: "Пункт QA 2",
    },
  ]) {
    await openDisclosure(editor, item.title);
    const slot = editor.locator("details").filter({
      has: page.locator("summary").getByText(item.title, { exact: true }),
    });
    await slot.getByLabel(item.valueLabel, { exact: true }).fill(item.value);
    await slot.getByLabel(item.dateLabel, { exact: true }).fill(item.date);
    await chooseDocument(slot, "Подтверждающий документ");
    const clauses = slot.getByLabel("Подтверждающая выдержка", { exact: true });
    assert.equal(
      await clauses.getByRole("option").count(),
      2,
      "Доступен только подходящий вид выдержки"
    );
    await clauses.selectOption({ label: item.locator });
  }
  await openDisclosure(editor, "Связанные проекты и объекты");
  await editor
    .getByLabel("Добавить проект или объект", { exact: true })
    .selectOption({ label: projectTitle });
  await noOverflow();
  const measured = await writeCard(
    editor.getByRole("button", {
      name: "Отправить на подтверждение",
      exact: true,
    })
  );
  assert.equal(measured.status, "pending");
  assert.equal(
    measured.type === "custom" && measured.roadmapIndicator?.actual?.value,
    0
  );
  assert.equal(
    measured.type === "custom" && measured.indicatorConfirmations,
    undefined
  );
  const confirmation = page.getByRole("group", {
    name: "Подтверждение показателя",
  });
  const measurementModeration = `${responsePath}/${measured.id}/moderation`;
  assert.equal(await approve.isDisabled(), true);
  const planConfirmed = await writeCard(
    confirmation.getByRole("button", { name: "Подтвердить план" }),
    measurementModeration
  );
  assert.deepEqual(
    planConfirmed.type === "custom" && planConfirmed.confirmedIndicatorSlots,
    ["plan"]
  );
  assert.equal(await approve.isDisabled(), true);
  const actualConfirmed = await writeCard(
    confirmation.getByRole("button", { name: "Подтвердить факт" }),
    measurementModeration
  );
  assert.deepEqual(
    actualConfirmed.type === "custom" &&
      actualConfirmed.confirmedIndicatorSlots,
    ["plan", "actual"]
  );
  assert.equal(
    (await writeCard(approve, measurementModeration)).status,
    "approved"
  );
  await page.goto(
    `${base}/knowledge?${new URLSearchParams({ card: measured.id })}`
  );
  const indicatorView = page.getByRole("region", { name: "Данные показателя" });
  const actualView = indicatorView.getByRole("region", {
    name: "Факт",
    exact: true,
  });
  await actualView.getByText("0 шт.", { exact: true }).waitFor();
  assert.match(
    (await actualView
      .getByRole("link", { name: `${documentTitle} · Пункт QA 2` })
      .getAttribute("href")) ?? "",
    /version=cv-[0-9a-f]{64}$/
  );

  const optionsPath = "**/api/strategy/options";
  await page.route(optionsPath, async (route) => {
    const response = await route.fetch();
    const options = (await response.json()) as StrategyOptions;
    await route.fulfill({
      response,
      json: {
        ...options,
        documents: options.documents.map((option) =>
          option.cardId === document.id
            ? { ...option, versionId: `cv-${"e".repeat(64)}` }
            : option
        ),
      },
    });
  });
  try {
    await page.reload();
    await actualView
      .getByText("Источник обновлён. Нужно повторно сверить сведения.")
      .waitFor();
    await actualView.getByText("Нет подтверждённых данных").waitFor();
    assert.equal(
      await actualView.getByText("0 шт.", { exact: true }).count(),
      0
    );
  } finally {
    await page.unroute(optionsPath);
  }
  return {
    documentId: document.id,
    projectId: project.id,
    indicatorId: measured.id,
  };
}
