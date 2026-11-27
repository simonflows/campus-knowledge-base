"use client";

import { useRef, type ReactNode } from "react";
import { CheckCircle2, ExternalLink } from "lucide-react";
import {
  AppLink,
  WorkspaceExternalLink,
} from "@/components/navigation/workspace-navigation";
import { Button } from "@/components/ui/button";
import {
  getCardStatus,
  getUniversityFullName,
  type KnowledgeCard,
} from "@/lib/knowledge";
import type { SourceVersionReference } from "@/lib/source-references";
import {
  evidenceUrlSchema,
  getCurrentStrategyEvidence,
  getOfficialDocument,
  getRoadmapIndicator,
  INDICATOR_SLOTS,
  isRoadmapIndicator,
  officialDocumentKindLabels,
  strategyClauseKindLabels,
  type ConfirmIndicatorAction,
  type IndicatorSlot,
  type OfficialDocumentData,
  type StrategyDocumentOption,
  type StrategyEvidence,
} from "@/lib/strategy";
import {
  StrategyDisclosure,
  StrategyOptionsNotice,
  useStrategyOptions,
} from "./strategy-inputs";

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const numberFormat = new Intl.NumberFormat("ru-RU", {
  maximumSignificantDigits: 21,
});
const sourceLinkClass =
  "inline-flex min-h-11 min-w-0 items-center gap-2 py-1 text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring";
const slotStatus = {
  plan: {
    label: "План",
    action: "confirm-plan",
    button: "Подтвердить план",
    confirmed: "План подтверждён",
  },
  actual: {
    label: "Факт",
    action: "confirm-actual",
    button: "Подтвердить факт",
    confirmed: "Факт подтверждён",
  },
} as const;

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : value;
}

function cardHref({ cardId, versionId }: SourceVersionReference) {
  return `/knowledge?${new URLSearchParams({ card: cardId, version: versionId })}`;
}

function Metadata({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="wrap-anywhere font-medium">{children}</dd>
    </div>
  );
}

