"use client";

import { useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { flattenArticleChunks } from "@/lib/articles";
import {
  approvedDemoCards,
  type BrowserDemoState,
  demoArticles,
  type DemoDocument,
  demoUser,
  getDemoError,
  moderateDemoDocument,
  saveDemoDocument,
  visibleDemoDocuments,
} from "@/lib/browser-demo";
import {
  buildDeterministicArticleDraft,
  isGroundedArticleText,
} from "@/lib/editor";
import { type EditorialContent, editorialContentSchema } from "@/lib/editorial";
import type { KnowledgeCard } from "@/lib/knowledge";
import type { UpdateDemo } from "./browser-demo";

const documentLabels: Record<DemoDocument["status"], string> = {
  draft: "Черновик",
  submitted: "На согласовании",
  approved: "Учебная публикация",
  returned: "На доработке",
};

const selectClass =
  "min-h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

export function DemoEditor({
  state,
  update,
}: {
  state: BrowserDemoState;
  update: UpdateDemo;
}) {
  const user = demoUser(state);
  const [selected, select] = useState<string | null>(null);
  const [newKey, setNewKey] = useState(0);
  const [notice, setNotice] = useState("");
  const documents = visibleDemoDocuments(state);
  const document = documents.find((item) => item.id === selected) ?? null;

  if (user.role === "guest") {
    return (
      <p className="rounded-xl border bg-card p-4">
        Выберите учебную роль сотрудника, чтобы сохранять черновики.
      </p>
    );
  }

  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby="demo-editor-heading"
    >
      <div>
        <h2 id="demo-editor-heading" className="text-2xl font-semibold">
          Учебный редактор
        </h2>
        <p className="text-sm text-muted-foreground">
          Черновик собирается из выбранной карточки и проверенных фрагментов
          библиотеки. Внешняя нейросеть не используется.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={!selected ? "default" : "outline"}
          onClick={() => {
            select(null);
            setNewKey((key) => key + 1);
          }}
        >
          Новый материал
        </Button>
        {documents.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={item.id === selected ? "default" : "outline"}
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            onClick={() => select(item.id)}
          >
            {item.content.title || "Без заголовка"} ·{" "}
            {documentLabels[item.status]}
          </Button>
        ))}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <DemoDraft
        key={
          document ? `${document.id}:${document.updatedAt}` : `new-${newKey}`
        }
        state={state}
        document={document}
        update={update}
        onSaved={select}
        onNotice={setNotice}
      />
    </section>
  );
}

