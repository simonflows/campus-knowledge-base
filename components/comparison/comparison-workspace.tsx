"use client";
import { WorkspaceMasthead } from "@/components/workspace-masthead";

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Database,
  Copy,
  Cpu,
  FileCheck2,
  GraduationCap,
  HardDrive,
  Layers,
  Loader2,
  Play,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AUDIT_DISCREPANCY_TABLE,
  AUDIT_DISTORTION_MECHANISMS,
  CANONICAL_CAMPUS_PASSPORT,
} from "@/lib/audit-canon-registry";
import type { BenchmarkResponse } from "@/lib/benchmark";
import { cn } from "@/lib/utils";

type TabId = "architecture" | "benchmark" | "alibaba-edu" | "audit-memo";

const TABS: Array<{ id: TabId; label: string; icon: typeof ShieldCheck }> = [
  { id: "architecture", label: "Российская архитектура", icon: ShieldCheck },
  { id: "benchmark", label: "Полигон Yandex vs Alibaba", icon: Scale },
  { id: "alibaba-edu", label: "Стенд Alibaba для вузов", icon: GraduationCap },
  { id: "audit-memo", label: "Аудит 66 кейсов и Памятка", icon: BookOpen },
];

const REPLACEMENT_MAP = [
  {
    icon: Database,
    foreign: "Хранение базы",
    russian: "YDB Document API / DynamoDB",
    why: "В БД хранятся карточки, согласования и библиотека. При недоступности БД рабочий контур показывает читаемый стартовый набор.",
  },
  {
    icon: HardDrive,
    foreign: "Резерв на Яндекс Диске",
    russian: "Независимые файлы Markdown и CSV",
    why: "Статус выгрузки виден в приложении. Для отправки требуется настроенное подключение к Диску.",
  },
  {
    icon: FileCheck2,
    foreign: "Фактчекинг и аналитика",
    russian: "Локальные правила и утверждённые карточки",
    why: "Проверка и выборка строятся внутри сервиса. Результаты ведут к карточкам базы.",
  },
  {
    icon: Cpu,
    foreign: "Генерация и полигон",
    russian: "Yandex AI Studio и Alibaba Qwen",
    why: "Редактор использует локальную сборку или Yandex AI Studio при подключении. Сравнительному полигону передаётся фиксированный набор открытых материалов.",
  },
];

const PROFILES = [
  {
    name: "Yandex AI Studio",
    onboarding:
      "Agent Atelier, поиск по загруженным файлам и визуальный Yandex Workflows. Нужны каталог, платёжный аккаунт и права.",
    price:
      "YandexGPT Pro 5 по умолчанию: 1,20 ₽ за 1000 входящих и 1,20 ₽ за 1000 исходящих токенов, с НДС.",
    docs: "https://aistudio.yandex.ru/ru/docs/ai-studio/quickstart/agent-atelier",
    pricing: "https://aistudio.yandex.ru/ru/docs/ai-studio/pricing",
  },
  {
    name: "Alibaba Cloud Model Studio",
    onboarding:
      "OpenAI-совместимый DashScope API. Для новых аккаунтов в Сингапуре документация указывает ограничения доступа к визуальным приложениям и базе знаний.",
    price:
      "Qwen-Plus (Singapore International, до 256K, без режима рассуждений): 0,40 USD за 1 млн входящих и 1,20 USD за 1 млн исходящих токенов.",
    docs: "https://www.alibabacloud.com/help/en/model-studio/application-introduction",
    pricing: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
  },
];

const ALIBABA_CODE_SNIPPET = `// Пример учебного подключения к Alibaba Cloud Model Studio (DashScope)
// Учебный пример. Используйте только открытые данные без сведений о людях.
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.ALIBABA_DASHSCOPE_API_KEY,
  baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
});

const completion = await client.chat.completions.create({
  model: "qwen-plus",
  temperature: 0.05,
  messages: [
    { role: "system", content: "Отвечай строго по официальным карточкам кампуса." },
    { role: "user", content: "Карточка TRAUMA: МИДиС и ЮУГМУ совместно разрабатывают виртуальный травмпункт. Назови участников и укажи ID карточки." },
  ],
});`;

