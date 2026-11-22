"use client";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";
import { AppLink as Link } from "@/components/navigation/workspace-navigation";
import { useEffect, useState } from "react";
import { ArrowUpRight, Files } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { editorialStatusLabels } from "@/lib/editorial";
import type { CardUsage } from "@/lib/card-usage";

const dateLabel = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });
export function KnowledgeUsagePanel({ cardId }: { cardId: string }) {
  const workspaceRequest = useWorkspaceRequest();
  const [state, setState] = useState<{ status: "loading" | "error" | "ready"; items: CardUsage[] }>({ status: "loading", items: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void workspaceRequest(`/api/knowledge/cards/${encodeURIComponent(cardId)}/usage`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!controller.signal.aborted) setState({ status: "ready", items: data.items });
    }).catch(() => { if (!controller.signal.aborted) setState({ status: "error", items: [] }); });
    return () => controller.abort();
  }, [cardId, attempt, workspaceRequest]);
  return <section className="flex flex-col gap-3" aria-labelledby={`usage-${cardId}`}>
    <h3 id={`usage-${cardId}`} className="font-semibold">Где использована карточка</h3>
    <p className="text-sm text-muted-foreground">Видны только доступные вам материалы. Версия указана у каждого материала; изменение источника не переписывает статью.</p>
    {state.status === "loading" ? <Skeleton className="h-16 w-full" /> : state.status === "error" ? <p role="status">Не удалось загрузить связи. <Button variant="link" size="sm" onClick={() => setAttempt(value => value + 1)}>Повторить</Button></p> : state.items.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Files /></EmptyMedia><EmptyTitle>Связанных материалов пока нет</EmptyTitle><EmptyDescription>Сохранённые источники редактора появятся здесь.</EmptyDescription></EmptyHeader></Empty> : <ul className="flex flex-col divide-y divide-border">
      {state.items.map(item => <li key={`${item.kind}:${item.id}`} className="flex flex-col gap-2 py-3">
        <Link href={item.href} className="flex items-start justify-between gap-3 font-medium underline-offset-4 hover:underline">{item.title}<ArrowUpRight size={16} aria-hidden="true" /></Link>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{item.channel}</span><Badge variant="outline">{editorialStatusLabels[item.status as keyof typeof editorialStatusLabels] ?? "Материал"}</Badge>{item.needsReview ? <Badge variant="secondary">Нужна сверка источника</Badge> : null}</div>
        {item.versionId ? <Link href={`/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(item.versionId)}`} className="text-sm underline underline-offset-4">{item.versionDate && Number.isFinite(Date.parse(item.versionDate)) ? `Источник: версия от ${dateLabel.format(new Date(item.versionDate))}` : "Открыть использованную утверждённую версию"}</Link> : <p className="text-sm text-muted-foreground">Версия источника не была зафиксирована.</p>}
        {item.reviewedVersionId && item.reviewedVersionId !== item.versionId ? <Link href={`/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(item.reviewedVersionId)}`} className="text-sm underline underline-offset-4">Также вручную сверено с обновлённой версией</Link> : null}
      </li>)}
    </ul>}
  </section>;
}
