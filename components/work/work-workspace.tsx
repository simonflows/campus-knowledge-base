"use client";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { AppLink as Link, useWorkspaceNavigation } from "@/components/navigation/workspace-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
import { WorkspaceMasthead } from "@/components/workspace-masthead";
import { Button } from "@/components/ui/button";
import type { WorkData } from "@/lib/work-data";
import type { WorkflowPresentation } from "@/lib/workflow-models";
import { CreateWorkflowForm } from "./work-forms";
import { CoverageOverview, WorkQueue } from "./work-overviews";
import { WorkEmpty, WorkError, WorkLoading } from "./work-primitives";
import { WorkRecordDetail, WorkRecordList } from "./work-records";
import { keepNewestRecord, requestWork, WorkRequestError, workHref, type WorkSection } from "./work-state";
import "@/app/campus-workspaces.css";
import styles from "./workspace.module.css";

const sections = [
  { id: "queue", title: "Очередь" },
  { id: "packages", title: "Инфоповоды" },
  { id: "disputes", title: "Разбор источников" },
  { id: "coverage", title: "Полнота данных" },
] satisfies { id: WorkSection; title: string }[];

export function WorkWorkspace({ section, record, create, admin }: {
  section: WorkSection; record?: string; create: boolean; admin: boolean;
}) {
  const workspaceRequest = useWorkspaceRequest();
  const router = useWorkspaceNavigation();
  const [data, setData] = useState<WorkData | null>(null);
  const [error, setError] = useState("");
  const reader = useRef<AbortController | null>(null);
  const active = useRef(true);

  const refresh = useCallback(async () => {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    try {
      const next = await requestWork<WorkData>(workspaceRequest, "/api/work", { signal: controller.signal });
      if (controller.signal.aborted || !active.current) return;
      setData((current) => {
        const previous = new Map(current?.workflows.map((item) => [item.record.id, item]));
        return { ...next, workflows: next.workflows.map((item) => keepNewestRecord(previous.get(item.record.id), item)) };
      });
      setError("");
    } catch (failure) {
      if (controller.signal.aborted || !active.current) return;
      if (failure instanceof WorkRequestError && [401, 403].includes(failure.status)) setData(null);
      setError((failure as Error).message);
    }
  }, [workspaceRequest]);

  useEffect(() => {
    active.current = true;
    let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    return () => {
      mounted = false;
      active.current = false;
      reader.current?.abort();
    };
  }, [refresh]);

  const changed = (item: WorkflowPresentation) => {
    if (!active.current) return;
    reader.current?.abort();
    setData((current) => current && ({
      ...current,
      workflows: [
        keepNewestRecord(current.workflows.find(({ record }) => record.id === item.record.id), item),
        ...current.workflows.filter(({ record }) => record.id !== item.record.id),
      ],
    }));
    void refresh();
  };
  const errorPanel = error && <WorkError title="Рабочие данные не загрузились"
    action={<Button variant="outline" onClick={() => void refresh()}>Повторить загрузку</Button>}>{error}</WorkError>;
  const bundles = section === "packages" || section === "disputes";
  const kind = section === "packages" ? "package" : "dispute";
  const rows = data?.workflows.filter((item) => item.record.kind === kind) ?? [];

  return (
    <div className={`atlas-wrap campus-workspace ${styles.workspace}`}>
      <WorkspaceMasthead id="work-title" title="Моя работа" icon={ClipboardList}
        description="Согласования, запросы и материалы, которым нужна сверка." />
      <nav className={styles.sectionNav} aria-label="Рабочие разделы">
        {sections.filter(({ id }) => id !== "coverage" || admin).map(({ id, title }) => (
          <Link key={id} href={workHref(id)} aria-current={section === id ? "page" : undefined}>{title}</Link>
        ))}
      </nav>
      {errorPanel}
      {data ? (
        section === "queue" ? <WorkQueue data={data} />
          : section === "coverage" ? data.coverage && <CoverageOverview rows={data.coverage} />
            : bundles && (
              <div className={styles.recordsLayout} data-detail={Boolean(record || create) || undefined}
                data-empty={!record && !create && rows.length === 0 || undefined}>
                <aside className={styles.recordsAside} aria-label="Рабочие записи">
                  <WorkRecordList section={section} rows={rows} selected={record} people={data.people} />
                </aside>
                {create ? (
                  <CreateWorkflowForm key={kind} kind={kind} data={data} onCancel={() => router.push(workHref(section))}
                    onCreated={(item) => { changed(item); router.push(workHref(section, item.record.id)); }} />
                ) : record ? (
                  <WorkRecordDetail key={record} section={section} id={record} initial={rows.find((item) => item.record.id === record)}
                    data={data} onChanged={changed} />
                ) : rows.length > 0 ? (
                  <div className="desk-panel">
                    <WorkEmpty title={kind === "package" ? "Выберите инфоповод" : "Выберите разбор"}>
                      {kind === "package" ? "Откройте запись, чтобы увидеть источники, материалы и ответственного." : "Откройте запись, чтобы сравнить источники и посмотреть решение."}
                    </WorkEmpty>
                  </div>
                ) : null}
              </div>
            )
      ) : !error ? (
        <div className="desk-panel"><WorkLoading label="Загружаем рабочие задачи" /></div>
      ) : null}
    </div>
  );
}