export function ComparisonWorkspace({
  yandexConfigured,
  alibabaConfigured,
  storageMode,
  canRunLive,
}: {
  yandexConfigured: boolean;
  alibabaConfigured: boolean;
  storageMode: string;
  canRunLive: boolean;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("architecture");
  const [isRunning, setIsRunning] = useState(false);
  const [benchmark, setBenchmark] = useState<BenchmarkResponse | null>(null);

  const runBenchmark = async (mode: BenchmarkResponse["mode"]) => {
    if (isRunning) return;
    setIsRunning(true);
    try {
      const response = await fetch("/api/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "all", mode }),
      });
      const data = (await response.json().catch(() => null)) as
        | (BenchmarkResponse & { error?: string })
        | null;

      if (!response.ok || !data) {
        toast.error(data?.error ?? "Не удалось запустить полигон");
        return;
      }

      setBenchmark(data);
      toast.success(
        mode === "live"
          ? "Облачный прогон завершён"
          : "Локальные эталоны готовы"
      );
    } catch {
      toast.error("Ошибка связи с /api/benchmark");
    } finally {
      setIsRunning(false);
    }
  };

  const handleCopySnippet = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(ALIBABA_CODE_SNIPPET);
      toast.success("Код для учебного стенда скопирован");
    } catch {
      toast.error(
        "Не удалось скопировать код — выделите его и скопируйте вручную"
      );
    }
  };

  return (
    <div className="atlas-wrap data-workspace data-comparison">
      <WorkspaceMasthead
        id="comparison-title"
        icon={Cpu}
        title="Архитектура и полигон ИИ"
        description="Сравните Yandex AI Studio и Alibaba Cloud Model Studio на трёх задачах кампуса."
        note={
          <span className="data-comparison-storage">
            <HardDrive aria-hidden="true" />
            {storageMode === "dynamodb"
              ? "БД: YDB / DynamoDB"
              : storageMode === "local-json"
                ? "БД: локальный пилот"
                : "База: режим чтения"}
          </span>
        }
      >
        <dl className="data-provider-list">
          <div>
            <dt>Yandex AI Studio</dt>
            <dd data-connected={yandexConfigured}>
              <span aria-hidden="true" />
              {yandexConfigured ? "API подключён" : "API не настроен"}
            </dd>
          </div>
          <div>
            <dt>Alibaba Qwen</dt>
            <dd data-connected={alibabaConfigured}>
              <span aria-hidden="true" />
              {alibabaConfigured ? "API подключён" : "API не настроен"}
            </dd>
          </div>
        </dl>
      </WorkspaceMasthead>

      <div
        role="tablist"
        aria-label="Разделы страницы"
        className="data-comparison-tabs"
        onKeyDown={(event) => {
          const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
          const lastIndex = TABS.length - 1;
          let targetIndex: number;
          switch (event.key) {
            case "ArrowRight":
              targetIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
              break;
            case "ArrowLeft":
              targetIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
              break;
            case "Home":
              targetIndex = 0;
              break;
            case "End":
              targetIndex = lastIndex;
              break;
            default:
              return;
          }
          event.preventDefault();
          const target = TABS[targetIndex].id;
          setActiveTab(target);
          document.getElementById(`tab-${target}`)?.focus();
        }}
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <Button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active}
              aria-controls="comparison-panel"
              tabIndex={active ? 0 : -1}
              variant={active ? "default" : "outline"}
              onClick={() => setActiveTab(tab.id)}
              className="data-comparison-tab"
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </Button>
          );
        })}
      </div>

      <div
        id="comparison-panel"
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === "architecture" ? (
          <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
            <CardHeader>
              <CardTitle className="font-heading text-xl">
                Как устроен сервис
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="data-architecture-map">
                {REPLACEMENT_MAP.map(
                  ({ foreign, russian, why, icon: Icon }) => (
                    <div key={foreign}>
                      <span aria-hidden="true">
                        <Icon />
                      </span>
                      <dt>{foreign}</dt>
                      <dd>{russian}</dd>
                      <p>{why}</p>
                    </div>
                  )
                )}
              </dl>
            </CardContent>
          </Card>
        ) : null}

        {activeTab === "benchmark" ? (
          <div className="flex flex-col gap-6">
            <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
              <CardHeader>
                <CardTitle className="font-heading text-xl">
                  Три контрольных сценария
                </CardTitle>
                <CardDescription>
                  Один фиксированный набор открытых сведений для обоих API.
                  Черновики сотрудников, контакты владельцев и материалы рабочей
                  базы в запросы полигона не входят.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => runBenchmark("reference")}
                    disabled={isRunning}
                  >
                    {isRunning ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Play />
                    )}{" "}
                    Показать локальные эталоны
                  </Button>
                  {canRunLive ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => runBenchmark("live")}
                      disabled={
                        isRunning || !(yandexConfigured || alibabaConfigured)
                      }
                    >
                      <Play /> Запустить облачные API
                    </Button>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  Облачный запуск доступен администратору пилота при
                  подключённым API. Время и токены появляются после запроса к
                  провайдеру.
                </p>
                {benchmark ? (
                  <>
                    <p role="status" className="text-sm text-muted-foreground">
                      Набор {benchmark.fixtureVersion} ·{" "}
                      {new Date(benchmark.executedAt).toLocaleString("ru-RU")}
                    </p>
                    {benchmark.scenarios.map((scenario) => (
                      <section key={scenario.id} className="data-scenario">
                        <h2 className="text-lg font-semibold">
                          {scenario.title}
                        </h2>
                        <p className="text-sm">{scenario.input}</p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                          {scenario.criteria.map((criterion) => (
                            <li key={criterion}>{criterion}</li>
                          ))}
                        </ul>
                        <details
                          className="rounded-xl bg-muted/50 p-3"
                          open={benchmark.mode === "reference"}
                        >
                          <summary className="cursor-pointer text-sm font-medium">
                            Локальный эталон
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                            {scenario.reference}
                          </p>
                        </details>
                        {benchmark.mode === "live" ? (
                          <div className="grid gap-3 md:grid-cols-2">
                            {(
                              [
                                ["Yandex AI Studio", scenario.yandex],
                                [
                                  "Alibaba Cloud Model Studio",
                                  scenario.alibaba,
                                ],
                              ] as const
                            ).map(([name, result]) => (
                              <div
                                key={name}
                                className="flex min-w-0 flex-col gap-2 rounded-xl border p-3"
                              >
                                <h3 className="text-sm font-semibold">
                                  {name}
                                </h3>
                                <p className="text-sm">
                                  {result.mode === "live"
                                    ? "Ответ API"
                                    : result.message}
                                  {result.latencyMs !== null
                                    ? ` · ${result.latencyMs} мс`
                                    : ""}
                                </p>
                                {result.model ? (
                                  <p className="break-words text-xs text-muted-foreground">
                                    Модель {result.model}
                                  </p>
                                ) : null}
                                {result.usage ? (
                                  <p className="text-xs text-muted-foreground">
                                    Токены: {result.usage.inputTokens} на входе,{" "}
                                    {result.usage.outputTokens} на выходе
                                  </p>
                                ) : null}
                                {result.structure.length ? (
                                  <ul className="flex flex-col gap-1 text-xs">
                                    {result.structure.map((check) => (
                                      <li key={check.label}>
                                        {check.passed
                                          ? "Пройдено"
                                          : "Требует проверки"}{" "}
                                        · {check.label}
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {result.output ? (
                                  <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2 text-sm">
                                    {result.output}
                                  </p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </section>
                    ))}
                  </>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
              <CardHeader>
                <CardTitle className="font-heading text-xl">
                  Платформы для занятий
                </CardTitle>
                <CardDescription>
                  Описание консолей и цены по документации на 20 ноября 2026
                  года. Качество текста и точность ответа оцениваются по итогам
                  облачного прогона и редакторской сверки.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {PROFILES.map((profile) => (
                  <section
                    key={profile.name}
                    className="flex flex-col gap-2 rounded-2xl border p-4 text-sm"
                  >
                    <h3 className="font-semibold">{profile.name}</h3>
                    <p>{profile.onboarding}</p>
                    <p>{profile.price}</p>
                    <div className="flex flex-wrap gap-3 text-primary underline">
                      <a href={profile.docs}>Конструктор и документы</a>
                      <a href={profile.pricing}>Тарифы</a>
                    </div>
                  </section>
                ))}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {activeTab === "alibaba-edu" ? (
          <div className="space-y-6">
            <Alert>
              <GraduationCap className="size-4" />
              <AlertTitle>
                Учебный полигон на базе Alibaba Cloud для студентов и
                университетов
              </AlertTitle>
              <AlertDescription>
                Полигон отправляет только подготовленные открытые карточки без
                сведений о физических лицах.
              </AlertDescription>
            </Alert>

            <div className="grid gap-4 md:grid-cols-2">
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Layers className="h-5 w-5 text-primary" />
                    Архитектура студенческого стенда в Alibaba Cloud
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-xs leading-relaxed">
                  <div className="rounded-xl bg-muted/40 p-3">
                    <strong>1. Model Studio (Bailian) + Knowledge Base:</strong>{" "}
                    используйте отдельный открытый учебный набор. В Сингапуре
                    проверьте доступ к этой функции у учебного аккаунта.
                  </div>
                  <div className="rounded-xl bg-muted/40 p-3">
                    <strong>2. Agentic Workflow (Low-Code):</strong> сборка
                    визуального пайплайна при доступе к редактору. Для учебной
                    работы достаточно DashScope API и фиксированных карточек из
                    полигона.
                  </div>
                  <div className="rounded-xl bg-muted/40 p-3">
                    <strong>3. ECS / FC + OSS (для разработчиков):</strong>{" "}
                    развёртывание студенческих веб-прототипов на лёгком инстансе
                    Alibaba Cloud ECS (или в контейнере Docker) с подключением к
                    DashScope через переменную{" "}
                    <code>ALIBABA_DASHSCOPE_API_KEY</code>.
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl shadow-sm">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Terminal className="h-5 w-5 text-primary" />
                      Подключение DashScope (OpenAI SDK)
                    </CardTitle>
                    <CardDescription>
                      Этот же протокол уже встроен в{" "}
                      <code>lib/alibaba-ai.ts</code>
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10"
                    onClick={handleCopySnippet}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Копировать
                  </Button>
                </CardHeader>
                <CardContent>
                  <pre tabIndex={0} className="data-code-sample">
                    {ALIBABA_CODE_SNIPPET}
                  </pre>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}

        {activeTab === "audit-memo" ? (
          <div className="space-y-6">
            <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="font-heading text-xl">
                      Сводная панорама {AUDIT_DISCREPANCY_TABLE.length} ключевых
                      противоречий инфополя (PDF-аудит)
                    </CardTitle>
                    <CardDescription>
                      Проверена 161 веб-страница (105 публикаций, 66
                      задокументированных разночтений за 2020–2026 гг.). Все
                      правила уже зашиты в фактчекер.
                    </CardDescription>
                  </div>
                  <Link
                    href="/check"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      "min-h-10"
                    )}
                  >
                    <FileCheck2 className="mr-1.5 h-4 w-4" />
                    Проверить текст на ошибки
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Таблица разночтений"
                  className="data-audit-table"
                >
                  <table className="w-full min-w-[780px] border-collapse text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="p-3 font-semibold">Базовый вопрос</th>
                        <th className="p-3 font-semibold">
                          Разночтения в открытых источниках
                        </th>
                        <th className="p-3 font-semibold">
                          Официальные данные (
                          {CANONICAL_CAMPUS_PASSPORT.officialCode})
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {AUDIT_DISCREPANCY_TABLE.map((row, rowIndex) => (
                        <tr
                          key={`${row.question}-${rowIndex}`}
                          className="align-top"
                        >
                          <td className="p-3 text-xs font-semibold">
                            {row.question}
                            <div className="mt-1 text-[10px] font-normal text-muted-foreground">
                              Кейсы: {row.caseNumbers.join(", ")} · Вариантов:{" "}
                              {row.variantsCount}
                            </div>
                          </td>
                          <td className="p-3">
                            <div className="flex flex-wrap gap-1">
                              {row.variantsInMedia.map((v) => (
                                <Badge
                                  key={v}
                                  variant="outline"
                                  className="border-amber-200 bg-amber-50/70 text-[11px] text-amber-900"
                                >
                                  {v}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className="p-3 text-xs leading-relaxed text-emerald-900">
                            {row.canonicalAnswer}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {AUDIT_DISTORTION_MECHANISMS.map((m) => (
                <Card key={m.number} className="rounded-2xl shadow-sm">
                  <CardHeader className="pb-2">
                    <Badge variant="secondary" className="w-fit text-[11px]">
                      Механизм {m.number}
                    </Badge>
                    <CardTitle className="mt-1 text-base">{m.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                    <p>{m.description}</p>
                    <p className="rounded-lg bg-muted/50 p-2 text-foreground/85">
                      {m.example}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Separator />

            <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-heading text-xl">
                  <ClipboardList className="h-5 w-5 text-primary" />
                  Памятка для сотрудников 7 вузов, АНО «РИОН», ООО «ЧКК» и
                  Минобрнауки
                </CardTitle>
                <CardDescription>
                  Короткая инструкция по работе с единой базой официальных
                  данных в режиме «одного окна».
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    1. Два слоя знаний (Слой 1 и Слой 2)
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <strong>Слой 1 (Официальные карточки)</strong> —
                    единственный источник цифр, дат, статусов площадок и
                    авторства. <strong>Слой 2 (Готовые_статьи/)</strong> —
                    библиотека утверждённых чанков других вузов для живых
                    формулировок.
                  </p>
                </div>
                <div className="rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                    2. «Правило владельца» и равноправие 7 вузов
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Все 7 вузов равноправны. Редактировать карточку может только
                    её владелец и Администратор базы. Совместные проекты
                    (например, МИДиС + ЮУГМУ) лежат в{" "}
                    <code>02_Совместные_проекты/</code> и требуют согласования
                    обеих сторон. Чужие карточки можно комментировать кнопкой
                    «Запросить правку».
                  </p>
                </div>
                <div className="rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    3. Порядок работы перед публикацией
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Сгенерируйте текст в «Умном редакторе» (он сразу соберёт лид
                    до 1000 знаков и H1–H3 чанки) или вставьте черновик в
                    «Фактчекинг». Публикация разрешена только при отсутствии
                    красных флагов (0 красных).
                  </p>
                </div>
                <div className="rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <HardDrive className="h-4 w-4 text-primary" />
                    4. Резервное дублирование на Яндекс Диск
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    После одобрения карточки или сохранения статьи система
                    автоматически выгружает читаемый <code>.md</code>-файл и
                    сводную таблицу <code>.csv</code> в папки{" "}
                    <code>00_Кампус_общие_параметры</code>,{" "}
                    <code>01_Вузы_резиденты</code> и{" "}
                    <code>02_Совместные_проекты</code> на Яндекс Диске.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
