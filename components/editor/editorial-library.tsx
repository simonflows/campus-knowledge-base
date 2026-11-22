"use client";

import { useEffect, useRef, useState } from "react";
import { AppLink as Link } from "@/components/navigation/workspace-navigation";
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  FileText,
  Plus,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  articleBasisLocation,
  articleBasisReference,
  flattenArticleChunks,
  hasCurrentArticleBasis,
  isApprovedArticle,
  type ArticleBasisReference,
  type ReadyArticle,
} from "@/lib/articles";

const articleDate = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Yekaterinburg",
});

type Props = {
  articles: ReadyArticle[];
  legacy: ReadyArticle[];
  busy: boolean;
  onImport?: (article: ReadyArticle) => Promise<void>;
  onUseBlock?: (block: ArticleBasisReference) => void;
  focusedArticleId?: string;
};

function Publication({
  article,
  action,
  focused = false,
  busy = false,
  onUseBlock,
  articles = [],
}: {
  article: ReadyArticle;
  action?: React.ReactNode;
  focused?: boolean;
  busy?: boolean;
  onUseBlock?: Props["onUseBlock"];
  articles?: ReadyArticle[];
}) {
  const heading = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) heading.current?.focus({ preventScroll: true });
  }, [focused]);
  const approved = isApprovedArticle(article);
  const approvedTime =
    approved && article.approval
      ? Date.parse(article.approval.approvedAt)
      : NaN;
  const blocks = new Map(
    flattenArticleChunks(article).map((block) => [
      block.chunkId,
      articleBasisReference(block),
    ])
  );
  return (
    <details className="desk-disclosure desk-publication" open={focused}>
      <summary ref={heading}>
        <span className="desk-icon" aria-hidden="true">
          <FileText />
        </span>
        <span>
          <strong>{article.title}</strong>
          <span className="desk-footnote">
            {approved
              ? [
                  article.channel || "Оригинал",
                  Number.isFinite(approvedTime) &&
                    articleDate.format(approvedTime),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Исторический материал · редакция не зафиксирована"}
          </span>
        </span>
        <ChevronDown size={18} className="desk-chevron" aria-hidden="true" />
      </summary>
      <div className="desk-publication-body">
        <p className="desk-publication-lead">{article.lead}</p>
        {article.sections.map((section) => (
          <section key={section.id}>
            <h3>{section.heading}</h3>
            {section.chunks.map((chunk) => {
              const reference = blocks.get(chunk.id);
              return (
                <div key={chunk.id} className="min-w-0 space-y-1">
                  <p>{chunk.content}</p>
                  {reference && chunk.content.trim() && onUseBlock && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => onUseBlock(reference)}
                    >
                      Использовать блок как опору
                    </Button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
        {article.sourceCardTitles.length ? (
          <div className="desk-publication-sources">
            <h3>Источники</h3>
            <ul>
              {article.sourceCardTitles.map((title, index) => {
                const cardId = article.sourceCardIds[index];
                const pinned = article.sourceVersions?.find(
                  (source) => source.cardId === cardId
                );
                return (
                  <li key={`${index}-${title}`}>
                    {approved && cardId ? (
                      <Link
                        href={`/knowledge?card=${encodeURIComponent(cardId)}${pinned ? `&version=${encodeURIComponent(pinned.versionId)}` : ""}`}
                        className="desk-text-link"
                      >
                        {title}
                        {!pinned && " · версия не зафиксирована"}
                        <ArrowUpRight size={15} className="shrink-0" />
                      </Link>
                    ) : (
                      title
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {!!article.articleBasis?.length && (
          <div className="desk-publication-sources [overflow-wrap:anywhere]">
            <h3>Опорные блоки из библиотеки</h3>
            <ul>
              {article.articleBasis.map((reference) => {
                const current = articles.some((item) =>
                  hasCurrentArticleBasis(item, reference)
                );
                return (
                  <li
                    key={JSON.stringify([
                      reference.articleId,
                      reference.revisionId,
                      reference.chunkId,
                    ])}
                  >
                    {current ? (
                      <Link
                        href={`/editor?article=${encodeURIComponent(reference.articleId)}`}
                        className="desk-text-link"
                      >
                        {reference.articleTitle}
                        <ArrowUpRight
                          size={15}
                          className="shrink-0"
                          aria-hidden="true"
                        />
                      </Link>
                    ) : (
                      <p>{reference.articleTitle} · историческая опора</p>
                    )}
                    {reference.sectionHeading && (
                      <p>{reference.sectionHeading}</p>
                    )}
                    <p className="desk-footnote">
                      {articleBasisLocation(reference)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {approved ? (
          <p className="desk-footnote">
            Согласованная редакция {article.approval?.revisionId}
          </p>
        ) : null}
        {action}
      </div>
    </details>
  );
}

export function EditorialLibrary({
  articles,
  legacy,
  busy,
  onImport,
  onUseBlock,
  focusedArticleId,
}: Props) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLocaleLowerCase("ru");
  const matches = (article: ReadyArticle) =>
    [
      article.title,
      article.lead,
      article.topic,
      ...article.sourceCardTitles,
    ].some((value) => value.toLocaleLowerCase("ru").includes(keyword));
  const focusedArticle = focusedArticleId
    ? articles.find(
        (article) =>
          article.id === focusedArticleId && isApprovedArticle(article)
      )
    : undefined;
  const matchesSearch = articles.filter(
    (article) => article.id !== focusedArticle?.id && matches(article)
  );
  const published = focusedArticle
    ? [focusedArticle, ...matchesSearch]
    : matchesSearch;
  const archive = legacy.filter(matches);

  return (
    <div className="desk-publications desk-panel-in">
      <section
        className="desk-panel"
        aria-labelledby="approved-articles-heading"
      >
        <div className="desk-panel-head">
          <div>
            <h2 id="approved-articles-heading">Готовые статьи</h2>
            <p className="desk-footnote">
              Согласованные публикации и их источники
            </p>
          </div>
          {articles.length || legacy.length ? (
            <label className="desk-publication-search">
              <Search size={18} aria-hidden="true" />
              <Input
                type="search"
                value={query}
                aria-label="Поиск по статьям"
                placeholder="Поиск по статьям"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
        </div>
        {focusedArticleId && !focusedArticle && (
          <Alert className="m-3">
            <AlertTitle>Публикация недоступна</AlertTitle>
            <AlertDescription>
              Проверьте ссылку или выберите другую статью в списке.
            </AlertDescription>
          </Alert>
        )}
        {published.length ? (
          published.map((article) => (
            <Publication
              article={article}
              articles={articles}
              key={article.id}
              focused={article.id === focusedArticle?.id}
              busy={busy}
              onUseBlock={onUseBlock}
            />
          ))
        ) : (
          <div className="desk-workspace-empty">
            <span className="desk-icon" aria-hidden="true">
              <BookOpen />
            </span>
            <p>
              {keyword
                ? "Подходящих публикаций нет"
                : "Согласованных публикаций пока нет"}
            </p>
          </div>
        )}
      </section>
      {legacy.length ? (
        <section
          className="desk-panel"
          aria-labelledby="archive-articles-heading"
        >
          <div className="desk-panel-head">
            <div>
              <h2
                id="archive-articles-heading"
                className="flex items-center gap-2"
              >
                <Archive size={18} aria-hidden="true" /> Архив прежних
                материалов
              </h2>
              <p className="desk-footnote">
                Материалы для чтения со статусом согласования «неизвестен».
              </p>
            </div>
          </div>
          {archive.length ? (
            archive.map((article) => (
              <Publication
                article={article}
                key={article.id}
                action={
                  onImport ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void onImport(article)}
                    >
                      <Plus data-icon="inline-start" /> Создать личный черновик
                    </Button>
                  ) : undefined
                }
              />
            ))
          ) : (
            <p className="desk-workspace-empty">В архиве ничего не найдено</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
