export type CampusSearchResult = {
  title: string;
  href: string;
  detail?: string;
};

type CampusService = CampusSearchResult & {
  navTitle: string;
  aliases: string[];
};

const services: CampusService[] = [
  {
    href: "/knowledge",
    title: "Справочник",
    navTitle: "Справочник",
    aliases: ["база знаний", "официальные данные", "карточки", "каталог"],
  },
  {
    href: "/editor",
    title: "Редактор публикаций",
    navTitle: "Редактор",
    aliases: [
      "умный редактор",
      "редактор статей",
      "написать статью",
      "создать статью",
      "статья",
      "статьи",
      "создать публикацию",
      "черновик",
      "пресс-релиз",
      "editor",
    ],
  },
  {
    href: "/check",
    title: "Проверка текста",
    navTitle: "Проверка",
    aliases: [
      "проверить текст",
      "проверить факты",
      "проверка фактов",
      "фактчек",
      "фактчекинг",
      "факт-чек",
      "fact check",
    ],
  },
  {
    href: "/requests",
    title: "Межвузовские запросы",
    navTitle: "Запросы",
    aliases: [
      "задать вопрос",
      "запросить сведения",
      "запрос в вуз",
      "входящие",
      "исходящие",
    ],
  },
  {
    href: "/analytics",
    title: "Аналитика",
    navTitle: "Аналитика",
    aliases: [
      "статистика",
      "отчет",
      "аналитика кампуса",
      "сравнить вузы",
      "сравнение университетов",
    ],
  },
  {
    href: "/login",
    title: "Роли и доступ",
    navTitle: "Вход",
    aliases: ["аккаунт", "войти", "авторизация"],
  },
];

const comparison: CampusService = {
  href: "/comparison",
  title: "Полигон ИИ",
  navTitle: "Полигон ИИ",
  aliases: ["сравнение моделей", "ИИ-модели", "бенчмарк", "qwen", "yandex"],
};

const work: CampusService = {
  href: "/work",
  title: "Моя работа",
  navTitle: "Моя работа",
  aliases: ["рабочие задачи", "очередь задач", "инфоповоды", "согласование"],
};

export function campusServices(
  demo = process.env.NEXT_PUBLIC_DEMO_MODE === "true",
  staff = false,
  author = false,
) {
  const visible = staff ? services.flatMap((service) => service.href === "/requests" ? [work, service] : [service]) :
    author ? services.filter((service) => service.href !== "/requests") : services;
  return demo ? [...visible, comparison] : visible;
}

function normalize(value: string) {
  return value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function findCampusServices(
  query: string,
  demo = process.env.NEXT_PUBLIC_DEMO_MODE === "true"
): CampusSearchResult[] {
  const phrase = normalize(query);
  if (!phrase) return [];
  const tokens = phrase.split(" ");
  const matches = campusServices(demo).map((service) => {
    const names = [service.title, service.navTitle, ...service.aliases].map(
      normalize
    );
    const score = names.includes(phrase)
      ? 3
      : names.some((name) => name.startsWith(phrase))
        ? 2
        : names.some((name) => tokens.every((token) => name.includes(token)))
          ? 1
          : 0;
    return { service, score };
  });
  return matches
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ service: { title, href } }) => ({ title, href }));
}
