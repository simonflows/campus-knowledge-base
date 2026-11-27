"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { universities } from "@/lib/data";
import {
  INDICATOR_SLOTS,
  MAX_INDICATOR_RELATED_CARDS,
  MAX_STRATEGY_LINKS,
  officialDocumentKindLabels,
  strategyClauseKindLabels,
  type IndicatorSlot,
  type OfficialDocumentData,
  type RoadmapIndicatorData,
  type StrategyLink,
} from "@/lib/strategy";
import {
  DocumentSelect,
  emptyEvidence,
  emptyReference,
  EvidenceFields,
  StrategyDisclosure,
  StrategyField,
  StrategyOptionsNotice,
  StrategySelect,
  useStrategyOptions,
} from "./strategy-inputs";

const inputClass = "min-h-11 min-w-0 font-normal";
const sectionClass = "min-w-0 space-y-3 border-t border-border pt-3";

export const blankOfficialDocument: OfficialDocumentData = {
  kind: "concept",
  sourceOrganization: "",
  url: "",
  date: "",
  edition: "",
  directions: [],
  clauses: [],
};

export function OfficialDocumentEditor({
  value,
  onChange,
}: {
  value: OfficialDocumentData;
  onChange: (value: OfficialDocumentData) => void;
}) {
  const patch = (fields: Partial<OfficialDocumentData>) =>
    onChange({ ...value, ...fields });

  return (
    <section className="space-y-4" aria-label="Данные официального документа">
      <div className="grid gap-3 sm:grid-cols-2">
        <StrategyField label="Вид документа">
          <StrategySelect
            value={value.kind}
            onChange={(event) =>
              patch({
                kind: event.target.value as OfficialDocumentData["kind"],
              })
            }
          >
            {Object.entries(officialDocumentKindLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </StrategySelect>
        </StrategyField>
        <StrategyField label="Организация-источник">
          <Input
            className={inputClass}
            required
            maxLength={200}
            value={value.sourceOrganization}
            onChange={(event) =>
              patch({ sourceOrganization: event.target.value })
            }
          />
        </StrategyField>
        <StrategyField label="Ссылка на официальный документ">
          <Input
            className={inputClass}
            required
            type="url"
            maxLength={2048}
            value={value.url}
            onChange={(event) => patch({ url: event.target.value })}
          />
        </StrategyField>
        <StrategyField label="Дата документа">
          <Input
            className={inputClass}
            required
            type="date"
            value={value.date}
            onChange={(event) => patch({ date: event.target.value })}
          />
        </StrategyField>
        <StrategyField label="Редакция документа">
          <Input
            className={inputClass}
            required
            maxLength={160}
            value={value.edition}
            onChange={(event) => patch({ edition: event.target.value })}
          />
        </StrategyField>
      </div>

      <StrategyDisclosure
        title="Направления документа"
        count={value.directions.length}
      >
        {!value.directions.length ? (
          <p className="text-sm text-muted-foreground">
            Добавьте направления, по которым будут искать связанные проекты.
          </p>
        ) : null}
        {value.directions.map((direction, index) => (
          <div className="flex items-end gap-2" key={direction.id}>
            <div className="min-w-0 flex-1">
              <StrategyField label="Название направления">
                <Input
                  className={inputClass}
                  maxLength={200}
                  value={direction.title}
                  onChange={(event) =>
                    patch({
                      directions: value.directions.map((item) =>
                        item.id === direction.id
                          ? { ...item, title: event.target.value }
                          : item
                      ),
                    })
                  }
                />
              </StrategyField>
            </div>
            <RemoveButton
              label={`Удалить направление ${index + 1}`}
              onClick={() =>
                patch({
                  directions: value.directions.filter(
                    (item) => item.id !== direction.id
                  ),
                  clauses: value.clauses.map((clause) => ({
                    ...clause,
                    directionIds: clause.directionIds.filter(
                      (id) => id !== direction.id
                    ),
                  })),
                })
              }
            />
          </div>
        ))}
        <AddButton
          disabled={value.directions.length >= 32}
          onClick={() =>
            patch({
              directions: [
                ...value.directions,
                { id: crypto.randomUUID(), title: "" },
              ],
            })
          }
        >
          Добавить направление
        </AddButton>
      </StrategyDisclosure>

      <StrategyDisclosure
        title="Проверенные выдержки"
        count={value.clauses.length}
      >
        {!value.clauses.length ? (
          <p className="text-sm text-muted-foreground">
            Укажите пункт и приведите короткую выдержку с сохранением контекста.
          </p>
        ) : null}
        {value.clauses.map((clause, index) => {
          const changeClause = (fields: Partial<typeof clause>) =>
            patch({
              clauses: value.clauses.map((item) =>
                item.id === clause.id ? { ...item, ...fields } : item
              ),
            });
          return (
            <fieldset key={clause.id} className={sectionClass}>
              <legend className="pr-2 font-medium">Выдержка {index + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <StrategyField label="Пункт или страница">
                  <Input
                    className={inputClass}
                    maxLength={200}
                    value={clause.locator}
                    onChange={(event) =>
                      changeClause({ locator: event.target.value })
                    }
                  />
                </StrategyField>
                <StrategyField label="Что подтверждает выдержка">
                  <StrategySelect
                    value={clause.kind}
                    onChange={(event) =>
                      changeClause({
                        kind: event.target.value as typeof clause.kind,
                      })
                    }
                  >
                    {Object.entries(strategyClauseKindLabels).map(
                      ([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      )
                    )}
                  </StrategySelect>
                </StrategyField>
              </div>
              <StrategyField label="Текст выдержки">
                <Textarea
                  className="font-normal"
                  maxLength={1200}
                  value={clause.excerpt}
                  onChange={(event) =>
                    changeClause({ excerpt: event.target.value })
                  }
                />
              </StrategyField>
              {value.directions.length > 0 ? (
                <fieldset className="min-w-0">
                  <legend className="text-sm font-medium">
                    Связанные направления
                  </legend>
                  <div className="grid gap-x-5 sm:grid-cols-2">
                    {value.directions.map((direction) => {
                      const selected = clause.directionIds.includes(
                        direction.id
                      );
                      return (
                        <label
                          key={direction.id}
                          className="flex min-h-11 min-w-0 items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 accent-primary"
                            checked={selected}
                            disabled={
                              !selected && clause.directionIds.length >= 12
                            }
                            onChange={() =>
                              changeClause({
                                directionIds: selected
                                  ? clause.directionIds.filter(
                                      (id) => id !== direction.id
                                    )
                                  : [...clause.directionIds, direction.id],
                              })
                            }
                          />
                          <span className="wrap-anywhere">
                            {direction.title || "Направление без названия"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ) : null}
              <RemoveButton
                label={`Удалить выдержку ${index + 1}`}
                onClick={() =>
                  patch({
                    clauses: value.clauses.filter(
                      (item) => item.id !== clause.id
                    ),
                  })
                }
              />
            </fieldset>
          );
        })}
        <AddButton
          disabled={value.clauses.length >= 40}
          onClick={() =>
            patch({
              clauses: [
                ...value.clauses,
                {
                  id: crypto.randomUUID(),
                  locator: "",
                  excerpt: "",
                  kind: "context",
                  directionIds: [],
                },
              ],
            })
          }
        >
          Добавить выдержку
        </AddButton>
      </StrategyDisclosure>
    </section>
  );
}

type MeasurementDraft = Omit<
  NonNullable<RoadmapIndicatorData["plan"]>,
  "value"
> & { value: string };
type IndicatorDraft = Omit<RoadmapIndicatorData, IndicatorSlot> &
  Record<IndicatorSlot, MeasurementDraft>;
const emptyMeasurement: MeasurementDraft = {
  value: "",
  date: "",
  evidence: emptyEvidence,
};

export function indicatorDraft(
  indicator?: RoadmapIndicatorData
): IndicatorDraft {
  const draftSlot = (slot: IndicatorSlot) =>
    indicator?.[slot]
      ? { ...indicator[slot], value: String(indicator[slot].value) }
      : emptyMeasurement;
  return {
    definition: indicator?.definition ?? "",
    unit: indicator?.unit ?? "",
    scope: indicator?.scope ?? { kind: "campus" },
    relatedCardIds: indicator?.relatedCardIds ?? [],
    plan: draftSlot("plan"),
    actual: draftSlot("actual"),
  };
}

export function indicatorDraftError(indicator: IndicatorDraft): string | null {
  for (const slot of INDICATOR_SLOTS) {
    const draft = indicator[slot];
    if (
      !draft.value.trim() &&
      (draft.date || draft.evidence.clauseId || draft.evidence.document.cardId)
    ) {
      return `${slot === "plan" ? "План" : "Факт"}: введите значение или очистите весь блок.`;
    }
  }
  return null;
}

export function indicatorPayload({
  plan,
  actual,
  ...indicator
}: IndicatorDraft): RoadmapIndicatorData {
  const measurement = (draft: MeasurementDraft) => {
    const text = draft.value.trim();
    const numeric = Number(text.replace(",", "."));
    const underflow = numeric === 0 && /[1-9]/u.test(text.split(/e/iu)[0]);
    return text
      ? {
          ...draft,
          value: /^[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?$/iu.test(text)
            ? underflow
              ? Number.NaN
              : numeric
            : Number.NaN,
        }
      : draft.date || draft.evidence.clauseId || draft.evidence.document.cardId
        ? { ...draft, value: Number.NaN }
        : undefined;
  };
  return { ...indicator, plan: measurement(plan), actual: measurement(actual) };
}

export function RoadmapIndicatorEditor({
  value,
  onChange,
  enabled,
}: {
  value: IndicatorDraft;
  onChange: (value: IndicatorDraft) => void;
  enabled: boolean;
}) {
  const options = useStrategyOptions(enabled);
  const [initiallyOpen] = useState(() => ({
    plan: Boolean(value.plan.value),
    actual: Boolean(value.actual.value),
  }));
  const scope = value.scope;
  const relatedCards = options.status === "ready" ? options.relatedCards : [];
  const patch = (fields: Partial<IndicatorDraft>) =>
    onChange({ ...value, ...fields });

  return (
    <section className="space-y-4" aria-label="Данные показателя">
      <StrategyField label="Определение показателя">
        <Textarea
          className="font-normal"
          required
          maxLength={1000}
          value={value.definition}
          onChange={(event) => patch({ definition: event.target.value })}
        />
      </StrategyField>
      <div className="grid gap-3 sm:grid-cols-2">
        <StrategyField label="Единица измерения">
          <Input
            className={inputClass}
            required
            maxLength={80}
            value={value.unit}
            onChange={(event) => patch({ unit: event.target.value })}
          />
        </StrategyField>
        <StrategyField label="Контур показателя">
          <StrategySelect
            value={scope.kind}
            onChange={(event) =>
              patch({
                scope:
                  event.target.value === "university"
                    ? { kind: "university", universityId: "" }
                    : event.target.value === "other"
                      ? { kind: "other", label: "" }
                      : { kind: "campus" },
              })
            }
          >
            <option value="campus">Кампус</option>
            <option value="university">Площадка вуза</option>
            <option value="other">Другой контур</option>
          </StrategySelect>
        </StrategyField>
        {scope.kind === "university" ? (
          <StrategyField label="Вуз-резидент">
            <StrategySelect
              required
              value={scope.universityId}
              onChange={(event) =>
                patch({
                  scope: {
                    kind: "university",
                    universityId: event.target.value,
                  },
                })
              }
            >
              <option value="">Выберите вуз</option>
              {universities.map((university) => (
                <option value={university.id} key={university.id}>
                  {university.fullName}
                </option>
              ))}
            </StrategySelect>
          </StrategyField>
        ) : null}
        {scope.kind === "other" ? (
          <StrategyField label="Название контура">
            <Input
              className={inputClass}
              required
              maxLength={200}
              value={scope.label}
              onChange={(event) =>
                patch({ scope: { kind: "other", label: event.target.value } })
              }
            />
          </StrategyField>
        ) : null}
      </div>
      <StrategyOptionsNotice options={options} />
      {INDICATOR_SLOTS.map((slot) => {
        const measurement = value[slot];
        const changeSlot = (fields: Partial<MeasurementDraft>) =>
          patch({ [slot]: { ...measurement, ...fields } });
        const label = slot === "plan" ? "План" : "Факт";
        return (
          <StrategyDisclosure
            key={slot}
            title={label}
            open={initiallyOpen[slot]}
          >
            <p className="text-sm text-muted-foreground">
              Если данных нет, оставьте весь блок пустым. Ноль — отдельное
              значение.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <StrategyField
                label={
                  slot === "plan" ? "Плановое значение" : "Фактическое значение"
                }
              >
                <Input
                  className={inputClass}
                  inputMode="decimal"
                  maxLength={40}
                  value={measurement.value}
                  onChange={(event) =>
                    changeSlot({ value: event.target.value })
                  }
                />
              </StrategyField>
              <StrategyField
                label={
                  slot === "plan" ? "Плановый срок" : "Дата актуальности факта"
                }
              >
                <Input
                  className={inputClass}
                  type="date"
                  value={measurement.date}
                  onChange={(event) => changeSlot({ date: event.target.value })}
                />
              </StrategyField>
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => patch({ [slot]: { ...emptyMeasurement } })}
            >
              Очистить {slot === "plan" ? "план" : "факт"}
            </Button>
            {options.status === "ready" ? (
              <EvidenceFields
                evidence={measurement.evidence}
                documents={options.documents}
                kind={slot}
                onChange={(evidence) => changeSlot({ evidence })}
              />
            ) : null}
          </StrategyDisclosure>
        );
      })}
      <StrategyDisclosure
        title="Связанные проекты и объекты"
        count={value.relatedCardIds.length}
      >
        {value.relatedCardIds.map((id) => (
          <div className="flex items-center justify-between gap-2" key={id}>
            <p className="min-w-0 wrap-anywhere text-sm">
              {relatedCards.find((card) => card.cardId === id)?.title ??
                "Связанная карточка недоступна"}
            </p>
            <RemoveButton
              label="Убрать связанную карточку"
              onClick={() =>
                patch({
                  relatedCardIds: value.relatedCardIds.filter(
                    (item) => item !== id
                  ),
                })
              }
            />
          </div>
        ))}
        {relatedCards.length ? (
          <StrategyField label="Добавить проект или объект">
            <StrategySelect
              value=""
              disabled={
                value.relatedCardIds.length >= MAX_INDICATOR_RELATED_CARDS
              }
              onChange={(event) => {
                if (event.target.value)
                  patch({
                    relatedCardIds: [
                      ...value.relatedCardIds,
                      event.target.value,
                    ],
                  });
              }}
            >
              <option value="">Выберите карточку</option>
              {relatedCards
                .filter((card) => !value.relatedCardIds.includes(card.cardId))
                .map((card) => (
                  <option value={card.cardId} key={card.cardId}>
                    {card.title}
                  </option>
                ))}
            </StrategySelect>
          </StrategyField>
        ) : options.status === "ready" ? (
          <p className="text-sm text-muted-foreground">
            Нет доступных утверждённых проектов или объектов.
          </p>
        ) : null}
      </StrategyDisclosure>
    </section>
  );
}

type StrategyLinkDraft = StrategyLink & { key: string };

export function strategyLinkDrafts(
  links: StrategyLink[] = []
): StrategyLinkDraft[] {
  return links.map((link, index) => ({ ...link, key: `existing-${index}` }));
}

export function strategyLinkPayload(
  links: StrategyLinkDraft[]
): StrategyLink[] {
  return links.map(({ key: _key, ...link }) => link);
}

export function StrategyLinksEditor({
  links,
  onChange,
  enabled,
}: {
  links: StrategyLinkDraft[];
  onChange: (links: StrategyLinkDraft[]) => void;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = useStrategyOptions(enabled && open);
  return (
    <StrategyDisclosure
      title="Связь со стратегией и дорожной картой"
      count={links.length}
      onToggle={setOpen}
    >
      {open ? <StrategyOptionsNotice options={options} /> : null}
      {!links.length &&
      options.status === "ready" &&
      options.documents.length ? (
        <p className="text-sm text-muted-foreground">
          При необходимости укажите, к какому пункту или направлению относится
          карточка.
        </p>
      ) : null}
      {links.map((link, index) => {
        const documents = options.status === "ready" ? options.documents : [];
        const document = documents.find(
          (item) =>
            item.cardId === link.document.cardId &&
            item.versionId === link.document.versionId
        )?.document;
        const directions = document?.directions ?? [];
        const clauses =
          document?.clauses.filter(
            (clause) =>
              !link.directionId ||
              clause.directionIds.includes(link.directionId)
          ) ?? [];
        const changeLink = (fields: Partial<StrategyLink>) =>
          onChange(
            links.map((item) =>
              item.key === link.key ? { ...item, ...fields } : item
            )
          );

        return (
          <fieldset key={link.key} className={sectionClass}>
            <legend className="pr-2 font-medium">Связь {index + 1}</legend>
            {options.status === "ready" ? (
              <>
                <DocumentSelect
                  label="Документ стратегии или дорожной карты"
                  reference={link.document}
                  documents={documents}
                  onChange={(document) =>
                    changeLink({
                      document,
                      directionId: undefined,
                      clauseId: undefined,
                    })
                  }
                />
                {document ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <StrategyField label="Направление">
                      <StrategySelect
                        value={link.directionId ?? ""}
                        disabled={!directions.length}
                        onChange={(event) => {
                          const directionId = event.target.value || undefined;
                          const clause = document.clauses.find(
                            (item) => item.id === link.clauseId
                          );
                          changeLink({
                            directionId,
                            clauseId:
                              directionId &&
                              !clause?.directionIds.includes(directionId)
                                ? undefined
                                : link.clauseId,
                          });
                        }}
                      >
                        <option value="">Без указания направления</option>
                        {directions.map((direction) => (
                          <option key={direction.id} value={direction.id}>
                            {direction.title}
                          </option>
                        ))}
                      </StrategySelect>
                    </StrategyField>
                    <StrategyField label="Пункт документа">
                      <StrategySelect
                        value={link.clauseId ?? ""}
                        disabled={!clauses.length}
                        onChange={(event) =>
                          changeLink({
                            clauseId: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">Без указания пункта</option>
                        {clauses.map((clause) => (
                          <option key={clause.id} value={clause.id}>
                            {clause.locator}
                          </option>
                        ))}
                      </StrategySelect>
                    </StrategyField>
                    {!directions.length && !clauses.length ? (
                      <p className="text-sm text-muted-foreground sm:col-span-2">
                        В документе пока нет направлений и проверенных выдержек.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <EvidenceFields
                  evidence={link.evidence}
                  documents={documents}
                  onChange={(evidence) => changeLink({ evidence })}
                />
              </>
            ) : null}
            <StrategyField label="Как карточка связана с документом">
              <Textarea
                className="font-normal"
                maxLength={500}
                value={link.explanation}
                onChange={(event) =>
                  changeLink({ explanation: event.target.value })
                }
              />
            </StrategyField>
            <RemoveButton
              label={`Убрать связь ${index + 1}`}
              onClick={() =>
                onChange(links.filter((item) => item.key !== link.key))
              }
            />
          </fieldset>
        );
      })}
      {options.status === "ready" &&
      options.documents.some(({ document }) => document.clauses.length > 0) ? (
        <AddButton
          disabled={links.length >= MAX_STRATEGY_LINKS}
          onClick={() =>
            onChange([
              ...links,
              {
                key: crypto.randomUUID(),
                document: emptyReference,
                evidence: emptyEvidence,
                explanation: "",
              },
            ])
          }
        >
          Добавить связь
        </AddButton>
      ) : options.status === "ready" && options.documents.length ? (
        <p className="text-sm text-muted-foreground">
          Для подтверждения связи нужна проверенная выдержка в одном из
          документов.
        </p>
      ) : null}
    </StrategyDisclosure>
  );
}

function AddButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 max-w-full"
      onClick={onClick}
      disabled={disabled}
    >
      <Plus aria-hidden="true" />
      {children}
    </Button>
  );
}

function RemoveButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="size-11 shrink-0 text-muted-foreground"
      aria-label={label}
      onClick={onClick}
    >
      <X aria-hidden="true" />
    </Button>
  );
}
