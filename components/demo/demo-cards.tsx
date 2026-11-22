"use client";

import { useState } from "react";

import { KnowledgeCardForm } from "@/components/knowledge/knowledge-card-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { canCreateCard } from "@/lib/auth";
import {
  approvedDemoCards,
  type BrowserDemoState,
  canConfirmDemoParticipation,
  canEditDemoCard,
  DEMO_EXERCISE_ID,
  demoUser,
  getDemoError,
  moderateDemoCard,
  saveDemoCard,
  visibleDemoCards,
} from "@/lib/browser-demo";
import { universities } from "@/lib/data";
import {
  cardStatusLabels,
  folderIds,
  getCardsForFolder,
  getCardStatus,
  getCardTypeLabel,
  getRequiredUniversityApprovals,
  getUniversityName,
  type KnowledgeCard,
} from "@/lib/knowledge";
import { searchKnowledgeCards } from "@/lib/knowledge-search";
import type { KnowledgeCardInput } from "@/lib/validation/knowledge";
import type { UpdateDemo } from "./browser-demo";

export function DemoCards({
  state,
  update,
  selected,
  onSelect,
}: {
  state: BrowserDemoState;
  update: UpdateDemo;
  selected: { id: string; approved: boolean } | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [form, setForm] = useState<"new" | "edit" | null>(null);
  const [notice, setNotice] = useState("");
  const user = demoUser(state);
  const visible = visibleDemoCards(state);
  const scoped = folder ? getCardsForFolder(folder, visible) : visible;
  const matching = query.trim() ? searchKnowledgeCards(scoped, query) : scoped;
  const exercise = visible.find((card) => card.id === DEMO_EXERCISE_ID);
  const reference = selected?.approved
    ? approvedDemoCards(state).find((item) => item.id === selected.id)
    : null;
  const card =
    reference ??
    visible.find((item) => item.id === selected?.id) ??
    exercise ??
    visible[0];
  const pending = card && getCardStatus(card) === "pending";
  const canApprove = pending && user.role === "admin";
  const approvals = card ? getRequiredUniversityApprovals(card) : [];
  const allConfirmed = approvals.every((id) =>
    card?.participantApprovals?.includes(id)
  );

  function review(action: "confirm" | "approve" | "return") {
    if (!card) return;
    try {
      update((current) => moderateDemoCard(current, card.id, action));
      setNotice(
        action === "confirm"
          ? "Участие в учебном проекте подтверждено."
          : action === "approve"
            ? "Учебная карточка утверждена."
            : "Карточка возвращена на доработку."
      );
    } catch (error) {
      setNotice(getDemoError(error));
    }
  }

  async function saveCard(
    input: KnowledgeCardInput,
    initial: KnowledgeCard | null
  ) {
    let saved: KnowledgeCard | undefined;
    update((current) => {
      const result = saveDemoCard(current, input, initial);
      saved = result.card;
      return result.state;
    });
    if (!saved) throw new Error("Карточка не сохранена.");
    return saved;
  }

  function onSaved(saved: KnowledgeCard) {
    onSelect(saved.id);
    setForm(null);
    setNotice(
      "Карточка сохранена в браузере и доступна для учебного согласования."
    );
  }

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="demo-cards-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="demo-cards-heading" className="text-2xl font-semibold">
            Учебные карточки
          </h2>
          <p className="text-sm text-muted-foreground">
            Для согласования учебного проекта переключитесь на владельцев МИДиС
            и ЮУГМУ, затем на координатора.
          </p>
        </div>
        {canCreateCard(user) && (
          <Button type="button" onClick={() => setForm("new")}>
            Новая карточка
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {((form === "new" && canCreateCard(user)) ||
        (form === "edit" &&
          card &&
          !reference &&
          card.type !== "custom" &&
          canEditDemoCard(state, card))) && (
        <KnowledgeCardForm
          key={`${state.profile}:${form === "new" ? "new" : card?.id}`}
          cards={visible}
          customTypes={[]}
          dbAvailable
          currentUser={user}
          initialCard={form === "edit" ? card : null}
          onCreated={onSaved}
          onUpdated={onSaved}
          onCancel={() => setForm(null)}
          saveCard={saveCard}
        />
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Найти карточку</CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 space-y-3">
            <label htmlFor="demo-card-query" className="sr-only">
              Поиск учебных карточек
            </label>
            <Input
              id="demo-card-query"
              placeholder="Название, тема или оборудование"
              value={query}
              maxLength={500}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label htmlFor="demo-card-folder" className="sr-only">
              Раздел учебных карточек
            </label>
            <select
              id="demo-card-folder"
              className="min-h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            >
              <option value="">Все разделы</option>
              <option value={folderIds.joint}>Совместные проекты</option>
              {universities.map((university) => (
                <option
                  key={university.id}
                  value={`01_universities/${university.id}`}
                >
                  {university.shortName}
                </option>
              ))}
            </select>
            {matching.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Подходящих карточек нет.
              </p>
            ) : (
              <ul className="max-h-[30rem] space-y-1 overflow-y-auto pr-1">
                {[...matching]
                  .sort(
                    (a, b) =>
                      Number(b.id === DEMO_EXERCISE_ID) -
                      Number(a.id === DEMO_EXERCISE_ID)
                  )
                  .map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={card?.id === item.id}
                        className="w-full rounded-md border border-transparent p-2 text-left text-sm break-words hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-border aria-pressed:bg-muted"
                        onClick={() => {
                          onSelect(item.id);
                          setForm(null);
                          setNotice("");
                        }}
                      >
                        {item.title}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
        {card && (
          <Card className="min-w-0">
            <CardHeader>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{getCardTypeLabel(card, [])}</Badge>
                <Badge variant="outline">
                  {cardStatusLabels[getCardStatus(card)]}
                </Badge>
              </div>
              <CardTitle className="mt-2 text-xl break-words">
                {card.title}
              </CardTitle>
              <CardDescription>
                Учебная копия · редакция {card.updatedAt.slice(0, 10)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 break-words">
              <p>{card.referenceDescription}</p>
              {card.type === "laboratory" && card.equipment.length > 0 && (
                <p className="text-sm">
                  <strong>Оборудование</strong> · {card.equipment.join(", ")}
                </p>
              )}
              {card.type === "project" && card.confirmedFigures.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {card.confirmedFigures.map((figure, index) => (
                    <li key={index}>{figure}</li>
                  ))}
                </ul>
              )}
              {approvals.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {approvals.map((id) => (
                    <li key={id}>
                      {getUniversityName(id)} ·{" "}
                      {card.participantApprovals?.includes(id)
                        ? "участие подтверждено"
                        : pending
                          ? "ожидает подтверждения"
                          : "участник"}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {!reference &&
                  card.type !== "custom" &&
                  canEditDemoCard(state, card) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setForm("edit")}
                    >
                      Редактировать
                    </Button>
                  )}
                {canConfirmDemoParticipation(state, card) && (
                  <Button type="button" onClick={() => review("confirm")}>
                    Подтвердить участие
                  </Button>
                )}
                {canApprove && (
                  <>
                    <Button
                      type="button"
                      disabled={!allConfirmed}
                      onClick={() => review("approve")}
                    >
                      Утвердить карточку
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => review("return")}
                    >
                      Вернуть на доработку
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}
