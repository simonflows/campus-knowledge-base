import Link from "next/link";
import {
  ArrowUpRight,
  BookOpenText,
  CalendarRange,
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  FilePenLine,
  Files,
  GraduationCap,
  Landmark,
  Maximize2,
  ScanText,
  Users,
} from "lucide-react";
import { AtlasCover } from "@/components/atlas-cover";
import { HomeSearch } from "@/components/home-search";
import { MotionReveal } from "@/components/motion/motion-reveal";
import masthead from "@/components/workspace-masthead.module.css";
import { folderIds, type CampusCard } from "@/lib/knowledge";
import type { University } from "@/lib/data";
import { cn } from "@/lib/utils";

type Props = {
  passport: CampusCard | null;
  universities: University[];
  cardsCount: number;
  showExampleData: boolean;
  hasMidisPassport: boolean;
};

function plural(count: number, one: string, few: string, many: string) {
  return count % 10 === 1 && count % 100 !== 11
    ? one
    : count % 10 >= 2 &&
        count % 10 <= 4 &&
        !(count % 100 >= 12 && count % 100 <= 14)
      ? few
      : many;
}

function metricIcon(label: string) {
  if (/площад/i.test(label)) {
    return Maximize2;
  }
  if (/вместим|континг/i.test(label)) {
    return Users;
  }
  if (/этап|очеред|срок/i.test(label)) {
    return CalendarRange;
  }
  return Landmark;
}

