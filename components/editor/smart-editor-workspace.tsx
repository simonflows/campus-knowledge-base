"use client";
import {
  MastheadCount,
  WorkspaceMasthead,
} from "@/components/workspace-masthead";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  FileText,
  Plus,
  Save,
  Sparkles,
  Download,
  History,
  Send,
  Check,
  RotateCcw,
  MessageSquare,
  BookOpen,
  GitBranch,
  RefreshCw,
  Archive,
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  ClipboardCheck,
  Files,
  LockKeyhole,
  ScrollText,
  SquarePen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { EditorialLibrary } from "./editorial-library";
import "@/app/campus-workspaces.css";
import { universities } from "@/lib/data";
import type { SessionUser } from "@/lib/auth";
import type { ReadyArticle } from "@/lib/articles";
import type { FactCheckResult } from "@/lib/fact-check";
import { getCardStatus, type KnowledgeCard } from "@/lib/knowledge";
import {
  editorialContentSchema,
  editorialMutationSchema,
  editorialStatusLabels,
  editorialEventLabels,
  editorialText,
  type EditorialContent,
  type EditorialDocument,
  type EditorialRevision,
} from "@/lib/editorial";
import {
  migrateEditorialRecovery,
  readEditorialRecovery,
  removeEditorialRecovery,
  saveEditorialRecovery,
  type EditorialRecovery,
} from "@/lib/editorial-recovery";
import {
  editorialRecoveryStorage,
  EDITORIAL_SESSION_ENDED,
  EDITORIAL_SESSION_END_KEY,
} from "@/lib/editorial-session-cleanup";

type Props = {
  initialArticles: ReadyArticle[];
  cardsCount: number;
  dbAvailable: boolean;
  currentUser?: SessionUser | null;
};
async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      data.error || "Не удалось выполнить запрос"
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return data;
}
const blank = (user?: SessionUser | null) =>
  editorialContentSchema.parse({ universityId: user?.universityId || "" });
const emptyRecoveries: EditorialRecovery[] = [];
function recoveryList(ownerId?: string) {
  let snapshot = emptyRecoveries;
  let ended = false;
  const listeners = new Set<() => void>();
  const refresh = () => {
    snapshot = ownerId && !ended ? readEditorialRecovery(ownerId) : emptyRecoveries;
    listeners.forEach((notify) => notify());
  };
  return {
    refresh,
    end() {
      ended = true;
      refresh();
    },
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      if (ownerId && !ended) migrateEditorialRecovery(ownerId);
      refresh();
      window.addEventListener("focus", refresh);
      return () => {
        listeners.delete(notify);
        window.removeEventListener("focus", refresh);
      };
    },
  };
}
const getServerRecoveries = () => emptyRecoveries;

export function SmartEditorWorkspace(props: Props) {
  return <EditorSession key={props.currentUser?.id} {...props} />;
}

