import { z } from "zod";

import { sanitizeTextForDisplay } from "./benchmark-response-text";
import type { YandexAiMessage } from "./yandex-ai";

export const BENCHMARK_FIXTURE_VERSION = "campus-public-2026-11-v1";

export const BENCHMARK_SCENARIO_IDS = [
  "fact-check",
  "article",
  "analytics",
] as const;
export type BenchmarkScenarioId = (typeof BENCHMARK_SCENARIO_IDS)[number];

export type BenchmarkProviderResult = {
  mode: "live" | "skipped" | "error";
  model: string | null;
  latencyMs: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  structure: { label: string; passed: boolean }[];
  output: string | null;
  message: string | null;
};

export type BenchmarkResponse = {
  executedAt: string;
  fixtureVersion: string;
  mode: "reference" | "live";
  livePlatforms: { yandex: boolean; alibaba: boolean };
  scenarios: Array<{
    id: BenchmarkScenarioId;
    title: string;
    input: string;
    criteria: string[];
    reference: string;
    yandex: BenchmarkProviderResult;
    alibaba: BenchmarkProviderResult;
  }>;
};

const CAMPUS =
  "CAMPUS: Челябинск. Межуниверситетский кампус мирового уровня «Южный Урал». Площадь всех объектов в сводке концессионера — 123 тыс. м².";
const LAB =
  "LAB: Учебно-научный комплекс кампуса — третья очередь. В сообщении ЧелГУ об открытии второй очереди лаборатории УНК описаны как планируемые.";
const TRAUMA =
  "TRAUMA: Виртуальный травмпункт. Разработчики — Международный институт дизайна и сервиса (МИДиС) и Южно-Уральский государственный медицинский университет (ЮУГМУ). Направление — медицина и VR. Контур — сотрудничество вузов-резидентов «Южного Урала». Статус в сообщении ЮУГМУ — разработка. Компания-партнёр и число обученных не названы.";
const ARTICLE_CHUNK =
  "NEWS: Открытая публикация ЮУГМУ от 2023 года. Идея тренажёра — дать студентам и ординаторам отработать осмотр пациента на виртуальном травматологическом приёме с помощью трёхмерной графики.";
const PROJECTS = [
  TRAUMA,
  "MEDAI: Проектная работа ЮУГМУ над медицинскими продуктами с ИИ. Направление — медицина. Вуз — ЮУГМУ. Технологический партнёр — ООО «ЭВА ЛАБ». Этап на дату публикации — обсуждение и отбор идей.",
  "DESIGN: Центр промышленного дизайна. Направление — промышленный дизайн и интернет вещей. Вуз — МИДиС. Партнёр на этапе объявления — ГК inSmart.",
  LAB,
];

const factChecks = [
  {
    check: "campus",
    verdict: "red",
    source: "CAMPUS",
    label: "Общие параметры",
    correction: "В учебной сводке концессионера 123 тыс. м².",
  },
  {
    check: "placement",
    verdict: "red",
    source: "LAB",
    label: "Статус УНК",
    correction: "Лаборатории УНК в исходной публикации планируются.",
  },
  {
    check: "authorship",
    verdict: "red",
    source: "TRAUMA",
    label: "Авторство",
    correction: "Указать МИДиС и ЮУГМУ.",
  },
  {
    check: "contour",
    verdict: "red",
    source: "TRAUMA",
    label: "Контур",
    correction: "Указать сотрудничество вузов-резидентов «Южного Урала».",
  },
  {
    check: "official-name",
    verdict: "red",
    source: "TRAUMA",
    label: "Официальное название",
    correction: "Международный институт дизайна и сервиса.",
  },
  {
    check: "unconfirmed-number",
    verdict: "yellow",
    source: "TRAUMA",
    label: "Неподтверждённая цифра",
    correction: "Число обученных не подтверждено.",
  },
] as const;