export function HomeDashboard({
  passport,
  universities,
  cardsCount,
  showExampleData,
  hasMidisPassport,
}: Props) {
  const source =
    passport &&
    `/knowledge?card=${encodeURIComponent(passport.id)}&version=approved`;
  const shortcuts = [
    {
      href: "#university-heading",
      title: "Вузы-резиденты",
      icon: GraduationCap,
      description: `${universities.length} ${plural(universities.length, "вуз", "вуза", "вузов")} в кампусе`,
    },
    {
      href: "/knowledge",
      title: "Карточки справочника",
      icon: Files,
      description: cardsCount
        ? `${cardsCount.toLocaleString("ru-RU")} ${plural(cardsCount, "карточка", "карточки", "карточек")}${showExampleData ? " для примера" : ""}`
        : "Пока нет публикаций",
    },
    {
      href: source ?? `/knowledge?folder=${folderIds.campus}`,
      title: "Паспорт кампуса",
      icon: BookOpenText,
      description: source ? "Показатели и источники" : "Пока не опубликован",
    },
    {
      href: "/check",
      title: "Проверить текст",
      icon: ScanText,
      description: "Сверка с источниками",
    },
  ];
  const tools = [
    {
      href: "/editor",
      title: "Редактор публикаций",
      text: "Подготовьте черновик статьи из выбранных источников.",
      iconMotion: "pen",
      icon: FilePenLine,
    },
    {
      href: "/analytics",
      title: "Аналитика кампуса",
      text: "Соберите справку по утверждённым карточкам.",
      iconMotion: "chart",
      icon: ChartNoAxesColumnIncreasing,
    },
  ] as const;

  const passportMetrics = passport
    ? passport.campusMetrics
        .filter((m) => /площад|вместим|этап|очеред|стоим|апартамент/i.test(m.label))
        .slice(0, 4)
    : [];

  const searchExamples = [
    "Редактор",
    passportMetrics.some((metric) => /площад/i.test(metric.label))
      ? "Площадь кампуса"
      : "Проверка текста",
    hasMidisPassport ? "МИДиС" : "Аналитика",
  ];

  return (
    <>
      <AtlasCover
        links={
          shortcuts.map(({ href, title, icon: Icon, description }) => (
            <Link key={title} className="atlas-scene-card" href={href}>
              <Icon
                className="atlas-card-glyph"
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </Link>
          ))
        }
      >
        <h1 className={masthead.title} id="campus-title">
          Справочник кампуса{" "}
          <em className="atlas-hero-title-accent">«Южный Урал»</em>
        </h1>
        <p className="atlas-lead">
          Найдите сведения о вузах, строительстве и лабораториях кампуса.
          Проверьте факты по источникам.
        </p>
        <HomeSearch examples={searchExamples} />
      </AtlasCover>

      <section className="atlas-passport" aria-labelledby="campus-metrics">
        <div className="wrap atlas-wrap">
          <MotionReveal>
            <div className="atlas-section-heading">
              <h2 id="campus-metrics">Показатели кампуса</h2>
              {source && (
                <Link className="atlas-inline" href={source}>
                  Паспорт и источники <ArrowUpRight size={17} />
                </Link>
              )}
            </div>
          </MotionReveal>
          {showExampleData && (
            <p className="atlas-source-note">
              На этой странице показаны демонстрационные данные.
            </p>
          )}
          {passportMetrics.length ? (
            <dl className="atlas-metrics atlas-bento-metrics">
              {passportMetrics.map((m, index) => {
                const MetricIcon = metricIcon(m.label);
                return (
                  <MotionReveal key={m.label} delayMs={index * 65}>
                    <div className="atlas-metric-card">
                      <div className="atlas-metric-head">
                        <dt>{m.label}</dt>
                        <span className="atlas-metric-icon" aria-hidden="true">
                          <MetricIcon size={18} strokeWidth={1.75} />
                        </span>
                      </div>
                      <dd>{m.value}</dd>
                      {m.note && (
                        <dd className="atlas-metric-note">
                          <details>
                            <summary>
                              Подробнее
                              <span className="sr-only">
                                {" "}
                                о показателе «{m.label}»
                              </span>
                              <ChevronDown size={14} aria-hidden="true" />
                            </summary>
                            <p>{m.note}</p>
                          </details>
                        </dd>
                      )}
                    </div>
                  </MotionReveal>
                );
              })}
            </dl>
          ) : (
            <p className="atlas-source-note">
              {passport
                ? "Сводные показатели ещё не опубликованы. Откройте паспорт кампуса, чтобы посмотреть доступные сведения."
                : "Утверждённый паспорт пока не опубликован."}
            </p>
          )}
        </div>
      </section>

      <section
        className="atlas-resources wrap atlas-wrap"
        aria-labelledby="work-tools"
      >
        <MotionReveal>
          <div className="atlas-section-heading">
            <h2 id="work-tools">Рабочие инструменты</h2>
          </div>
        </MotionReveal>
        <div className="atlas-tools atlas-bento-tools">
          {tools.map(
            (
              { href, title, text, iconMotion, icon: Icon },
              index
            ) => (
              <MotionReveal
                key={href}
                className="atlas-tool-slot"
                delayMs={index * 70}
              >
                <div className="atlas-tool-card">
                  <Link href={href} className="atlas-tool-link">
                    <div className="atlas-tool-top">
                      <span
                        className="atlas-tool-icon"
                        data-icon-motion={iconMotion}
                      >
                        <Icon size={20} strokeWidth={1.6} aria-hidden="true" />
                      </span>
                      <ArrowUpRight
                        className="atlas-arrow"
                        aria-hidden="true"
                        size={18}
                      />
                    </div>
                    <div className="atlas-tool-body">
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </div>
                  </Link>
                </div>
              </MotionReveal>
            )
          )}
        </div>
      </section>

      <section
        className="atlas-universities wrap atlas-wrap"
        aria-labelledby="university-heading"
      >
        <MotionReveal>
          <div className="atlas-section-heading">
            <h2 id="university-heading">Университеты-резиденты</h2>
          </div>
        </MotionReveal>
        <div className="atlas-bento-universities">
          {universities.map((u, index) => (
            <MotionReveal key={u.id} delayMs={index * 45}>
              <div className="atlas-uni-card">
                <Link
                  href={`/knowledge?folder=${encodeURIComponent(`01_universities/${u.id}`)}`}
                  className="atlas-uni-link"
                >
                  <div className="atlas-uni-top">
                    <span
                      className={cn("atlas-uni-monogram", u.accent)}
                      aria-hidden="true"
                    >
                      {u.monogram}
                    </span>
                    <ArrowUpRight
                      className="atlas-uni-arrow"
                      size={17}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="atlas-uni-name">
                    <strong>{u.shortName}</strong>
                    <span>{u.fullName}</span>
                  </div>
                  <div className="atlas-uni-tags" aria-hidden="true">
                    {u.tags.slice(0, 3).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </Link>
              </div>
            </MotionReveal>
          ))}
          <MotionReveal delayMs={universities.length * 45}>
            <div className="atlas-uni-card atlas-uni-cta">
              <Link
                href="/knowledge?folder=01_universities"
                className="atlas-uni-link"
              >
                <div className="atlas-uni-top">
                  <span className="atlas-uni-monogram" aria-hidden="true">
                    <GraduationCap size={18} strokeWidth={1.7} />
                  </span>
                  <ArrowUpRight
                    className="atlas-uni-arrow"
                    size={17}
                    aria-hidden="true"
                  />
                </div>
                <div className="atlas-uni-name">
                  <strong>Все вузы и лаборатории</strong>
                  <span>Карточки вузов, лабораторий и проектов</span>
                </div>
              </Link>
            </div>
          </MotionReveal>
        </div>
      </section>
    </>
  );
}
