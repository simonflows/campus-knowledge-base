import { folderIds, type KnowledgeCard } from "../lib/knowledge";

export const qaPublicSources = {
  "midis-kuka-2024-10-18": {
    url: "https://midis.ru/novosti/robot-kuka-kompaniya-golos-i-novye-vozmozhnosti-dlya-studentov-midis-/",
    publishedOn: "2024-10-18",
    excerpt:
      "А пока гости познакомились с нашим Центром промышленного дизайна и роботом Kuka.",
  },
  "susu-campus-participation-2026-02-13": {
    url: "https://www.susu.ru/ru/news/2026/02/13/studenty-s-1-sentyabrya-smogut-zaselitsya-v-novye-gostinicy-kampusa",
    publishedOn: "2026-02-13",
    excerpt:
      "Участниками проекта стали семь вузов: ЮУрГУ, ЧелГУ, МГТУ им. Г.И. Носова, ЮУрГАУ, ЮУГМУ, МИДиС и ЮурГГПУ.",
  },
  "susmu-trauma-authorship-2023-07-14": {
    url: "https://susmu.su/universitet/news/2023/yuugmu-sovmestno-s-midis-razrabatyvayut-trenazher-virtualnoy-realnosti-dlya-travmatologov/",
    publishedOn: "2023-07-14",
    excerpt:
      "Проект реализуется совместно с дизайнерами и программистами Международного института дизайна и сервиса.",
  },
} as const;

const fixtureTimestamp = "2026-11-21T00:00:00.000Z";
const pendingFixture = {
  owners: ["Одноразовый стенд QA"],
  status: "pending",
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
} as const satisfies Pick<
  KnowledgeCard,
  "owners" | "status" | "createdAt" | "updatedAt"
>;

// Candidates for the disposable test database. Use the test reviewer for the approval step.
export const qaPublicSourceCards = {
  "midis-kuka-2024-10-18": {
    ...pendingFixture,
    id: "qa-public-midis-kuka",
    type: "laboratory",
    title: "Центр промышленного дизайна МИДиС с роботом KUKA",
    folderId: folderIds.subfolder("midis", "infrastructure"),
    affiliation: "МИДиС",
    partner: "—",
    head: "Не указан в публикации",
    placementStatus: "active",
    placementDetails:
      "В публикации от 18 октября 2024 года МИДиС описал показ робота KUKA в центре института.",
    workDirections: ["Промышленный дизайн"],
    equipment: ["Робот KUKA"],
    confirmedIndicators: [],
    referenceDescription:
      "По сообщению МИДиС от 18 октября 2024 года, робот KUKA показали в Центре промышленного дизайна института.",
    stopFormula:
      "Сведения о размещении робота в УНК кампуса требуют отдельного подтверждения.",
  },
  "susu-campus-participation-2026-02-13": {
    ...pendingFixture,
    id: "qa-public-susu-participation",
    type: "university",
    title: "Паспорт ЮУрГУ",
    folderId: folderIds.subfolder("susu", "passport"),
    universityId: "susu",
    structuredMetrics: [],
    referenceDescription:
      "ЮУрГУ указан среди участников проекта межуниверситетского кампуса «Южный Урал» в университетской публикации от 13 февраля 2026 года.",
    stopFormula:
      "Квоты мест, площади и показатели проектов требуют отдельных источников.",
  },
} satisfies Partial<Record<keyof typeof qaPublicSources, KnowledgeCard>>;

export const qaPublicSourceScenarios = {
  kukaPlacement: {
    sourceLabel: "midis-kuka-2024-10-18",
    correctText:
      qaPublicSourceCards["midis-kuka-2024-10-18"].referenceDescription,
    incorrectText:
      "Центр промышленного дизайна МИДиС с роботом KUKA уже работает в УНК кампуса.",
    analyticsQuery: "Покажи лаборатории МИДиС",
  },
  susuParticipation: {
    sourceLabel: "susu-campus-participation-2026-02-13",
    correctText:
      qaPublicSourceCards["susu-campus-participation-2026-02-13"]
        .referenceDescription,
    analyticsQuery: "Покажи паспорт вуза ЮУрГУ",
  },
} as const;
