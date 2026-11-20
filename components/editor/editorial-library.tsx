"use client";

import { useState } from "react";
import Link from "next/link";
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
import type { ReadyArticle } from "@/lib/articles";

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
};

function Publication({
  article,
  action,
}: {
  article: ReadyArticle;
  action?: React.ReactNode;
}) {
  return (
    <details className="desk-disclosure desk-publication">
      <summary>
        <span className="desk-icon" aria-hidden="true">
          <FileText />
        </span>
        <span>
          <strong>{article.title}</strong>
          <span className="desk-footnote">
            {article.approval
              ? `${article.channel || "Оригинал"} · ${articleDate.format(new Date(article.approval.approvedAt))}`
              : "Статус согласования неизвестен"}
          </span>
        </span>
        <ChevronDown size={18} className="desk-chevron" aria-hidden="true" />
      </summary>
      <div className="desk-publication-body">
        <p className="desk-publication-lead">{article.lead}</p>
        {article.sections.map((section) => (
          <section key={section.id}>
            <h3>{section.heading}</h3>
            {section.chunks.map((chunk) => (
              <p key={chunk.id}>{chunk.content}</p>
            ))}
          </section>
        ))}
        {article.sourceCardTitles.length ? (
          <div className="desk-publication-sources">
            <h3>Источники</h3>
            <ul>
              {article.sourceCardTitles.map((title, index) => {
                const cardId = article.sourceCardIds[index];
                return (
                  <li key={`${index}-${title}`}>
                    {article.approval && cardId ? (
                      <Link
                        href={`/knowledge?card=${encodeURIComponent(cardId)}&version=approved`}
                        className="desk-text-link"
                      >
                        {title}
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
        {article.approval ? (
          <p className="desk-footnote">
            Согласованная редакция {article.approval.revisionId}
          </p>
        ) : null}
        {action}
      </div>
    </details>
  );
}

export function EditorialLibrary({ articles, legacy, busy, onImport }: Props) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLocaleLowerCase("ru");
  const matches = (article: ReadyArticle) =>
    [
      article.title,
      article.lead,
      article.topic,
      ...article.sourceCardTitles,
    ].some((value) => value.toLocaleLowerCase("ru").includes(keyword));
  const published = articles.filter(matches);
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
        {published.length ? (
          published.map((article) => (
            <Publication article={article} key={article.id} />
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