function DocumentView({ document }: { document: OfficialDocumentData }) {
  const url = evidenceUrlSchema.safeParse(document.url);
  return (
    <section aria-label="Данные официального документа" className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Metadata label="Вид документа">
          {officialDocumentKindLabels[document.kind]}
        </Metadata>
        <Metadata label="Организация-источник">
          {document.sourceOrganization}
        </Metadata>
        <Metadata label="Дата документа">{formatDate(document.date)}</Metadata>
        <Metadata label="Редакция документа">{document.edition}</Metadata>
      </dl>
      {url.success ? (
        <WorkspaceExternalLink
          className={sourceLinkClass}
          href={url.data}
          target="_blank"
          rel="noopener noreferrer"
        >
          Открыть официальный документ{" "}
          <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
        </WorkspaceExternalLink>
      ) : null}
      {document.directions.length ? (
        <StrategyDisclosure
          title="Направления документа"
          count={document.directions.length}
        >
          <ul className="list-inside list-disc space-y-2 text-sm">
            {document.directions.map((direction) => (
              <li key={direction.id} className="wrap-anywhere">
                {direction.title}
              </li>
            ))}
          </ul>
        </StrategyDisclosure>
      ) : null}
      <StrategyDisclosure
        title="Проверенные выдержки"
        count={document.clauses.length}
      >
        {document.clauses.length ? (
          <ul className="divide-y divide-border">
            {document.clauses.map((clause) => (
              <li
                className="space-y-1 py-3 first:pt-0 last:pb-0"
                key={clause.id}
              >
                <p className="wrap-anywhere font-medium">
                  {clause.locator} · {strategyClauseKindLabels[clause.kind]}
                </p>
                <blockquote className="whitespace-pre-wrap wrap-anywhere text-sm">
                  {clause.excerpt}
                </blockquote>
                {clause.directionIds.length ? (
                  <p className="wrap-anywhere text-xs text-muted-foreground">
                    {document.directions
                      .filter((item) => clause.directionIds.includes(item.id))
                      .map((item) => item.title)
                      .join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Проверенные выдержки пока не добавлены.
          </p>
        )}
      </StrategyDisclosure>
    </section>
  );
}

function SourceView({
  evidence,
  source,
  current,
  historical,
}: {
  evidence: StrategyEvidence;
  source?: StrategyDocumentOption;
  current: ReturnType<typeof getCurrentStrategyEvidence>;
  historical: boolean;
}) {
  if (current)
    return (
      <AppLink
        href={cardHref(evidence.document)}
        className={sourceLinkClass}
        prefetch={false}
      >
        <span className="wrap-anywhere">
          {current.source.title} · {current.clause.locator}
        </span>
      </AppLink>
    );
  return (
    <p className="text-sm text-muted-foreground">
      {source ? (
        <AppLink
          href={cardHref(evidence.document)}
          className={sourceLinkClass}
          prefetch={false}
        >
          <span className="wrap-anywhere">
            {source.title} · прежняя редакция
          </span>
        </AppLink>
      ) : null}
      <span className="block">
        {source
          ? historical
            ? "Сохранённая редакция источника"
            : "Источник обновлён. Нужно повторно сверить сведения."
          : "Источник недоступен."}
      </span>
    </p>
  );
}

export function StrategyCardView({
  card,
  historical = false,
}: {
  card: KnowledgeCard;
  historical?: boolean;
}) {
  const document = getOfficialDocument(card);
  const indicator = getRoadmapIndicator(card);
  const links = card.strategyLinks ?? [];
  const needsOptions = Boolean(
    indicator?.plan ||
    indicator?.actual ||
    indicator?.relatedCardIds.length ||
    links.length
  );
  const options = useStrategyOptions(
    needsOptions,
    `${card.id}:${card.updatedAt}`
  );
  const documents = new Map(
    options.status === "ready"
      ? options.documents.map((item) => [item.cardId, item])
      : []
  );
  const status = getCardStatus(card);

  if (document) return <DocumentView document={document} />;
  if (indicator) {
    const { scope } = indicator;
    const contour =
      scope.kind === "campus"
        ? "Кампус"
        : scope.kind === "university"
          ? getUniversityFullName(scope.universityId)
          : scope.label;
    return (
      <section aria-label="Данные показателя" className="space-y-4">
        <p className="whitespace-pre-wrap wrap-anywhere text-sm">
          {indicator.definition}
        </p>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Metadata label="Контур">{contour}</Metadata>
          <Metadata label="Единица измерения">{indicator.unit}</Metadata>
        </dl>
        <div className="grid gap-3 sm:grid-cols-2">
          {INDICATOR_SLOTS.map((slot) => {
            const measurement = indicator[slot];
            const confirmed =
              status === "approved" ||
              (isRoadmapIndicator(card) &&
                card.confirmedIndicatorSlots?.includes(slot));
            const current =
              measurement &&
              getCurrentStrategyEvidence(measurement.evidence, documents, slot);
            const showValue =
              measurement && (historical || status !== "approved" || current);
            return (
              <section
                key={slot}
                aria-label={slotStatus[slot].label}
                className="min-w-0 space-y-2 rounded-xl border border-border p-3"
              >
                <h3 className="font-semibold">{slotStatus[slot].label}</h3>
                {showValue ? (
                  <>
                    <p className="wrap-anywhere text-lg font-semibold tabular-nums">
                      {numberFormat.format(measurement.value)} {indicator.unit}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {slot === "plan" ? "Срок" : "Актуально на"}{" "}
                      {formatDate(measurement.date)}
                    </p>
                    {status === "pending" ? (
                      <p className="text-sm text-muted-foreground">
                        {confirmed
                          ? slotStatus[slot].confirmed
                          : "На подтверждении"}
                      </p>
                    ) : null}
                  </>
                ) : !measurement || options.status === "ready" ? (
                  <p className="text-sm text-muted-foreground">
                    Нет подтверждённых данных
                  </p>
                ) : null}
                {measurement && options.status === "ready" ? (
                  <SourceView
                    evidence={measurement.evidence}
                    source={documents.get(measurement.evidence.document.cardId)}
                    current={current ?? null}
                    historical={historical}
                  />
                ) : null}
              </section>
            );
          })}
        </div>
        {needsOptions && options.status !== "ready" ? (
          <StrategyOptionsNotice options={options} />
        ) : null}
        {options.status === "ready" && indicator.relatedCardIds.length ? (
          <StrategyDisclosure
            title="Связанные проекты и объекты"
            count={indicator.relatedCardIds.length}
          >
            <ul>
              {indicator.relatedCardIds.map((id) => {
                const related = options.relatedCards.find(
                  (item) => item.cardId === id
                );
                return (
                  <li key={id}>
                    {related ? (
                      <AppLink
                        className={sourceLinkClass}
                        href={cardHref(related)}
                        prefetch={false}
                      >
                        <span className="wrap-anywhere">{related.title}</span>
                      </AppLink>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        Связанная карточка недоступна
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </StrategyDisclosure>
        ) : null}
      </section>
    );
  }
  if (!links.length) return null;
  return (
    <StrategyDisclosure
      title="Связь со стратегией и дорожной картой"
      count={links.length}
    >
      {options.status !== "ready" ? (
        <StrategyOptionsNotice options={options} />
      ) : (
        <ul className="divide-y divide-border">
          {links.map((link, index) => {
            const source = documents.get(link.document.cardId);
            const sameVersion = source?.versionId === link.document.versionId;
            const direction =
              sameVersion &&
              source.document.directions.find(
                (item) => item.id === link.directionId
              );
            const clause =
              sameVersion &&
              source.document.clauses.find((item) => item.id === link.clauseId);
            const evidence = getCurrentStrategyEvidence(
              link.evidence,
              documents
            );
            return (
              <li key={index} className="space-y-1 py-3 first:pt-0 last:pb-0">
                {source ? (
                  <AppLink
                    className={sourceLinkClass}
                    href={cardHref(link.document)}
                    prefetch={false}
                  >
                    <span className="wrap-anywhere">{source.title}</span>
                  </AppLink>
                ) : null}
                {sameVersion ? (
                  <p className="wrap-anywhere text-sm font-medium">
                    {[direction && direction.title, clause && clause.locator]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {source
                      ? historical
                        ? "Сохранённая редакция документа"
                        : "Документ обновлён. Нужно повторно сверить связь."
                      : "Документ недоступен."}
                  </p>
                )}
                <p className="whitespace-pre-wrap wrap-anywhere text-sm">
                  {link.explanation}
                </p>
                <p className="mt-2 text-sm font-medium">Подтверждение связи</p>
                <SourceView
                  evidence={link.evidence}
                  source={documents.get(link.evidence.document.cardId)}
                  current={evidence}
                  historical={historical}
                />
              </li>
            );
          })}
        </ul>
      )}
    </StrategyDisclosure>
  );
}

export function unconfirmedIndicatorSlots(
  card: KnowledgeCard
): IndicatorSlot[] {
  if (!isRoadmapIndicator(card)) return [];
  return INDICATOR_SLOTS.filter(
    (slot) =>
      card.roadmapIndicator[slot] &&
      !card.confirmedIndicatorSlots?.includes(slot)
  );
}

export function IndicatorApprovalControls({
  card,
  disabled,
  onConfirm,
}: {
  card: KnowledgeCard;
  disabled: boolean;
  onConfirm: (action: ConfirmIndicatorAction) => void;
}) {
  const pendingSlot = useRef<IndicatorSlot | null>(null);
  const pendingIndicator =
    isRoadmapIndicator(card) && getCardStatus(card) === "pending";
  const options = useStrategyOptions(
    pendingIndicator,
    `${card.id}:${card.updatedAt}`
  );
  if (!isRoadmapIndicator(card) || !pendingIndicator) return null;
  const documents = new Map(
    options.status === "ready"
      ? options.documents.map((item) => [item.cardId, item])
      : []
  );
  const indicator = card.roadmapIndicator;
  const scope = indicator.scope;
  const contour =
    scope.kind === "campus"
      ? "Кампус"
      : scope.kind === "university"
        ? getUniversityFullName(scope.universityId)
        : scope.label;
  return (
    <div
      className="grid gap-2 border-t border-border pt-2 sm:grid-cols-2"
      role="group"
      aria-label="Подтверждение показателя"
    >
      <p className="sm:col-span-2 text-sm whitespace-pre-wrap wrap-anywhere">
        {indicator.definition} · Контур: {contour} · Единица: {indicator.unit}
      </p>
      {options.status !== "ready" ? (
        <div className="sm:col-span-2">
          <StrategyOptionsNotice options={options} />
        </div>
      ) : null}
      {INDICATOR_SLOTS.map((slot) => {
        const measurement = indicator[slot];
        const evidence = measurement
          ? getCurrentStrategyEvidence(measurement.evidence, documents, slot)
          : null;
        const { label, action, button, confirmed } = slotStatus[slot];
        return (
          <div key={slot} className="min-w-0 space-y-1 text-sm">
            <p className="wrap-anywhere font-medium">
              {measurement
                ? `${label} · ${numberFormat.format(measurement.value)} ${indicator.unit}`
                : label}
            </p>
            {measurement ? (
              <p className="text-muted-foreground">
                {slot === "plan" ? "Срок" : "Актуально на"}{" "}
                {formatDate(measurement.date)}
              </p>
            ) : (
              <p className="text-muted-foreground">Значение не внесено</p>
            )}
            {measurement && options.status === "ready" ? (
              evidence ? (
                <>
                  <SourceView
                    evidence={measurement.evidence}
                    source={evidence.source}
                    current={evidence}
                    historical={false}
                  />
                  <p className="text-xs text-muted-foreground">
                    Редакция {evidence.source.document.edition} от{" "}
                    {formatDate(evidence.source.document.date)} ·{" "}
                    {strategyClauseKindLabels[evidence.clause.kind]}
                  </p>
                  <blockquote className="border-l-2 border-border pl-3 whitespace-pre-wrap wrap-anywhere">
                    {evidence.clause.excerpt}
                  </blockquote>
                </>
              ) : (
                <p className="text-sm text-amber-900">
                  Источник изменился или недоступен. Выберите действующую
                  выдержку.
                </p>
              )
            ) : null}
            {measurement ? (
              card.confirmedIndicatorSlots?.includes(slot) ? (
                options.status === "ready" && !evidence ? (
                  <p role="status" className="text-sm text-amber-900">
                    Подтверждение устарело. Обновите источник в карточке.
                  </p>
                ) : (
                  <p
                    className="flex min-h-11 items-center gap-2 focus-visible:outline-2 focus-visible:outline-ring"
                    role="status"
                    tabIndex={-1}
                    ref={(node) => {
                      if (node && pendingSlot.current === slot) {
                        pendingSlot.current = null;
                        node.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <CheckCircle2
                      aria-hidden="true"
                      className="size-4 shrink-0 text-emerald-700"
                    />
                    {confirmed}
                  </p>
                )
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled || !evidence}
                  onClick={() => {
                    pendingSlot.current = slot;
                    onConfirm(action);
                  }}
                >
                  {button}
                </Button>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