function DemoDraft({
  state,
  document,
  update,
  onSaved,
  onNotice,
}: {
  state: BrowserDemoState;
  document: DemoDocument | null;
  update: UpdateDemo;
  onSaved: (id: string) => void;
  onNotice: (message: string) => void;
}) {
  const user = demoUser(state);
  const cards = approvedDemoCards(state);
  const [sourceId, setSourceId] = useState(
    document?.content.sourceCardIds[0] ??
      cards.find((card) => card.type === "project")?.id ??
      ""
  );
  const [basisId, setBasisId] = useState("");
  const [content, setContent] = useState<EditorialContent>(
    () => document?.content ?? editorialContentSchema.parse({})
  );
  const [notice, setNotice] = useState("");
  const canEdit =
    !document ||
    (document.author === user.id &&
      ["draft", "returned"].includes(document.status));
  const canReview =
    document?.status === "submitted" &&
    user.role === "admin" &&
    user.id !== document.author;
  const articles = demoArticles(state);

  function generate() {
    try {
      const card = cards.find((item) => item.id === sourceId);
      if (!card) throw new Error("Выберите утверждённую учебную карточку.");
      const reference = articles.find((article) => article.id === basisId);
      const sources: KnowledgeCard[] = [card];
      for (const id of reference?.sourceCardIds ?? []) {
        const source = cards.find((item) => item.id === id);
        if (source && !sources.some((item) => item.id === id))
          sources.push(source);
      }
      const articleSources = sources.filter((source) =>
        reference?.sourceCardIds.includes(source.id)
      );
      const chunks = reference
        ? flattenArticleChunks(reference).filter((chunk) =>
            isGroundedArticleText(chunk.content, articleSources)
          )
        : [];
      const draft = buildDeterministicArticleDraft({
        query: card.title,
        selectedCards: sources,
        matchedArticles: reference && chunks.length ? [reference] : [],
        referenceChunks: chunks,
      });
      setContent(
        editorialContentSchema.parse({
          ...draft,
          universityId: draft.suggestedUniversityId ?? "",
        })
      );
      setNotice(
        reference && chunks.length === 0
          ? "Черновик собран из карточек. Для фрагментов выбранной статьи не нашлось подтверждения в учебной базе."
          : "Учебный черновик подготовлен из выбранных источников."
      );
    } catch (error) {
      setNotice(getDemoError(error));
    }
  }

  function save() {
    try {
      const payload =
        content.sourceCardIds.length || !sourceId
          ? content
          : { ...content, sourceCardIds: [sourceId] };
      let id: string | undefined;
      update((current) => {
        const result = saveDemoDocument(current, payload, document);
        id = result.document.id;
        return result.state;
      });
      if (id) {
        onSaved(id);
        onNotice("Черновик сохранён в браузере.");
      }
    } catch (error) {
      setNotice(getDemoError(error));
    }
  }

  function moderate(action: "submit" | "approve" | "return") {
    if (!document) return;
    try {
      update((current) => moderateDemoDocument(current, document.id, action));
      if (action !== "submit") onSaved(document.id);
      onNotice(
        action === "submit"
          ? "Черновик ожидает решения учебного координатора."
          : action === "approve"
            ? "Материал появился в учебной библиотеке."
            : "Материал возвращён автору на доработку."
      );
    } catch (error) {
      setNotice(getDemoError(error));
    }
  }

  function addSection() {
    setContent((previous) => ({
      ...previous,
      sections: [
        ...previous.sections,
        {
          id: crypto.randomUUID(),
          heading: "",
          level: 2,
          chunks: [{ id: crypto.randomUUID(), content: "" }],
        },
      ],
    }));
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          {document
            ? documentLabels[document.status]
            : "Новый учебный материал"}
        </CardTitle>
        {canEdit && (
          <CardDescription>
            Сохраните черновик, отправьте его на согласование и переключитесь на
            координатора.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {canEdit && (
          <div className="grid min-w-0 gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <label className="min-w-0 space-y-1 text-sm">
              <span>Карточка-источник</span>
              <select
                className={selectClass}
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">Выберите карточку</option>
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 space-y-1 text-sm">
              <span>Опора из библиотеки</span>
              <select
                className={selectClass}
                value={basisId}
                onChange={(event) => setBasisId(event.target.value)}
              >
                <option value="">Только карточка</option>
                {articles.map((article) => (
                  <option key={article.id} value={article.id}>
                    {article.title}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={!sourceId}
              onClick={generate}
            >
              Собрать из источников
            </Button>
          </div>
        )}
        <label className="block space-y-1 text-sm">
          <span>Заголовок (H1)</span>
          <Input
            value={content.title}
            readOnly={!canEdit}
            maxLength={240}
            onChange={(event) =>
              setContent({ ...content, title: event.target.value })
            }
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Лид · {content.lead.length}/1000</span>
          <Textarea
            value={content.lead}
            readOnly={!canEdit}
            maxLength={1000}
            rows={4}
            onChange={(event) =>
              setContent({ ...content, lead: event.target.value })
            }
          />
        </label>
        {content.sections.map((section, index) => (
          <fieldset
            key={section.id}
            className="min-w-0 space-y-2 rounded-lg border p-3"
          >
            <legend className="px-1 text-sm">Раздел {index + 1}</legend>
            <label className="block space-y-1 text-sm">
              <span>Подзаголовок</span>
              <Input
                value={section.heading}
                readOnly={!canEdit}
                maxLength={300}
                onChange={(event) => {
                  const heading = event.target.value;
                  setContent((current) => ({
                    ...current,
                    sections: current.sections.map((item) =>
                      item.id === section.id ? { ...item, heading } : item
                    ),
                  }));
                }}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Уровень подзаголовка</span>
              <select
                className={selectClass}
                disabled={!canEdit}
                value={section.level}
                onChange={(event) => {
                  const level = event.target.value === "3" ? 3 : 2;
                  setContent((current) => ({
                    ...current,
                    sections: current.sections.map((item) =>
                      item.id === section.id ? { ...item, level } : item
                    ),
                  }));
                }}
              >
                <option value="2">H2</option>
                <option value="3">H3</option>
              </select>
            </label>
            {section.chunks.map((chunk, chunkIndex) => (
              <label className="block space-y-1 text-sm" key={chunk.id}>
                <span>Абзац {chunkIndex + 1}</span>
                <Textarea
                  value={chunk.content}
                  readOnly={!canEdit}
                  maxLength={4000}
                  rows={3}
                  onChange={(event) => {
                    const text = event.target.value;
                    setContent((current) => ({
                      ...current,
                      sections: current.sections.map((item) =>
                        item.id === section.id
                          ? {
                              ...item,
                              chunks: item.chunks.map((part) =>
                                part.id === chunk.id
                                  ? { ...part, content: text }
                                  : part
                              ),
                            }
                          : item
                      ),
                    }));
                  }}
                />
              </label>
            ))}
          </fieldset>
        ))}
        {content.sourceCardTitles.length > 0 && (
          <p className="text-sm break-words text-muted-foreground">
            Источники · {content.sourceCardTitles.join(", ")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={content.sections.length >= 20}
                onClick={addSection}
              >
                Добавить раздел
              </Button>
              <Button type="button" onClick={save}>
                Сохранить в браузере
              </Button>
            </>
          )}
          {canEdit && document && user.role !== "admin" && (
            <Button
              type="button"
              variant="outline"
              disabled={
                JSON.stringify(content) !== JSON.stringify(document.content)
              }
              onClick={() => moderate("submit")}
            >
              Отправить сохранённый черновик
            </Button>
          )}
          {canReview && (
            <>
              <Button type="button" onClick={() => moderate("approve")}>
                Согласовать материал
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => moderate("return")}
              >
                Вернуть на доработку
              </Button>
            </>
          )}
        </div>
        {notice && (
          <p role="status" className="break-words text-sm">
            {notice}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function DemoLibrary({
  state,
  openCard,
}: {
  state: BrowserDemoState;
  openCard: (id: string) => void;
}) {
  const articles = demoArticles(state);

  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby="demo-library-heading"
    >
      <h2 id="demo-library-heading" className="text-2xl font-semibold">
        Учебная библиотека
      </h2>
      {articles.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Согласованные учебные материалы появятся здесь.
        </p>
      )}
      {articles.map((article) => (
        <Card key={article.id} className="min-w-0 break-words">
          <CardHeader>
            <Badge variant="outline">
              {article.originalDraftId || article.id.startsWith("demo-doc-")
                ? "Сохранено в этом браузере"
                : "Учебный пример"}
            </Badge>
            <CardTitle className="text-xl">{article.title}</CardTitle>
            <CardDescription>{article.lead}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Читать материал
              </summary>
              <div className="mt-3 space-y-4">
                {article.sections.map((section) => (
                  <section key={section.id} className="space-y-1">
                    {section.level === 2 ? (
                      <h3 className="font-semibold">{section.heading}</h3>
                    ) : (
                      <h4 className="font-semibold">{section.heading}</h4>
                    )}
                    {section.chunks.map((chunk) => (
                      <p key={chunk.id} className="whitespace-pre-wrap">
                        {chunk.content}
                      </p>
                    ))}
                  </section>
                ))}
              </div>
            </details>
            <div className="flex flex-wrap gap-2">
              {article.sourceCardIds.map((id, index) => (
                <Button
                  key={id}
                  type="button"
                  variant="outline"
                  className="h-auto min-h-8 max-w-full whitespace-normal"
                  onClick={() => openCard(id)}
                >
                  {article.sourceCardTitles[index] ?? id}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