function EditorSession({
  initialArticles,
  cardsCount,
  dbAvailable,
  currentUser = null,
}: Props) {
  const [documents, setDocuments] = useState<EditorialDocument[]>([]),
    [articles, setArticles] = useState(initialArticles),
    [legacy, setLegacy] = useState<ReadyArticle[]>([]);
  const [surface, setSurface] = useState<"write" | "history" | "library">(
    currentUser && currentUser.role !== "guest" ? "write" : "library"
  );
  const [mobileDrafts, setMobileDrafts] = useState(false);
  const draftHeading = useRef<HTMLHeadingElement>(null);
  const showDraft = () => {
    setMobileDrafts(false);
    setSurface("write");
    requestAnimationFrame(() => draftHeading.current?.focus());
  };
  const [sourceCards, setSourceCards] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [reviewers, setReviewers] = useState<
    Array<{ id: string; name: string; organization: string }>
  >([]);
  const [reviewerId, setReviewerId] = useState("");
  const [doc, setDoc] = useState<EditorialDocument | null>(null),
    [content, setContent] = useState<EditorialContent>(() =>
      blank(currentUser)
    ),
    [baseline, setBaseline] = useState(() =>
      JSON.stringify(blank(currentUser))
    );
  const [revisions, setRevisions] = useState<EditorialRevision[]>([]),
    [reviewRevision, setReviewRevision] = useState<string | null>(null),
    [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false),
    [saveStatus, setSaveStatus] = useState("Изменения ещё не сохранены"),
    [conflict, setConflict] = useState(false),
    [serverDocument, setServerDocument] = useState<EditorialDocument | null>(
      null
    );
  const [recoveryStore] = useState(() =>
    recoveryList(currentUser?.role === "guest" ? undefined : currentUser?.id)
  );
  const recoveries = useSyncExternalStore(
    recoveryStore.subscribe,
    recoveryStore.getSnapshot,
    getServerRecoveries
  );
  const [check, setCheck] = useState<FactCheckResult | null>(null),
    [channel, setChannel] = useState("Telegram"),
    [provider, setProvider] = useState("canonical");
  const pendingSave = useRef<Promise<EditorialDocument | null> | null>(null);
  const active = useRef(true);
  const [ended, setEnded] = useState(false);
  const contentRef = useRef(content);
  const docRef = useRef(doc);
  const baselineRef = useRef(baseline);
  const recoveryVersion = useRef(0);
  const dirty = JSON.stringify(content) !== baseline;
  const owner = !!currentUser && (!doc || doc.ownerId === currentUser.id);
  const editable = !ended && owner && currentUser?.role !== "guest";
  const selectedRevision = revisions.find((r) => r.id === reviewRevision);
  const upsert = (next: EditorialDocument) =>
    setDocuments((items) => [next, ...items.filter((d) => d.id !== next.id)]);
  const userId = currentUser?.id;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!userId || !active.current) return;
      const data = await jsonRequest("/api/editor/drafts", { signal });
      if (!active.current || signal?.aborted) return;
      const latest = docRef.current;
      setDocuments((items) => {
        const received: EditorialDocument[] = data.documents;
        return latest &&
          items.some((item) => item.id === latest.id) &&
          !received.some(
            (item) => item.id === latest.id && item.version >= latest.version
          )
          ? [latest, ...received.filter((item) => item.id !== latest.id)]
          : received;
      });
      setLegacy(data.legacyArticles);
    },
    [userId]
  );
  useEffect(() => {
    const requests = new AbortController();
    active.current = true;
    void refresh(requests.signal).catch((e) => {
      if (!requests.signal.aborted) toast.error(e.message);
    });
    void jsonRequest("/api/knowledge/cards", { signal: requests.signal })
      .then((cards: KnowledgeCard[]) => {
        if (!requests.signal.aborted)
          setSourceCards(
            cards
              .filter((c) => getCardStatus(c) === "approved")
              .map((c) => ({ id: c.id, title: c.title }))
          );
      })
      .catch(() => {});
    const endSession = () => {
      active.current = false;
      requests.abort();
      recoveryStore.end();
      setEnded(true);
      setSurface("library");
      setDoc(null);
      docRef.current = null;
      contentRef.current = blank();
      setContent(contentRef.current);
      setRevisions([]);
      setServerDocument(null);
      setLegacy([]);
      setDocuments([]);
    };
    const syncSession = (event: StorageEvent) => {
      if (event.key !== EDITORIAL_SESSION_END_KEY) return;
      try {
        editorialRecoveryStorage();
      } catch {}
      endSession();
    };
    window.addEventListener(EDITORIAL_SESSION_ENDED, endSession);
    window.addEventListener("storage", syncSession);
    return () => {
      active.current = false;
      requests.abort();
      window.removeEventListener(EDITORIAL_SESSION_ENDED, endSession);
      window.removeEventListener("storage", syncSession);
    };
  }, [recoveryStore, refresh]);

  const acceptVersion = (next: EditorialDocument | null) => {
    docRef.current = next;
    setDoc(next);
    baselineRef.current = JSON.stringify(next?.content || blank(currentUser));
    setBaseline(baselineRef.current);
    recoveryVersion.current = next?.version || 0;
  };
  const replaceText = (next: EditorialContent) => {
    contentRef.current = next;
    setContent(next);
    setCheck(null);
  };
  const edit = (next: EditorialContent) => {
    replaceText(next);
    if (!currentUser || !active.current) return;
    const id = docRef.current?.id || null;
    if (!pendingSave.current && JSON.stringify(next) === baselineRef.current) {
      removeEditorialRecovery(currentUser.id, id);
      setSaveStatus(
        docRef.current ? "Сохранено на сервере" : "Новый личный черновик"
      );
    } else {
      const stored = saveEditorialRecovery(
        currentUser.id,
        id,
        recoveryVersion.current,
        next
      );
      setSaveStatus(
        stored
          ? "Изменения ещё не сохранены"
          : "Браузер запретил локальное восстановление. Сохраните на сервере или скопируйте текст."
      );
    }
  };
  type Details = {
    document: EditorialDocument;
    revisions: EditorialRevision[];
    reviewers?: typeof reviewers;
  };
  const openDocument = (data: Details | null, recovery?: EditorialRecovery) => {
    const next = data?.document || null;
    acceptVersion(next);
    replaceText(recovery?.content || next?.content || blank(currentUser));
    setRevisions(data?.revisions || []);
    setReviewers(data?.reviewers || []);
    setReviewerId(next?.reviewerId || data?.reviewers?.[0]?.id || "");
    setReviewRevision(null);
    setComment("");
    const diverged = !!next && !!recovery && next.version !== recovery.version;
    if (recovery) recoveryVersion.current = recovery.version;
    setConflict(diverged);
    setServerDocument(diverged ? next : null);
    setSaveStatus(
      recovery
        ? "Восстановлен неотправленный текст из копии в этой вкладке"
        : next
          ? "Сохранено на сервере"
          : "Новый личный черновик"
    );
  };
  const load = async (id: string) => {
    const data = await jsonRequest(`/api/editor/drafts/${id}`);
    if (active.current) openDocument(data);
  };
  const handleConflict = useCallback(async (current: EditorialDocument) => {
    setConflict(true);
    setServerDocument(null);
    try {
      const data = await jsonRequest(`/api/editor/drafts/${current.id}`);
      if (active.current && docRef.current === current)
        setServerDocument(data.document);
    } catch (error) {
      if (active.current) toast.error((error as Error).message);
    }
  }, []);
  const save = useCallback(async () => {
    if (
      !currentUser ||
      currentUser.role === "guest" ||
      !active.current ||
      conflict
    )
      return null;
    if (docRef.current && docRef.current.ownerId !== currentUser.id)
      return null;
    if (pendingSave.current) return pendingSave.current;
    const persist = async (): Promise<EditorialDocument | null> => {
      do {
        const current = docRef.current;
        const snapshot = contentRef.current;
        const fingerprint = JSON.stringify(snapshot);
        if (current && fingerprint === baselineRef.current) return current;
        const parsed = editorialContentSchema.safeParse(snapshot);
        if (!parsed.success) {
          const message = parsed.error.issues[0]?.message || "Проверьте текст";
          setSaveStatus(message);
          toast.error(message);
          return null;
        }
        setSaveStatus("Сохраняем…");
        try {
          const data = current
            ? await jsonRequest(`/api/editor/drafts/${current.id}`, {
                method: "PATCH",
                body: JSON.stringify(
                  editorialMutationSchema.parse({
                    action: "save",
                    version: current.version,
                    content: parsed.data,
                  })
                ),
              })
            : await jsonRequest("/api/editor/drafts", {
                method: "POST",
                body: JSON.stringify({ content: parsed.data }),
              });
          if (!active.current) return null;
          const next: EditorialDocument = current ? data.document : data;
          docRef.current = next;
          setDoc(next);
          upsert(next);
          baselineRef.current = fingerprint;
          setBaseline(fingerprint);
          recoveryVersion.current = next.version;
          const latest = contentRef.current;
          if (JSON.stringify(latest) === fingerprint) {
            if (!current) removeEditorialRecovery(currentUser.id, null);
            removeEditorialRecovery(currentUser.id, next.id);
            recoveryStore.refresh();
            setSaveStatus("Сохранено на сервере");
            void jsonRequest(`/api/editor/drafts/${next.id}`)
              .then((details: Details) => {
                if (!active.current || docRef.current !== next) return;
                const choices = details.reviewers || [];
                setReviewers(choices);
                setReviewerId((previous) =>
                  choices.some((r) => r.id === previous)
                    ? previous
                    : next.reviewerId || choices[0]?.id || ""
                );
              })
              .catch(() => {});
            return next;
          }
          if (
            saveEditorialRecovery(
              currentUser.id,
              next.id,
              next.version,
              latest
            ) &&
            !current
          )
            removeEditorialRecovery(currentUser.id, null);
        } catch (error) {
          if (!active.current) return null;
          const e = error as Error & { status?: number };
          setSaveStatus(e.message);
          if (e.status === 409 && current) await handleConflict(current);
          return null;
        }
      } while (active.current);
      return null;
    };
    pendingSave.current = persist().finally(() => {
      pendingSave.current = null;
    });
    return pendingSave.current;
  }, [currentUser, conflict, recoveryStore, handleConflict]);
  useEffect(() => {
    if (!editable || !dirty || conflict || busy) return;
    const timer = setTimeout(() => void save(), 1200);
    return () => clearTimeout(timer);
  }, [content, dirty, editable, conflict, busy, save]);
  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => {
      if (active.current && (dirty || pendingSave.current)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warning);
    return () => window.removeEventListener("beforeunload", warning);
  }, [dirty]);

  const flush = async () => {
    if (pendingSave.current) return Boolean(await pendingSave.current);
    return !dirty || Boolean(await save());
  };
  const switchDocument = async (id?: string) => {
    setBusy(true);
    try {
      if (!(await flush()) || !active.current) return;
      if (id) await load(id);
      else openDocument(null);
      if (active.current) showDraft();
    } finally {
      setBusy(false);
    }
  };
  const change = (key: keyof EditorialContent, value: unknown) => {
    edit({ ...contentRef.current, [key]: value });
  };
  const generate = async () => {
    const query = content.query.trim() || content.topic.trim();
    if (query.length < 10) {
      toast.error("Опишите тему подробнее — минимум 10 знаков");
      return;
    }
    setBusy(true);
    try {
      const result = await jsonRequest("/api/editor/generate", {
        method: "POST",
        body: JSON.stringify({
          query,
          provider,
          audience: content.audience,
          outlet: content.outlet,
          length: content.length,
        }),
      });
      if (!active.current) return;
      if (result.noData) {
        toast.error(result.noDataMessage);
        return;
      }
      const a = result.article;
      const c = contentRef.current;
      edit(
        editorialContentSchema.parse({
          ...c,
          ...a,
          audience: c.audience,
          outlet: c.outlet,
          length: c.length,
          universityId: c.universityId || a.suggestedUniversityId || "",
          topic: c.topic || a.topic,
          query,
        })
      );
      toast.success("Текст добавлен в личный черновик");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (
    action: "submit" | "return" | "approve" | "comment" | "restore",
    revisionId?: string
  ) => {
    if (!doc) return;
    setBusy(true);
    try {
      if (!(await flush()) || !active.current) return;
      const current = docRef.current;
      if (!current) return;
      const target = revisionId || current.revisionId;
      const mutation = editorialMutationSchema.parse(
        action === "restore"
          ? { action, version: current.version, revisionId: target }
          : {
              action,
              version: current.version,
              revisionId: target,
              comment,
              ...(action === "submit" ? { reviewerId } : {}),
            }
      );
      const result = await jsonRequest(`/api/editor/drafts/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify(mutation),
      });
      if (!active.current) return;
      acceptVersion(result.document);
      replaceText(result.document.content);
      upsert(result.document);
      setComment("");
      if (result.publication)
        setArticles((items) => [
          result.publication,
          ...items.filter((a) => a.id !== result.publication.id),
        ]);
      toast.success("Действие сохранено в истории редакции");
      await load(current.id);
    } catch (e) {
      if (!active.current) return;
      const error = e as Error & { status?: number };
      toast.error(error.message);
      if (error.status === 409 && docRef.current)
        await handleConflict(docRef.current);
    } finally {
      setBusy(false);
    }
  };
  const checkText = async () => {
    setBusy(true);
    try {
      const result = await jsonRequest("/api/fact-check", {
        method: "POST",
        body: JSON.stringify({ text: editorialText(content), mode: "check" }),
      });
      if (active.current) setCheck(result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const createVariant = async () => {
    setBusy(true);
    try {
      if (!(await flush()) || !active.current) return;
      const current = docRef.current;
      if (!current) return;
      const variant = await jsonRequest("/api/editor/drafts", {
        method: "POST",
        body: JSON.stringify({
          originalId: current.originalId,
          channel,
          content: { ...content, outlet: channel },
        }),
      });
      if (!active.current) return;
      upsert(variant);
      await load(variant.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recover = async (selected: EditorialRecovery) => {
    if (!currentUser || !active.current) return;
    const recovery = readEditorialRecovery(currentUser.id).find(
      (copy) => copy.documentId === selected.documentId
    );
    if (!recovery) {
      recoveryStore.refresh();
      toast.info("Копия черновика больше недоступна в этой вкладке");
      return;
    }
    setBusy(true);
    try {
      if (!(await flush()) || !active.current) return;
      const data = recovery.documentId
        ? await jsonRequest(`/api/editor/drafts/${recovery.documentId}`)
        : null;
      if (!active.current) return;
      openDocument(data, recovery);
      showDraft();
    } finally {
      setBusy(false);
    }
  };
  const canWork = !ended && currentUser && currentUser.role !== "guest";
  const groups = Array.from(new Set(documents.map((d) => d.originalId)));
  const nav = [
    { id: "write", label: "Черновики", icon: SquarePen },
    { id: "history", label: "История", icon: History },
    { id: "library", label: "Публикации", icon: Archive },
  ] as const;
  const refreshHistory = () => {
    if (!doc) return;
    void jsonRequest(`/api/editor/drafts/${doc.id}`)
      .then((data) => {
        if (active.current && docRef.current === doc)
          setRevisions(data.revisions);
      })
      .catch((error) => toast.error(error.message));
  };
  const importArchive = async (article: ReadyArticle) => {
    setBusy(true);
    try {
      if (!(await flush()) || !active.current) return;
      const next = await jsonRequest("/api/editor/drafts", {
        method: "POST",
        body: JSON.stringify({
          legacyArticleId: article.id,
          content: { ...article },
        }),
      });
      if (!active.current) return;
      upsert(next);
      await load(next.id);
      if (active.current) showDraft();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const downloadHref =
    doc && !dirty && !busy
      ? `/api/editor/drafts/${encodeURIComponent(doc.id)}/docx?revisionId=${encodeURIComponent(reviewRevision || doc.revisionId)}`
      : undefined;

  return (
    <div className="atlas-wrap campus-workspace desk-editor">
      <WorkspaceMasthead
        id="editor-page-title"
        icon={SquarePen}
        title="Умный редактор"
        description="Готовьте статьи по официальным данным, проверяйте факты и согласовывайте редакции."
      >
        <MastheadCount count={cardsCount} label="карточек в справочнике">
          <Link href="/knowledge" className="desk-text-link">
            База знаний <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </MastheadCount>
      </WorkspaceMasthead>
      {canWork ? (
        <div className="desk-nav" role="group" aria-label="Разделы редактора">
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-pressed={surface === id}
              onClick={() => {
                setSurface(id);
                if (id === "history") refreshHistory();
              }}
            >
              <Icon aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
      ) : (
        <section className="desk-panel desk-locked desk-editor-lock">
          <span className="desk-icon" aria-hidden="true">
            <LockKeyhole />
          </span>
          <div>
            <h2>Личные черновики</h2>
            <p className="desk-footnote">
              Рабочий аккаунт открывает редактор, историю и согласование.
            </p>
          </div>
          <Link href="/login" className="desk-text-link">
            Войти в аккаунт <ArrowRight size={16} />
          </Link>
        </section>
      )}
      {!dbAvailable && canWork ? (
        <Alert className="mb-4">
          <AlertTitle>Серверное сохранение недоступно</AlertTitle>
          <AlertDescription>
            Неотправленный текст хранится на этом устройстве до 7 дней и
            удаляется при выходе. Для согласования требуется общая база.
          </AlertDescription>
        </Alert>
      ) : null}
      {canWork ? (
        <div className="desk-editor-grid" hidden={surface === "library"}>
          <aside
            className="desk-panel desk-drafts"
            aria-label="Список черновиков"
            data-mobile-expanded={mobileDrafts}
          >
            <button
              type="button"
              className="desk-drafts-mobile"
              aria-expanded={mobileDrafts}
              aria-controls="draft-index"
              onClick={() => setMobileDrafts((open) => !open)}
            >
              <Files size={17} /> Мои черновики <span>{documents.length}</span>
              <ChevronDown size={16} className="desk-chevron" />
            </button>
            <div id="draft-index">
              <div className="desk-panel-head">
                <h2>Мои черновики</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Обновить список"
                  onClick={() =>
                    void refresh().catch((error) => toast.error(error.message))
                  }
                >
                  <RefreshCw />
                </Button>
              </div>
              <div className="desk-draft-add">
                <Button disabled={busy} onClick={() => void switchDocument()}>
                  <Plus data-icon="inline-start" /> Новый черновик
                </Button>
              </div>
              {documents.length ? (
                <div className="desk-draft-groups">
                  {groups.map((group) => {
                    const groupItems = documents.filter(
                      (item) => item.originalId === group
                    );
                    return (
                      <div className="desk-draft-group" key={group}>
                        {groupItems.length > 1 ? (
                          <p className="desk-draft-group-label">
                            {documents.find((item) => item.id === group)
                              ?.content.title || "Варианты материала"}
                          </p>
                        ) : null}
                        {groupItems.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            disabled={busy}
                            aria-pressed={item.id === doc?.id}
                            className="desk-draft-row"
                            onClick={() =>
                              void switchDocument(item.id).catch((error) =>
                                toast.error(error.message)
                              )
                            }
                          >
                            <FileText size={16} aria-hidden="true" />
                            <span>
                              <strong>
                                {item.content.title ||
                                  item.content.topic ||
                                  "Без заголовка"}
                              </strong>
                              <small>
                                {item.channel} ·{" "}
                                {editorialStatusLabels[item.status]}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="desk-workspace-empty desk-drafts-empty">
                  <span className="desk-icon" aria-hidden="true">
                    <FileText />
                  </span>
                  <p>Черновиков пока нет</p>
                </div>
              )}
            </div>
          </aside>
          <div className="min-w-0" hidden={surface !== "write"}>
            {recoveries.length ? (
              <Alert className="mb-4">
                <AlertTitle>На устройстве есть неотправленный текст</AlertTitle>
                <AlertDescription>
                  <div className="flex flex-col gap-2">
                    {recoveries.map((r) => (
                      <div
                        key={r.documentId || "new"}
                        className="flex flex-wrap gap-2"
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void recover(r).catch((e) => toast.error(e.message))
                          }
                        >
                          Восстановить:{" "}
                          {r.content.title ||
                            r.content.topic ||
                            "без заголовка"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            removeEditorialRecovery(
                              currentUser.id,
                              r.documentId
                            );
                            recoveryStore.refresh();
                          }}
                        >
                          Удалить копию
                        </Button>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}

            <section className="desk-panel desk-manuscript">
              <div className="desk-panel-head desk-manuscript-head">
                <div>
                  <div className="flex items-center gap-2">
                    <ScrollText
                      size={18}
                      aria-hidden="true"
                      className="shrink-0"
                    />
                    <h2
                      ref={draftHeading}
                      tabIndex={-1}
                      className="desk-draft-heading"
                    >
                      {doc?.content.title || "Новый личный черновик"}
                    </h2>
                  </div>
                  <p className="desk-footnote" aria-live="polite">
                    {saveStatus}
                    {dirty ? " · есть неотправленные изменения" : ""}
                  </p>
                </div>
                <div className="desk-document-state">
                  {doc ? (
                    <Badge variant="secondary">
                      {editorialStatusLabels[doc.status]} · v{doc.version}
                    </Badge>
                  ) : null}
                  <Button
                    disabled={!editable || busy || conflict}
                    variant="outline"
                    onClick={() => void save()}
                  >
                    <Save data-icon="inline-start" /> Сохранить черновик
                  </Button>
                </div>
              </div>
              <div className="desk-manuscript-grid">
                <div className="desk-manuscript-body">
                  {conflict ? (
                    <Alert variant="destructive">
                      <AlertTitle>Сохранена другая редакция</AlertTitle>
                      <AlertDescription>
                        Автосохранение приостановлено. Сравните серверный текст
                        со своим перед продолжением.
                        {serverDocument ? (
                          <>
                            <Textarea
                              readOnly
                              aria-label="Актуальный серверный текст"
                              value={editorialText(serverDocument.content)}
                            />
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => {
                                  acceptVersion(serverDocument);
                                  replaceText(serverDocument.content);
                                  upsert(serverDocument);
                                  setConflict(false);
                                  setSaveStatus("Сохранено на сервере");
                                  removeEditorialRecovery(
                                    currentUser.id,
                                    serverDocument.id
                                  );
                                  recoveryStore.refresh();
                                }}
                              >
                                Оставить серверный текст
                              </Button>
                              {editable && (
                                <Button
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => {
                                    acceptVersion(serverDocument);
                                    upsert(serverDocument);
                                    setConflict(false);
                                    edit(contentRef.current);
                                  }}
                                >
                                  Сохранить мой текст новой редакцией
                                </Button>
                              )}
                            </div>
                          </>
                        ) : doc ? (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => void handleConflict(doc)}
                          >
                            Загрузить актуальную редакцию
                          </Button>
                        ) : null}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  <details className="desk-disclosure desk-generation">
                    <summary>
                      <Sparkles size={17} aria-hidden="true" /> Подготовить
                      текст по данным
                      <ChevronDown size={17} className="desk-chevron" />
                    </summary>
                    <div className="desk-generation-form">
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="editor-topic">Тема</FieldLabel>
                          <Input
                            id="editor-topic"
                            disabled={!editable || busy}
                            value={content.topic}
                            onChange={(e) => change("topic", e.target.value)}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="editor-query">
                            Задача для редактора
                          </FieldLabel>
                          <Textarea
                            id="editor-query"
                            disabled={!editable || busy}
                            value={content.query}
                            onChange={(e) => change("query", e.target.value)}
                            placeholder="Например: статья о виртуальном тренажёре травмпункта МИДиС и ЮУГМУ"
                          />
                        </Field>
                      </FieldGroup>
                      <div className="desk-generation-meta">
                        {(
                          [
                            ["audience", "Аудитория (необязательно)"],
                            ["outlet", "Канал / площадка (необязательно)"],
                            ["length", "Объём (необязательно)"],
                          ] as const
                        ).map(([key, label]) => (
                          <Field key={key}>
                            <FieldLabel htmlFor={`editor-${key}`}>
                              {label}
                            </FieldLabel>
                            <Input
                              id={`editor-${key}`}
                              disabled={!editable || busy}
                              value={content[key]}
                              onChange={(e) => change(key, e.target.value)}
                            />
                          </Field>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={provider}
                          onValueChange={(v) => v && setProvider(v)}
                        >
                          <SelectTrigger aria-label="Режим подготовки текста">
                            <SelectValue>
                              {
                                (
                                  {
                                    canonical: "По проверенным фактам",
                                    auto: "Автоматический выбор ИИ",
                                    yandex: "Yandex AI",
                                  } as Record<string, string>
                                )[provider]
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="canonical">
                                По проверенным фактам
                              </SelectItem>
                              <SelectItem value="auto">
                                Автоматический выбор ИИ
                              </SelectItem>
                              <SelectItem value="yandex">Yandex AI</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <Button
                          disabled={!editable || busy}
                          onClick={() => void generate()}
                        >
                          <Sparkles data-icon="inline-start" />
                          Подготовить текст
                        </Button>
                      </div>
                    </div>
                  </details>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="editor-title">Заголовок</FieldLabel>
                      <Input
                        id="editor-title"
                        placeholder="Заголовок статьи"
                        disabled={!editable || busy}
                        value={content.title}
                        onChange={(e) => change("title", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="editor-university">
                        Вуз автора
                      </FieldLabel>
                      <Select
                        value={content.universityId}
                        onValueChange={(v) => change("universityId", v || "")}
                        disabled={!editable || busy}
                      >
                        <SelectTrigger id="editor-university">
                          <SelectValue placeholder="Выберите вуз">
                            {
                              universities.find(
                                (u) => u.id === content.universityId
                              )?.shortName
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {universities.map((u) => (
                              <SelectItem key={u.id} value={u.id}>
                                {u.shortName}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="editor-lead">Лид</FieldLabel>
                      <Textarea
                        id="editor-lead"
                        rows={4}
                        placeholder="Короткое вступление"
                        disabled={!editable || busy}
                        value={content.lead}
                        onChange={(e) => change("lead", e.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                  {content.sections.map((section, si) => (
                    <Card className="desk-content-section" key={section.id}>
                      <CardHeader>
                        <Field>
                          <FieldLabel htmlFor={`heading-${section.id}`}>
                            Раздел {si + 1}
                          </FieldLabel>
                          <Input
                            id={`heading-${section.id}`}
                            disabled={!editable || busy}
                            value={section.heading}
                            onChange={(e) =>
                              change(
                                "sections",
                                content.sections.map((s, i) =>
                                  i === si
                                    ? { ...s, heading: e.target.value }
                                    : s
                                )
                              )
                            }
                          />
                        </Field>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3">
                        {section.chunks.map((chunk, ci) => (
                          <Field key={chunk.id}>
                            <FieldLabel htmlFor={`paragraph-${chunk.id}`}>
                              Абзац {ci + 1}
                            </FieldLabel>
                            <Textarea
                              id={`paragraph-${chunk.id}`}
                              disabled={!editable || busy}
                              value={chunk.content}
                              onChange={(e) =>
                                change(
                                  "sections",
                                  content.sections.map((s, i) =>
                                    i === si
                                      ? {
                                          ...s,
                                          chunks: s.chunks.map((c, j) =>
                                            j === ci
                                              ? {
                                                  ...c,
                                                  content: e.target.value,
                                                }
                                              : c
                                          ),
                                        }
                                      : s
                                  )
                                )
                              }
                            />
                          </Field>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            !editable || busy || section.chunks.length >= 12
                          }
                          onClick={() =>
                            change(
                              "sections",
                              content.sections.map((s, i) =>
                                i === si
                                  ? {
                                      ...s,
                                      chunks: [
                                        ...s.chunks,
                                        {
                                          id: crypto.randomUUID(),
                                          content: "",
                                        },
                                      ],
                                    }
                                  : s
                              )
                            )
                          }
                        >
                          <Plus data-icon="inline-start" />
                          Добавить абзац
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                  <Button
                    variant="outline"
                    disabled={
                      !editable || busy || content.sections.length >= 20
                    }
                    onClick={() =>
                      change("sections", [
                        ...content.sections,
                        {
                          id: crypto.randomUUID(),
                          heading: "",
                          level: 2,
                          chunks: [{ id: crypto.randomUUID(), content: "" }],
                        },
                      ])
                    }
                  >
                    <Plus data-icon="inline-start" />
                    Добавить раздел
                  </Button>
                </div>
                <aside
                  className="desk-inspector"
                  aria-label="Параметры черновика"
                >
                  <div className="desk-inspector-section">
                    <h3>
                      <BookOpen size={17} aria-hidden="true" /> Источники
                    </h3>
                    <Field>
                      <Select
                        value=""
                        disabled={!editable || busy}
                        onValueChange={(id) => {
                          const source = sourceCards.find((c) => c.id === id);
                          if (
                            source &&
                            !content.sourceCardIds.includes(source.id)
                          ) {
                            edit({
                              ...content,
                              sourceCardIds: [
                                ...content.sourceCardIds,
                                source.id,
                              ],
                              sourceCardTitles: [
                                ...content.sourceCardTitles,
                                source.title,
                              ],
                            });
                          }
                        }}
                      >
                        <SelectTrigger aria-label="Добавить источник">
                          <SelectValue placeholder="Добавить карточку источника" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {sourceCards
                              .filter(
                                (c) => !content.sourceCardIds.includes(c.id)
                              )
                              .map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.title}
                                </SelectItem>
                              ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {content.sourceCardIds.map((id, i) => (
                        <div className="desk-source-item" key={id}>
                          <a
                            href={`/knowledge?card=${encodeURIComponent(id)}&version=approved`}
                            className="text-sm text-primary underline underline-offset-2"
                          >
                            {content.sourceCardTitles[i] || id}
                          </a>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!editable || busy}
                            onClick={() =>
                              edit({
                                ...content,
                                sourceCardIds: content.sourceCardIds.filter(
                                  (x) => x !== id
                                ),
                                sourceCardTitles:
                                  content.sourceCardTitles.filter(
                                    (_, j) => j !== i
                                  ),
                              })
                            }
                          >
                            Убрать
                          </Button>
                        </div>
                      ))}
                    </Field>

                    {content.sourceCardIds.length === 0 ? (
                      <p className="desk-footnote">
                        Источники ещё не приложены.
                      </p>
                    ) : null}
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void checkText()}
                    >
                      <BadgeCheck data-icon="inline-start" /> Проверить факты
                    </Button>
                  </div>
                  <div className="desk-inspector-section">
                    <h3>
                      <ClipboardCheck size={17} aria-hidden="true" />{" "}
                      Согласование
                    </h3>
                    {doc ? (
                      <p className="text-sm text-muted-foreground">
                        Автор: {doc.ownerName}.{" "}
                        {doc.reviewerName
                          ? `Адресат согласования: ${doc.reviewerName}.`
                          : "Адресат будет назначен при отправке."}
                      </p>
                    ) : null}
                    {editable && doc ? (
                      <Field>
                        <FieldLabel>Ответственный за согласование</FieldLabel>
                        <Select
                          value={reviewerId}
                          onValueChange={(id) => id && setReviewerId(id)}
                        >
                          <SelectTrigger aria-label="Руководитель для согласования">
                            <SelectValue>
                              {reviewers.find((r) => r.id === reviewerId)
                                ?.name || "Нет доступного адресата"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {reviewers.map((r) => (
                                <SelectItem value={r.id} key={r.id}>
                                  {r.name} · {r.organization}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : null}

                    <Button
                      disabled={
                        !editable || busy || conflict || !doc || !reviewerId
                      }
                      onClick={() => void mutate("submit")}
                    >
                      <Send data-icon="inline-start" /> Отправить на
                      согласование
                    </Button>
                    {doc ? (
                      <Button
                        variant="outline"
                        disabled={dirty || busy}
                        nativeButton={false}
                        render={<a href={downloadHref} download />}
                      >
                        <Download data-icon="inline-start" /> Скачать DOCX с
                        источниками
                      </Button>
                    ) : null}
                  </div>
                  {doc && editable ? (
                    <div className="desk-inspector-section">
                      {" "}
                      <div className="flex flex-col gap-2">
                        <Field className="max-w-xs">
                          <FieldLabel htmlFor="editor-channel">
                            Вариант для канала
                          </FieldLabel>
                          <Input
                            id="editor-channel"
                            value={channel}
                            onChange={(e) => setChannel(e.target.value)}
                          />
                        </Field>
                        <Button
                          variant="outline"
                          disabled={busy || !channel.trim() || conflict}
                          onClick={() => void createVariant()}
                        >
                          <GitBranch data-icon="inline-start" />
                          Создать вариант
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </aside>
                {check ? (
                  <div className="desk-editor-check">
                    {" "}
                    <Alert
                      variant={check.summary.red ? "destructive" : "default"}
                    >
                      <AlertTitle>
                        Красных: {check.summary.red} · Требуют уточнения:{" "}
                        {check.summary.yellow} · Подтверждено:{" "}
                        {check.summary.green}
                      </AlertTitle>
                      <AlertDescription>
                        <div className="flex flex-col gap-2">
                          {check.findings.map((f) => (
                            <p key={f.id}>
                              <strong>{f.title}</strong>: {f.quote} —{" "}
                              {f.explanation}
                            </p>
                          ))}
                        </div>
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
          <section
            className="desk-panel desk-history"
            hidden={surface !== "history"}
          >
            <div className="desk-panel-head">
              <div>
                <h2>История редакций</h2>
                {doc ? (
                  <p className="desk-footnote">
                    {doc.content.title || "Без заголовка"}
                  </p>
                ) : null}
              </div>
              {doc ? (
                <Button variant="outline" onClick={refreshHistory}>
                  <RefreshCw data-icon="inline-start" /> Обновить историю
                </Button>
              ) : null}
            </div>
            {doc ? (
              <div className="desk-history-body">
                <div className="desk-revisions">
                  {revisions.map((r) => (
                    <Button
                      key={r.id}
                      size="sm"
                      variant={
                        reviewRevision === r.id ? "secondary" : "outline"
                      }
                      aria-pressed={reviewRevision === r.id}
                      onClick={() => setReviewRevision(r.id)}
                    >
                      Редакция {r.number} ·{" "}
                      {new Date(r.createdAt).toLocaleString("ru-RU")}
                    </Button>
                  ))}
                </div>
                {selectedRevision ? (
                  <>
                    <h3 className="text-base font-semibold">
                      Редакция {selectedRevision.number} ·{" "}
                      {selectedRevision.actorName}
                    </h3>
                    <Textarea
                      readOnly
                      aria-label="Текст выбранной редакции"
                      rows={9}
                      value={editorialText(selectedRevision.content)}
                    />
                    <Button
                      variant="outline"
                      disabled={dirty || busy}
                      nativeButton={false}
                      render={<a href={downloadHref} download />}
                    >
                      <Download data-icon="inline-start" /> Скачать DOCX с
                      источниками
                    </Button>
                    {editable ? (
                      <Button
                        disabled={busy || dirty || conflict}
                        variant="outline"
                        onClick={() =>
                          void mutate("restore", selectedRevision.id)
                        }
                      >
                        <RotateCcw data-icon="inline-start" />
                        Восстановить как новую редакцию
                      </Button>
                    ) : null}
                  </>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="editor-comment">
                    Комментарий к {reviewRevision ? "выбранной" : "текущей"}{" "}
                    редакции
                  </FieldLabel>
                  <Textarea
                    id="editor-comment"
                    disabled={busy}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || !comment.trim()}
                    onClick={() =>
                      void mutate("comment", reviewRevision || doc.revisionId)
                    }
                  >
                    <MessageSquare data-icon="inline-start" />
                    Сохранить комментарий
                  </Button>
                  {doc.reviewerId === currentUser.id &&
                  doc.ownerId !== currentUser.id &&
                  doc.status === "submitted" ? (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy || dirty || !comment.trim()}
                        onClick={() =>
                          void mutate("return", doc.submittedRevisionId!)
                        }
                      >
                        Вернуть на доработку
                      </Button>
                      <Button
                        disabled={busy || dirty || Boolean(check?.summary.red)}
                        onClick={() =>
                          void mutate("approve", doc.submittedRevisionId!)
                        }
                      >
                        <Check data-icon="inline-start" />
                        Согласовать отправленную редакцию
                      </Button>
                    </>
                  ) : null}
                </div>
                {doc.events.map((event) => (
                  <div className="desk-history-event" key={event.id}>
                    <p>
                      {editorialEventLabels[event.action]} · {event.actorName} ·{" "}
                      {new Date(event.at).toLocaleString("ru-RU")}
                    </p>
                    <p className="text-muted-foreground">
                      Редакция: {event.revisionId}
                    </p>
                    {event.comment ? <p>{event.comment}</p> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="desk-workspace-empty">
                <span className="desk-icon" aria-hidden="true">
                  <History />
                </span>
                <p>Откройте черновик, чтобы посмотреть его редакции.</p>
              </div>
            )}
          </section>
        </div>
      ) : null}
      <div hidden={surface !== "library"}>
        <EditorialLibrary
          articles={articles}
          legacy={legacy}
          busy={busy}
          onImport={canWork ? importArchive : undefined}
        />
      </div>
    </div>
  );
}