const scenarios = {
  "fact-check": {
    title: "Фактчекинг редакционного черновика",
    input:
      "Общая площадь объектов кампуса «Южный Урал» составляет 110 тыс. м². В новом УНК уже работают лаборатории. Международный университет дизайна и сервиса единолично разработал «Виртуальный травмпункт» в рамках ПИШ. Тренажёр уже прошли 5000 врачей.",
    instruction:
      'Проверь шесть тезисов. Верни JSON {"findings":[{"check":"campus|placement|authorship|contour|official-name|unconfirmed-number","verdict":"red|yellow|green","source":"ID","correction":"исправление"}]}. red — противоречие карточке, yellow — сведений не хватает, green — подтверждено. Для каждого тезиса укажи ровно одну запись.',
    context: [CAMPUS, LAB, TRAUMA],
    criteria: factChecks.map(({ label }) => label),
    reference: factChecks
      .map(
        ({ label, verdict, source, correction }) =>
          `${label} [${verdict === "red" ? "красный" : "жёлтый"}] · [${source}] ${correction}`
      )
      .join("\n"),
  },
  article: {
    title: "Статья о виртуальном травмпункте",
    input:
      "Подготовь для сайта вуза статью о сотрудничестве МИДиС и ЮУГМУ по виртуальному травмпункту. Используй смысловой блок из опубликованного материала ЮУГМУ.",
    instruction:
      'Верни JSON {"title":"H1","lead":"первый смысловой блок до 1000 знаков","sections":[{"heading":"H2/H3","body":"самостоятельный смысловой блок","sources":["ID"]}],"sources":["ID"]}. В лиде назови проект, оба вуза и пользу для аудитории. Нужно не менее двух автономных блоков с заголовками и ссылками на карточки. Не придумывай показатели, партнёров, статус внедрения или прямую речь.',
    context: [TRAUMA, ARTICLE_CHUNK],
    criteria: [
      "H1, лид до 1000 знаков и ≥2 смысловых блока",
      "Название проекта и оба вуза в лиде",
      "Известные ID в блоках, включая готовый материал",
      "Проверка фактов, читаемости и самостоятельности блоков — редактором",
    ],
    reference:
      "Виртуальный травмпункт: как МИДиС и ЮУГМУ разрабатывают тренажёр для студентов\n\nЛид. МИДиС и ЮУГМУ разрабатывают «Виртуальный травмпункт», чтобы будущие медики могли отработать осмотр пациента в виртуальной среде. [TRAUMA, NEWS]\n\nH2. Совместная разработка двух вузов\nВ работе над тренажёром участвуют Международный институт дизайна и сервиса и Южно-Уральский государственный медицинский университет. [TRAUMA]\n\nH2. Что отрабатывают на виртуальном приёме\nПо замыслу команды студенты и ординаторы смогут отрабатывать осмотр пациента, используя трёхмерную графику. [NEWS]",
  },
  analytics: {
    title: "Сводка по медицине и индустриальным партнёрам",
    input:
      "Собери проекты вузов с указанными технологическими или индустриальными партнёрами в сфере медицины. Для каждого назови вуз, партнёра и статус из карточки.",
    instruction:
      'Верни JSON {"total":число,"rows":[{"source":"ID","university":"вуз","partner":"компания","status":"этап из карточки"}]}. Включай только проекты с явным партнёром в медицине. Считай итог по отобранным строкам.',
    context: PROJECTS,
    criteria: [
      "Точное число проектов",
      "Выбран медпроект с партнёром и отсечены остальные карточки",
      "Вуз, партнёр и статус соответствуют MEDAI",
    ],
    reference:
      "1 проект · [MEDAI]\nЮУГМУ · ООО «ЭВА ЛАБ» · обсуждение и отбор идей по медицинским продуктам с ИИ.\n\nТренажёр исключён из-за отсутствия указанного партнёра, центр дизайна — по отрасли, УНК — по типу карточки.",
  },
} satisfies Record<
  BenchmarkScenarioId,
  {
    title: string;
    input: string;
    instruction: string;
    context: string[];
    criteria: string[];
    reference: string;
  }
>;

export function getBenchmarkScenario(id: BenchmarkScenarioId) {
  const scenario = scenarios[id];
  return {
    id,
    title: scenario.title,
    input: scenario.input,
    criteria: scenario.criteria,
    reference: scenario.reference,
  };
}

export function getBenchmarkMessages(
  id: BenchmarkScenarioId
): YandexAiMessage[] {
  const scenario = scenarios[id];
  return [
    {
      role: "system",
      text: "Используй только данные учебных карточек ниже. Внешние сведения и имена людей не добавляй. Ссылки указывай ID карточек. Ответь одним JSON без Markdown.",
    },
    {
      role: "user",
      text: `${scenario.input}\n\n${scenario.instruction}\n\nКарточки:\n${scenario.context.join("\n")}`,
    },
  ];
}

const shortText = z.string().trim().min(1).max(2500);
const sourceIds = z
  .array(z.enum(["CAMPUS", "LAB", "TRAUMA", "NEWS", "MEDAI", "DESIGN"]))
  .max(6);
