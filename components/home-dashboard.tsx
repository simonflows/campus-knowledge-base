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
  MapPin,
  Maximize2,
  ScanText,
  Users,
} from "lucide-react";
import { AtlasCover } from "@/components/atlas-cover";
import { HomeSearch } from "@/components/home-search";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { MotionReveal } from "@/components/motion/motion-reveal";
import { SpotlightCard } from "@/components/motion/spotlight-card";
import masthead from "@/components/workspace-masthead.module.css";
import type { CampusCard } from "@/lib/knowledge";
import type { University } from "@/lib/data";
import { cn } from "@/lib/utils";

type Props = {
  passport: CampusCard | null;
  universities: University[];
  cardsCount: number;
  live: boolean;
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

function metricVisual(label: string) {
  if (/площад/i.test(label)) {
    return { icon: Maximize2, tone: "sky" as const };
  }
  if (/вместим|континг/i.test(label)) {
    return { icon: Users, tone: "teal" as const };
  }
  if (/этап|очеред|срок/i.test(label)) {
    return { icon: CalendarRange, tone: "copper" as const };
  }
  return { icon: Landmark, tone: "indigo" as const };
}

export function HomeDashboard({
  passport,
  universities,
  cardsCount,
  live,
}: Props) {
  const source =
    passport &&
    `/knowledge?card=${encodeURIComponent(passport.id)}&version=approved`;
  const tools = [
    {
      href: "/knowledge",
      title: "Официальные данные",
      text: "Карточки кампуса и университетов с фактами и источниками.",
      tag: "Поиск и карточки",
      tone: "sky",
      iconMotion: "book",
      icon: BookOpenText,
    },
    {
      href: "/check",
      title: "Проверка текста",
      text: "Сверьте цифры и утверждения в статье с материалами справочника.",
      tag: "Сверка с базой",
      tone: "copper",
      iconMotion: "scan",
      icon: ScanText,
    },
    {
      href: "/editor",
      title: "Редактор публикаций",
      text: "Подготовьте черновик статьи из выбранных источников.",
      tag: "Черновики и ИИ",
      tone: "sage",
      iconMotion: "pen",
      icon: FilePenLine,
    },
    {
      href: "/analytics",
      title: "Аналитика кампуса",
      text: "Сравните показатели университетов и охват источников.",
      tag: "Отчёты и сводки",
      tone: "sand",
      iconMotion: "chart",
      icon: ChartNoAxesColumnIncreasing,
    },
  ] as const;

  const passportMetrics = passport
    ? passport.campusMetrics
        .filter((m) => /площад|вместим|этап|стоим/i.test(m.label))
        .slice(0, 4)
    : [];

  return (
    <>
      <AtlasCover
        links={
          <>
            <a
              className="atlas-scene-card atlas-resident-card"
              href="#university-heading"
            >
              <GraduationCap className="atlas-card-glyph" aria-hidden="true" />
              <ArrowUpRight className="atlas-card-arrow" aria-hidden="true" />
              <strong className="atlas-card-number">
                <AnimatedNumber value={universities.length} />
              </strong>
              <span>
                {plural(
                  universities.length,
                  "вуз-резидент",
                  "вуза-резидента",
                  "вузов-резидентов"
                )}
              </span>
            </a>
            <Link
              className="atlas-scene-card atlas-catalog-card"
              href="/knowledge"
            >
              <Files className="atlas-card-glyph" aria-hidden="true" />
              <ArrowUpRight className="atlas-card-arrow" aria-hidden="true" />
              <strong className="atlas-card-number">
                <AnimatedNumber value={cardsCount} />
              </strong>
              <span>
                {plural(cardsCount, "карточка", "карточки", "карточек")} в
                справочнике
              </span>
            </Link>
            <Link
              className="atlas-scene-card atlas-passport-card"
              href={source || "/knowledge"}
            >
              <BookOpenText className="atlas-card-glyph" aria-hidden="true" />
              <span>
                <strong>
                  {source ? "Паспорт кампуса" : "Официальные данные"}
                </strong>
                <small>
                  {source ? "Показатели и источники" : "Карточки справочника"}
                </small>
              </span>
              <ArrowUpRight className="atlas-card-arrow" aria-hidden="true" />
            </Link>
            <Link className="atlas-scene-card atlas-verify-card" href="/check">
              <ScanText className="atlas-card-glyph" aria-hidden="true" />
              <span>
                <strong>Проверить текст</strong>
                <small>Сверка с источниками</small>
              </span>
              <ArrowUpRight className="atlas-card-arrow" aria-hidden="true" />
            </Link>
          </>
        }
      >
        <p className="atlas-kicker">
          <span className="atlas-kicker-pin" aria-hidden="true">
            <MapPin size={14} />
          </span>
          Челябинская область
        </p>
        <h1 className={masthead.title} id="campus-title">
          Справочник кампуса{" "}
          <em className="atlas-hero-title-accent">«Южный Урал»</em>
        </h1>
        <p className="atlas-lead">
          Найдите официальные сведения о вузах, строительстве и лабораториях
          кампуса и сверьте их с источником.
        </p>
        <HomeSearch />
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
          {!live && (
            <p className="atlas-source-note">
              Показаны справочные данные. Подключение к актуальной базе
              недоступно.
            </p>
          )}
          {passport ? (
            <dl className="atlas-metrics atlas-bento-metrics">
              {passportMetrics.map((m, index) => {
                const { icon: MetricIcon, tone } = metricVisual(m.label);
                return (
                  <MotionReveal key={m.label} delayMs={index * 65}>
                    <SpotlightCard
                      className="atlas-metric-card"
                      data-tone={tone}
                    >
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
                    </SpotlightCard>
                  </MotionReveal>
                );
              })}
            </dl>
          ) : (
            <p className="atlas-source-note">
              Утверждённый паспорт пока недоступен. Найдите нужные сведения в
              справочнике.
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
              { href, title, text, tag, tone, iconMotion, icon: Icon },
              index
            ) => (
              <MotionReveal
                key={href}
                className="atlas-tool-slot"
                delayMs={index * 70}
              >
                <SpotlightCard className="atlas-tool-card" data-tone={tone}>
                  <span className="atlas-tool-corner" aria-hidden="true" />
                  <Link href={href} className="atlas-tool-link">
                    <div className="atlas-tool-top">
                      <div className="atlas-tool-left">
                        <span
                          className="atlas-tool-icon"
                          data-icon-motion={iconMotion}
                        >
                          <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
                        </span>
                        <span className="atlas-tool-tag">{tag}</span>
                      </div>
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
                </SpotlightCard>
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
              <SpotlightCard className="atlas-uni-card" data-uni={u.id}>
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
              </SpotlightCard>
            </MotionReveal>
          ))}
          <MotionReveal delayMs={universities.length * 45}>
            <SpotlightCard className="atlas-uni-card atlas-uni-cta">
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
                  <span>
                    Карточки 7 резидентов, проекты и партнёры в едином каталоге
                  </span>
                </div>
                <div className="atlas-uni-tags" aria-hidden="true">
                  <span>7 вузов</span>
                  <span>Лаборатории</span>
                  <span>Каталог</span>
                </div>
              </Link>
            </SpotlightCard>
          </MotionReveal>
        </div>
      </section>
    </>
  );
}