const factFormat = z.object({
  findings: z
    .array(
      z.object({
        check: z.string().max(32),
        verdict: z.enum(["red", "yellow", "green"]),
        source: z.string().max(20),
        correction: shortText,
      })
    )
    .max(16),
});
const articleFormat = z.object({
  title: shortText,
  lead: shortText,
  sections: z
    .array(
      z.object({ heading: shortText, body: shortText, sources: sourceIds })
    )
    .max(8),
  sources: sourceIds,
});
const analyticsFormat = z.object({
  total: z.number().int().nonnegative(),
  rows: z
    .array(
      z.object({
        source: z.string().max(20),
        university: shortText,
        partner: shortText,
        status: shortText,
      })
    )
    .max(12),
});

export function assessBenchmarkOutput(id: BenchmarkScenarioId, text: string) {
  let json: unknown;
  try {
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
  } catch {
    return {
      structure: [{ label: "Разбираемый JSON", passed: false }],
      output: null,
    };
  }

  function render(
    output: string,
    structure: BenchmarkProviderResult["structure"]
  ) {
    return {
      structure: [{ label: "Разбираемый JSON", passed: true }, ...structure],
      output: sanitizeTextForDisplay(output).slice(0, 13_000),
    };
  }

  if (id === "fact-check") {
    const parsed = factFormat.safeParse(json);
    if (parsed.success) {
      return render(
        parsed.data.findings
          .map(
            (f) => `${f.check} · ${f.verdict} · [${f.source}] ${f.correction}`
          )
          .join("\n"),
        factChecks.map((expected) => {
          const matches = parsed.data.findings.filter(
            (f) => f.check === expected.check
          );
          return {
            label: expected.label,
            passed:
              matches.length === 1 &&
              matches[0].verdict === expected.verdict &&
              matches[0].source === expected.source,
          };
        })
      );
    }
  }

  if (id === "article") {
    const parsed = articleFormat.safeParse(json);
    if (parsed.success) {
      const { title, lead, sections, sources } = parsed.data;
      const sectionSources = sections.flatMap((section) => section.sources);
      return render(
        `${title}\n\n${lead}\n\n${sections.map((s) => `${s.heading}\n${s.body} [${s.sources.join(", ")}]`).join("\n\n")}\n\nИсточники: ${sources.join(", ")}`,
        [
          {
            label: "H1, лид ≤1000 знаков и ≥2 блока",
            passed: lead.length <= 1000 && sections.length >= 2,
          },
          {
            label: "Проект и оба вуза в лиде",
            passed:
              /виртуальн.{0,10}травмпункт/iu.test(lead) &&
              /мидис|институт дизайна и сервиса/iu.test(lead) &&
              /юугму|южно-уральский государственный медицинский университет/iu.test(
                lead
              ),
          },
          {
            label: "Ссылки на TRAUMA и NEWS в блоках",
            passed:
              sections.every(
                (s) =>
                  s.sources.length > 0 &&
                  s.sources.every(
                    (source) => source === "TRAUMA" || source === "NEWS"
                  )
              ) &&
              sectionSources.includes("TRAUMA") &&
              sectionSources.includes("NEWS") &&
              sources.length === 2 &&
              sources.includes("TRAUMA") &&
              sources.includes("NEWS"),
          },
        ]
      );
    }
  }

  if (id === "analytics") {
    const parsed = analyticsFormat.safeParse(json);
    if (parsed.success) {
      const { total, rows } = parsed.data;
      const row = rows.find((item) => item.source === "MEDAI");
      return render(
        `Всего: ${total}\n${rows.map((item) => `[${item.source}] ${item.university} · ${item.partner} · ${item.status}`).join("\n")}`,
        [
          {
            label: "В итогах один проект",
            passed: total === 1 && rows.length === total,
          },
          {
            label: "Выбран только MEDAI",
            passed: rows.length === 1 && Boolean(row),
          },
          {
            label: "Карточка MEDAI: вуз, партнёр и статус",
            passed: Boolean(
              row &&
              /юугму|южно-уральский государственный медицинский университет/iu.test(
                row.university
              ) &&
              /эва\s+лаб/iu.test(row.partner) &&
              /обсужден|отбор/iu.test(row.status)
            ),
          },
        ]
      );
    }
  }

  return {
    structure: [{ label: "Ожидаемая схема JSON", passed: false }],
    output: null,
  };
}
