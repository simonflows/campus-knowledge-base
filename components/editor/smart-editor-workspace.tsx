"use client";
import {
  MastheadCount,
  WorkspaceMasthead,
} from "@/components/workspace-masthead";
import { useWorkspaceMode, useWorkspaceRequest } from "@/components/demo/workspace-transport";
import { AppLink, useWorkspaceNavigation } from "@/components/navigation/workspace-navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
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
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { CanonAiOption, CanonAiReview, type FactAiReview } from "@/components/canon-ai-review";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { EditorialReadinessPanel } from "./editorial-readiness-panel";
import "@/app/campus-workspaces.css";
import { universities } from "@/lib/data";
import type { SessionUser } from "@/lib/auth";
import {
  articleBasisLocation,
  hasCurrentArticleBasis,
  sameArticleBasisReference,
  type ArticleBasisReference,
  type ReadyArticle,
} from "@/lib/articles";
import type { FactCheckResult } from "@/lib/fact-check";
import type { EditorAssistSuggestion } from "@/lib/editor-assist";
import {
  canDeleteEditorial,
  deleteEditorialSchema,
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
  flashAssistAvailable: boolean;
  initialDocumentId?: string;
  initialArticleId?: string;
};
type SelectedFragment = { chunkId?: string; start: number; end: number };
type AssistSourceVersion = { cardId: string; versionId: string; title: string };
type EditorAssistPreview = {
  documentId: string;
  revisionId: string;
  fingerprint: string;
  channel: string;
  selection: SelectedFragment | null;
  suggestion: EditorAssistSuggestion;
  sourceVersions: AssistSourceVersion[];
  staleSources: AssistSourceVersion[];
};

function AssistSources({ sourceVersions, staleSources }: Pick<EditorAssistPreview, "sourceVersions" | "staleSources">) {
  const stale = new Set(staleSources.map(source => source.cardId));
  return (
    <div className="space-y-2 pt-1 [overflow-wrap:anywhere]">
      {!!stale.size && <p>Некоторые карточки обновились после фиксации версии. Версии, прикреплённые к материалу, сохранены.</p>}
      {sourceVersions.length > 0 && (
        <ul className="space-y-1">
          {sourceVersions.map(({ cardId, versionId, title }) => (
            <li key={cardId}>
              <AppLink href={`/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(versionId)}`}
                prefetch={false} className="text-primary underline underline-offset-2">
                {title} · актуальная версия
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArticleBlockDetails({ reference }: { reference: ArticleBasisReference }) {
  return (
    <div className="min-w-0 space-y-1 text-sm [overflow-wrap:anywhere]">
      <p className="font-medium">{reference.articleTitle}</p>
      {reference.sectionHeading && <p>{reference.sectionHeading}</p>}
      <p className="text-xs text-muted-foreground">{articleBasisLocation(reference)}</p>
    </div>
  );
}
async function requestJson(request: ReturnType<typeof useWorkspaceRequest>, url: string, init?: RequestInit) {
  const response = await request(url, {
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

export async function loadEditorDeepLink<T extends { document: { id: string } }>({
  id, signal, read, flush,
}: {
  id: string; signal: AbortSignal; read: (id: string, signal: AbortSignal) => Promise<T>;
  flush: () => Promise<boolean>;
}): Promise<{ status: "ready"; details: T } | { status: "cancelled" | "blocked" | "unavailable" }> {
  if (signal.aborted) return { status: "cancelled" };
  let details: T;
  try {
    details = await read(id, signal);
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    if (error instanceof Error && "status" in error && [401, 403, 404].includes(Number(error.status))) {
      return { status: "unavailable" };
    }
    throw error;
  }
  if (signal.aborted) return { status: "cancelled" };
  if (details?.document?.id !== id) return { status: "unavailable" };
  const saved = await flush();
  if (signal.aborted) return { status: "cancelled" };
  return saved ? { status: "ready", details } : { status: "blocked" };
}

export async function refreshOpenEditorDraft<T extends { document: Pick<EditorialDocument, "id" | "version"> }>({
  current,
  signal,
  read,
  waitForSave,
  isStillOpen,
  hasLocalChanges,
  accept,
}: {
  current: T["document"];
  signal: AbortSignal;
  read: (id: string, signal: AbortSignal) => Promise<T>;
  waitForSave: () => Promise<unknown> | null;
  isStillOpen: () => boolean;
  hasLocalChanges: () => boolean;
  accept: (details: T, preserveLocalText: boolean) => void;
}): Promise<void> {
  if (signal.aborted || !isStillOpen()) return;
  await waitForSave();
  if (signal.aborted || !isStillOpen()) return;

  const details = await read(current.id, signal);
  // A save may start while the GET is in flight. Its newer baseline wins.
  await waitForSave();
  if (signal.aborted || !isStillOpen()) return;
  if (details?.document?.id !== current.id || details.document.version < current.version) {
    throw new Error("Не удалось загрузить актуальный черновик");
  }
  accept(details, hasLocalChanges());
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
      if (!ownerId) return () => {};
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
  flashAssistAvailable,
  initialDocumentId,
  initialArticleId,
}: Props) {
  const request = useWorkspaceRequest();
  const demo = useWorkspaceMode() === "demo";
  const { pathname, searchParams, replaceHistory } = useWorkspaceNavigation();
  const jsonRequest = useCallback((url: string, init?: RequestInit) => requestJson(request, url, init), [request]);
  const savedStatus = demo ? "Сохранено в этом браузере" : "Сохранено на сервере";
  const [documents, setDocuments] = useState<EditorialDocument[]>([]),
    [articles, setArticles] = useState(initialArticles),
    [legacy, setLegacy] = useState<ReadyArticle[]>([]);
  const [surface, setSurface] = useState<"write" | "history" | "library">(
    initialArticleId || !currentUser || currentUser.role === "guest" ? "library" : "write"
  );
  const [mobileDrafts, setMobileDrafts] = useState(false);
  const draftHeading = useRef<HTMLHeadingElement>(null);
  const generationPanel = useRef<HTMLDetailsElement>(null);
  const generationQuery = useRef<HTMLTextAreaElement>(null);
  const [generationBasis, setGenerationBasis] = useState<ArticleBasisReference | null>(null);
  const showDraft = () => {
    setMobileDrafts(false);
    setSurface("write");
    requestAnimationFrame(() => draftHeading.current?.focus());
  };
  const [sourceCards, setSourceCards] = useState<
    Array<{ id: string; title: string; versionId: string }>
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
  const [operationBusy, setBusy] = useState(false),
    [saveStatus, setSaveStatus] = useState("Изменения ещё не сохранены"),
    [conflict, setConflict] = useState(false),
    [serverDocument, setServerDocument] = useState<EditorialDocument | null>(
      null
    );
  const linkRequest = useRef<AbortController | null>(null);
  const [linkOpening, setLinkOpening] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkRetry, setLinkRetry] = useState(0);
  const [focusedArticleId, setFocusedArticleId] = useState(initialArticleId);
  const [draftToDelete, setDraftToDelete] = useState<EditorialDocument | null>(null);
  const cancelDeletion = useRef<HTMLButtonElement>(null);
  const deletedDraftIds = useRef(new Set<string>());
  const busy = operationBusy || linkOpening;
  const [recoveryStore] = useState(() =>
    recoveryList(demo || currentUser?.role === "guest" ? undefined : currentUser?.id)
  );
  const recoveries = useSyncExternalStore(
    recoveryStore.subscribe,
    recoveryStore.getSnapshot,
    getServerRecoveries
  );
  const [check, setCheck] = useState<(FactCheckResult & { ai?: FactAiReview }) | null>(null),
    [channel, setChannel] = useState("Telegram"),
    [provider, setProvider] = useState(flashAssistAvailable ? "auto" : "canonical");
  const checkRequest = useRef<AbortController | null>(null);
  const editorAssistRequest = useRef<AbortController | null>(null);
  const [editorAssistBusy, setEditorAssistBusy] = useState(false);
  const [editorAssistPreview, setEditorAssistPreview] = useState<EditorAssistPreview | null>(null);
  const [editorAssistIssue, setEditorAssistIssue] = useState("");
  const [useAiCheck, setUseAiCheck] = useState(true);
  const [selectedFragment, setSelectedFragment] = useState<SelectedFragment | null>(null);
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
        const received = (data.documents as EditorialDocument[]).filter(
          (item) => !deletedDraftIds.current.has(item.id)
        );
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
    [jsonRequest, userId]
  );
  useEffect(() => {
    const requests = new AbortController();
    active.current = true;
    void refresh(requests.signal).catch((e) => {
      if (!requests.signal.aborted) toast.error(e.message);
    });
    if (userId && currentUser?.role !== "guest") {
      void jsonRequest("/api/editor/sources", { signal: requests.signal })
        .then((cards: typeof sourceCards) => {
          if (!requests.signal.aborted) setSourceCards(cards);
        })
        .catch(() => {});
    }
    const endSession = () => {
      active.current = false;
      requests.abort();
      checkRequest.current?.abort();
      editorAssistRequest.current?.abort();
      linkRequest.current?.abort();
      recoveryStore.end();
      setEnded(true);
      setSurface("library");
      setDoc(null);
      docRef.current = null;
      contentRef.current = blank();
      setContent(contentRef.current);
      setRevisions([]);
      setLinkError(null);
      setLinkOpening(false);
      setFocusedArticleId(undefined);
      setServerDocument(null);
      setLegacy([]);
      setDocuments([]);
      setDraftToDelete(null);
    };
    const syncSession = (event: StorageEvent) => {
      if (event.key !== EDITORIAL_SESSION_END_KEY) return;
      try {
        editorialRecoveryStorage();
      } catch {}
      endSession();
    };
    if (!demo) {
      window.addEventListener(EDITORIAL_SESSION_ENDED, endSession);
      window.addEventListener("storage", syncSession);
    }
    return () => {
      active.current = false;
      requests.abort();
      checkRequest.current?.abort();
      editorAssistRequest.current?.abort();
      linkRequest.current?.abort();
      window.removeEventListener(EDITORIAL_SESSION_ENDED, endSession);
      window.removeEventListener("storage", syncSession);
    };
  }, [currentUser?.role, demo, jsonRequest, recoveryStore, refresh, userId]);

  const acceptVersion = (next: EditorialDocument | null) => {
    docRef.current = next;
    setDoc(next);
    baselineRef.current = JSON.stringify(next?.content || blank(currentUser));
    setBaseline(baselineRef.current);
    recoveryVersion.current = next?.version || 0;
  };
  const replaceText = (next: EditorialContent) => {
    checkRequest.current?.abort();
    editorAssistRequest.current?.abort();
    setEditorAssistPreview(null);
    setEditorAssistIssue("");
    setSelectedFragment(null);
    contentRef.current = next;
    setContent(next);
    setCheck(null);
  };
  const edit = (next: EditorialContent) => {
    replaceText(next);
    if (!currentUser || !active.current) return;
    const id = docRef.current?.id || null;
    if (!pendingSave.current && JSON.stringify(next) === baselineRef.current) {
      if (!demo) removeEditorialRecovery(currentUser.id, id);
      setSaveStatus(
        docRef.current ? savedStatus : "Новый личный черновик"
      );
    } else {
      const stored = demo || saveEditorialRecovery(
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
    setGenerationBasis(null);
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
          ? savedStatus
          : "Новый личный черновик"
    );
  };
  const readDraft = (id: string, signal?: AbortSignal): Promise<Details> =>
    jsonRequest(`/api/editor/drafts/${encodeURIComponent(id)}`, { signal });
  const load = async (id: string) => {
    const data = await readDraft(id);
    if (active.current) openDocument(data);
  };
  const refreshDraft = async (current: EditorialDocument, signal: AbortSignal) => {
    if (busy) throw new Error("Дождитесь завершения текущего действия.");
    setBusy(true);
    try {
      await refreshOpenEditorDraft<Details>({
        current,
        signal,
        read: readDraft,
        waitForSave: () => pendingSave.current,
        isStillOpen: () => active.current && docRef.current === current,
        hasLocalChanges: () => JSON.stringify(contentRef.current) !== baselineRef.current,
        accept: (data, preserveLocalText) => {
          if (preserveLocalText) {
            setConflict(true);
            setServerDocument(data.document);
            setSaveStatus("Сравните редакции перед сохранением");
            return;
          }
          openDocument(data);
          upsert(data.document);
        },
      });
    } finally {
      if (active.current) setBusy(false);
    }
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
  }, [jsonRequest]);
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
            if (!demo) {
              if (!current) removeEditorialRecovery(currentUser.id, null);
              removeEditorialRecovery(currentUser.id, next.id);
              recoveryStore.refresh();
            }
            setSaveStatus(savedStatus);
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
            !demo && saveEditorialRecovery(
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
  }, [currentUser, conflict, demo, jsonRequest, recoveryStore, handleConflict, savedStatus]);
  useEffect(() => {
    if (!editable || !dirty || conflict || busy || draftToDelete) return;
    const timer = setTimeout(() => void save(), 1200);
    return () => clearTimeout(timer);
  }, [content, dirty, editable, conflict, busy, draftToDelete, save]);
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
    return JSON.stringify(contentRef.current) === baselineRef.current || Boolean(await save());
  };
  const followLink = useEffectEvent(async (controller: AbortController) => {
    const { signal } = controller;
    if (!active.current || signal.aborted || ended) return;
    setLinkError(null);
    if (!initialDocumentId && !initialArticleId) {
      setFocusedArticleId(undefined);
      setLinkOpening(false);
      return;
    }
    if (operationBusy) {
      setLinkOpening(false);
      setLinkError("Дождитесь завершения текущего действия и откройте ссылку повторно.");
      return;
    }
    if (initialDocumentId && (!currentUser || currentUser.role === "guest")) {
      setLinkOpening(false);
      setLinkError("Черновик недоступен. Войдите под рабочим аккаунтом с доступом к этому материалу.");
      return;
    }
    setLinkOpening(true);
    try {
      if (initialDocumentId) {
        if (docRef.current?.id !== initialDocumentId) {
          const result = await loadEditorDeepLink({ id: initialDocumentId, signal, read: readDraft, flush });
          if (!active.current || signal.aborted || result.status === "cancelled") return;
          if (result.status !== "ready") {
            setLinkError(result.status === "blocked"
              ? "Сохраните правки в открытом черновике, затем повторите переход."
              : "Черновик недоступен. Проверьте ссылку и права на материал.");
            return;
          }
          const copy = !demo && currentUser && result.details.document.ownerId === currentUser.id
            ? readEditorialRecovery(currentUser.id).find((entry) => entry.documentId === initialDocumentId)
            : undefined;
          openDocument(result.details, copy);
        }
        setFocusedArticleId(undefined);
        showDraft();
      } else {
        const saved = await flush();
        if (!active.current || signal.aborted) return;
        if (!saved) {
          setLinkError("Сохраните правки в открытом черновике, затем повторите переход.");
          return;
        }
        checkRequest.current?.abort();
        editorAssistRequest.current?.abort();
        setFocusedArticleId(initialArticleId);
        setSurface("library");
      }
    } catch {
      if (active.current && !signal.aborted)
        setLinkError("Не удалось открыть запись. Проверьте соединение и повторите переход.");
    } finally {
      if (active.current && linkRequest.current === controller) setLinkOpening(false);
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    linkRequest.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void followLink(controller); });
    return () => controller.abort();
  }, [initialArticleId, initialDocumentId, linkRetry]);
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
  const deleteDraft = async () => {
    if (!currentUser || !draftToDelete || busy || !active.current) return;
    setBusy(true);
    try {
      await pendingSave.current;
      const current = docRef.current;
      if (!active.current || current?.id !== draftToDelete.id) return;
      if (!canDeleteEditorial(currentUser, current)) {
        toast.error("Этот черновик больше нельзя удалить.");
        setDraftToDelete(null);
        return;
      }
      await jsonRequest(`/api/editor/drafts/${encodeURIComponent(current.id)}`, {
        method: "DELETE",
        body: JSON.stringify(deleteEditorialSchema.parse({ version: current.version })),
      });
      if (!active.current) return;
      deletedDraftIds.current.add(current.id);
      if (!demo) {
        removeEditorialRecovery(currentUser.id, current.id);
        recoveryStore.refresh();
      }
      setDocuments((items) => items.filter((item) => item.id !== current.id));
      setDraftToDelete(null);
      openDocument(null);
      if (searchParams?.get("draft") === current.id) {
        const remaining = new URLSearchParams(searchParams.toString());
        remaining.delete("draft");
        const query = remaining.toString();
        replaceHistory(query ? `${pathname}?${query}` : pathname);
      }
      showDraft();
      toast.success("Черновик удалён");
    } catch (error) {
      if (!active.current) return;
      const failure = error as Error & { status?: number };
      toast.error(failure.message);
      if (failure.status === 409 && docRef.current) {
        setDraftToDelete(null);
        await handleConflict(docRef.current);
      }
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const change = (key: keyof EditorialContent, value: unknown) => {
    edit({ ...contentRef.current, [key]: value });
  };
  const chooseArticleBlock = async (reference: ArticleBasisReference) => {
    if (!canWork || busy) return;
    if (!editable) {
      setBusy(true);
      try {
        if (!(await flush()) || !active.current) return;
        openDocument(null);
      } finally {
        setBusy(false);
      }
    }
    setGenerationBasis(reference);
    showDraft();
    requestAnimationFrame(() => {
      if (generationPanel.current) generationPanel.current.open = true;
      generationQuery.current?.focus();
    });
  };
  const generate = async () => {
    const query = content.query.trim() || content.topic.trim();
    if (!generationBasis && query.length < 10) {
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
          ...(generationBasis && {
            basis: {
              articleId: generationBasis.articleId,
              revisionId: generationBasis.revisionId,
              chunkIds: [generationBasis.chunkId],
            },
          }),
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
          articleBasis: a.articleBasis ?? [],
          audience: c.audience,
          outlet: c.outlet,
          length: c.length,
          universityId: c.universityId || a.suggestedUniversityId || "",
          topic: c.topic || a.topic,
          query,
        })
      );
      if (provider !== "canonical" && result.providerMeta?.provider === "canonical") {
        toast("Черновик собран по карточкам", {
          description: "Использована подготовка по структурированным данным Канона.",
        });
      } else {
        toast.success("Текст добавлен в личный черновик");
      }
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
    if (checkRequest.current) return;
    const controller = new AbortController();
    checkRequest.current = controller;
    setBusy(true);
    try {
      const result = await jsonRequest("/api/fact-check", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          text: editorialText(content),
          mode: "check",
          ...(flashAssistAvailable && useAiCheck && { useAi: true }),
        }),
      });
      if (active.current && !controller.signal.aborted) setCheck(result);
    } catch (e) {
      if (!controller.signal.aborted) toast.error((e as Error).message);
    } finally {
      checkRequest.current = null;
      setBusy(false);
    }
  };
  const createVariant = async (suggestedContent?: EditorialContent) => {
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
          content: { ...(suggestedContent ?? contentRef.current), outlet: channel },
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
  const rememberFragment = (field: HTMLTextAreaElement, chunkId?: string) => {
    const { selectionStart: start, selectionEnd: end } = field;
    if (selectedFragment?.chunkId === chunkId && selectedFragment?.start === start && selectedFragment?.end === end) return;
    editorAssistRequest.current?.abort();
    setEditorAssistPreview(null);
    setSelectedFragment(start < end ? { chunkId, start, end } : null);
  };
  const requestEditorialAssist = async (action: "rewrite" | "variant") => {
    if (editorAssistRequest.current || !editable || conflict) return;
    const selection = selectedFragment;
    if (action === "rewrite" && !selection) return;
    const fingerprint = JSON.stringify(contentRef.current);
    const controller = new AbortController();
    editorAssistRequest.current = controller;
    setEditorAssistBusy(true);
    setEditorAssistPreview(null);
    setEditorAssistIssue("");
    try {
      if (!(await flush()) || controller.signal.aborted || !active.current ||
          fingerprint !== JSON.stringify(contentRef.current)) return;
      const current = docRef.current;
      if (!current) return;
      const payload = await jsonRequest("/api/editor/assist", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          action, documentId: current.id, revisionId: current.revisionId, version: current.version,
          ...(action === "rewrite" ? selection : { channel }),
        }),
      });
      if (!active.current || controller.signal.aborted || docRef.current !== current ||
          fingerprint !== JSON.stringify(contentRef.current)) return;
      if (payload.status !== "ready") {
        const messages: Record<string, string> = {
          busy: "ИИ занят. Повторите чуть позже.",
          unavailable: "ИИ сейчас недоступен. Редактирование остаётся доступным.",
          "too-long": "Выделите более короткий фрагмент или уменьшите объём материала.",
          "sources-required": "Прикрепите карточки с доступными утверждёнными версиями.",
        };
        setEditorAssistIssue(payload.sourcesChanged
          ? "Карточки обновились во время подготовки предложения. Повторите запрос. Версии в материале сохранены."
          : messages[payload.status] || "ИИ не предложил правку, которую удалось сверить с источниками.");
        return;
      }
      setEditorAssistPreview({ documentId: current.id, revisionId: current.revisionId, fingerprint, channel, selection,
        suggestion: payload.suggestion,
        sourceVersions: payload.sourceVersions ?? [],
        staleSources: payload.staleSources ?? [],
      });
    } catch (error) {
      if (!controller.signal.aborted && active.current) toast.error((error as Error).message);
    } finally {
      if (editorAssistRequest.current === controller) {
        editorAssistRequest.current = null;
        if (active.current) setEditorAssistBusy(false);
      }
    }
  };
  const acceptEditorialAssist = () => {
    const preview = editorAssistPreview;
    const current = docRef.current;
    const text = contentRef.current;
    if (!preview || !editable || current?.id !== preview.documentId || current.revisionId !== preview.revisionId ||
        JSON.stringify(text) !== preview.fingerprint || channel !== preview.channel) return;
    const suggestion = preview.suggestion;
    if (suggestion.action === "variant") {
      const section = { id: crypto.randomUUID(), heading: "Основной текст", level: 2 as const,
        chunks: [{ id: crypto.randomUUID(), content: suggestion.body }] };
      setEditorAssistPreview(null);
      void createVariant({ ...text, title: suggestion.title, lead: suggestion.lead, sections: [section] });
      return;
    }
    const fragment = preview.selection;
    if (!fragment) return;
    const replace = (value: string) => value.slice(0, fragment.start) + suggestion.text + value.slice(fragment.end);
    const selectedText = fragment.chunkId
      ? text.sections.flatMap((section) => section.chunks).find((chunk) => chunk.id === fragment.chunkId)?.content
      : text.lead;
    if (selectedText === undefined || replace(selectedText).length > 4_000) {
      toast.error("После замены поле превысит 4 000 знаков. Выберите более короткую правку.");
      return;
    }
    if (!fragment.chunkId) {
      change("lead", replace(text.lead));
      return;
    }
    change("sections", text.sections.map((section) => ({
      ...section,
      chunks: section.chunks.map((chunk) =>
        chunk.id === fragment.chunkId ? { ...chunk, content: replace(chunk.content) } : chunk,
      ),
    })));
  };
  const recover = async (selected: EditorialRecovery) => {
    if (demo || !currentUser || !active.current) return;
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
  const downloadDemoDocx = async () => {
    if (!doc || !downloadHref) return;
    try {
      const response = await request(downloadHref);
      if (!response.ok) throw new Error("Не удалось скачать DOCX");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `article-${doc.id}.docx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const downloadProps = demo
    ? { onClick: () => void downloadDemoDocx() }
    : { nativeButton: false, render: <a href={downloadHref} download /> };

  return (
    <div className="atlas-wrap campus-workspace desk-editor">
      <Dialog
        open={!!draftToDelete}
        onOpenChange={(open) => { if (!open && !operationBusy) setDraftToDelete(null); }}
      >
        <DialogContent showCloseButton={false} initialFocus={cancelDeletion}>
          <DialogHeader>
            <DialogTitle>Удалить черновик?</DialogTitle>
            <DialogDescription>
              «{draftToDelete?.content.title || draftToDelete?.content.topic || "Без заголовка"}» исчезнет из списка.
              {dirty && " Несохранённые изменения будут удалены."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancelDeletion} variant="outline" disabled={operationBusy} onClick={() => setDraftToDelete(null)}>
              Отмена
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void deleteDraft()}>
              {operationBusy ? "Удаляем…" : "Удалить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WorkspaceMasthead
        id="editor-page-title"
        icon={SquarePen}
        title="Умный редактор"
        description="Готовьте статьи по официальным данным, проверяйте факты и согласовывайте редакции."
      >
        <MastheadCount count={cardsCount} label="карточек в справочнике">
          <AppLink href="/knowledge" className="desk-text-link">
            База знаний <ArrowRight size={15} aria-hidden="true" />
          </AppLink>
        </MastheadCount>
      </WorkspaceMasthead>
      {linkOpening && <p role="status" className="desk-footnote mb-3">Открываем запись…</p>}
      {linkError && (
        <Alert className="mb-4">
          <AlertTitle>Ссылка не открыта</AlertTitle>
          <AlertDescription>
            <p>{linkError}</p>
            {canWork && <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => setLinkRetry((value) => value + 1)}>Повторить переход</Button>}
          </AlertDescription>
        </Alert>
      )}
      {canWork ? (
        <div className="desk-nav" role="group" aria-label="Разделы редактора">
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-pressed={surface === id}
              onClick={() => {
                if (id !== "write") checkRequest.current?.abort();
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
          <AppLink href="/login" className="desk-text-link">
            Войти в аккаунт <ArrowRight size={16} />
          </AppLink>
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
                  {doc && currentUser && canDeleteEditorial(currentUser, doc) && (
                    <Button
                      disabled={busy || conflict}
                      variant="ghost"
                      onClick={() => setDraftToDelete(doc)}
                    >
                      <Trash2 data-icon="inline-start" /> Удалить черновик
                    </Button>
                  )}
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
                                  setSaveStatus(savedStatus);
                                  if (!demo) {
                                    removeEditorialRecovery(currentUser.id, serverDocument.id);
                                    recoveryStore.refresh();
                                  }
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

                  <details className="desk-disclosure desk-generation" ref={generationPanel}>
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
                            ref={generationQuery}
                            disabled={!editable || busy}
                            value={content.query}
                            onChange={(e) => change("query", e.target.value)}
                            placeholder="Например: статья о виртуальном тренажёре травмпункта МИДиС и ЮУГМУ"
                          />
                        </Field>
                      </FieldGroup>
                      {generationBasis ? (
                        <div className="space-y-2 rounded-lg border p-3">
                          <p className="text-xs font-medium text-muted-foreground">Выбранный утверждённый блок</p>
                          <ArticleBlockDetails reference={generationBasis} />
                          <Button type="button" variant="ghost" size="sm" disabled={busy}
                            onClick={() => setGenerationBasis(null)}>Снять выбор блока</Button>
                        </div>
                      ) : (
                        <Button type="button" variant="outline" size="sm" disabled={!editable || busy}
                          onClick={() => setSurface("library")}>Выбрать блок из библиотеки</Button>
                      )}
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
                      {provider !== "canonical" && (
                        <p className="desk-footnote">
                          {demo ? "Учебный текст собирается в браузере, без отправки запроса во внешнюю нейросеть." : "Тема запроса и данные утверждённых источников передаются в Yandex AI Studio."}
                          Можно выбрать подготовку по проверенным фактам в Каноне.
                        </p>
                      )}
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
                        onSelect={(event) => rememberFragment(event.currentTarget)}
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
                              onSelect={(event) => rememberFragment(event.currentTarget, chunk.id)}
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
                              sourceVersions: [
                                ...(content.sourceVersions ?? []),
                                { cardId: source.id, versionId: source.versionId },
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
                      {content.sourceCardIds.map((id, i) => {
                        const pinned = content.sourceVersions?.find((source) => source.cardId === id);
                        return (
                        <div className="desk-source-item" key={id}>
                          <AppLink
                            href={`/knowledge?card=${encodeURIComponent(id)}${pinned ? `&version=${encodeURIComponent(pinned.versionId)}` : ""}`}
                            className="text-sm text-primary underline underline-offset-2"
                          >
                            {content.sourceCardTitles[i] || id}{!pinned && " · версия не зафиксирована"}
                          </AppLink>
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
                                ...(content.sourceVersions && { sourceVersions: content.sourceVersions.filter((source) => source.cardId !== id) }),
                              })
                            }
                          >
                            Убрать
                          </Button>
                        </div>
                        );
                      })}
                    </Field>

                    {content.sourceCardIds.length === 0 ? (
                      <p className="desk-footnote">
                        Источники ещё не приложены.
                      </p>
                    ) : null}
                    {!!content.articleBasis?.length && (
                      <details className="desk-disclosure">
                        <summary>Опорные блоки черновика</summary>
                        <ul className="space-y-2">
                          {content.articleBasis.map((reference) => {
                            const current = articles.some((article) => hasCurrentArticleBasis(article, reference));
                            return (
                              <li key={JSON.stringify([reference.articleId, reference.revisionId, reference.chunkId])}>
                                <ArticleBlockDetails reference={reference} />
                                <p className="desk-footnote">
                                  {current
                                    ? "Редакция доступна в библиотеке"
                                    : "Историческая опора · блок изменился или снят с публикации"}
                                </p>
                                {editable && !current && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => change("articleBasis", content.articleBasis?.filter(
                                      (item) => !sameArticleBasisReference(item, reference)
                                    ))}
                                  >
                                    Убрать историческую опору
                                  </Button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                    {flashAssistAvailable && (
                      <CanonAiOption kind="fact" checked={useAiCheck} disabled={busy} onChange={setUseAiCheck} />
                    )}
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
                        {...downloadProps}
                      >
                        <Download data-icon="inline-start" /> Скачать DOCX с
                        источниками
                      </Button>
                    ) : null}
                  </div>
                  {doc && (
                    <EditorialReadinessPanel
                      key={doc.id}
                      document={doc}
                      dirty={dirty}
                      onRefreshDraft={(signal) => refreshDraft(doc, signal)}
                    />
                  )}
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
                            onChange={(e) => {
                              editorAssistRequest.current?.abort();
                              setEditorAssistPreview(null);
                              setEditorAssistIssue("");
                              setChannel(e.target.value);
                            }}
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
                        {flashAssistAvailable && (
                          <>
                            <p className="desk-footnote">
                              {demo ? "Учебный вариант готовится в браузере без внешней нейросети. Проверьте его перед применением." : "Текст и актуальные утверждённые карточки будут переданы в Yandex AI Studio. Предложение можно проверить перед применением."}
                            </p>
                            <Button variant="outline" disabled={busy || editorAssistBusy || conflict || !selectedFragment}
                              onClick={() => void requestEditorialAssist("rewrite")}>
                              <Sparkles data-icon="inline-start" /> Переписать выделенное с ИИ
                            </Button>
                            <Button variant="outline" disabled={busy || editorAssistBusy || conflict || !channel.trim()}
                              onClick={() => void requestEditorialAssist("variant")}>
                              <Sparkles data-icon="inline-start" /> Подготовить вариант с ИИ
                            </Button>
                            {editorAssistBusy && <p role="status" className="text-sm">ИИ готовит предложение…</p>}
                            {editorAssistIssue && <p role="status" className="text-sm">{editorAssistIssue}</p>}
                            {editorAssistPreview && (
                              <Alert>
                                <AlertTitle>Предложение ИИ</AlertTitle>
                                <AlertDescription>
                                  <p className="whitespace-pre-wrap">{editorAssistPreview.suggestion.action === "rewrite"
                                    ? editorAssistPreview.suggestion.text
                                    : [editorAssistPreview.suggestion.title, editorAssistPreview.suggestion.lead, editorAssistPreview.suggestion.body].join("\n\n")}</p>
                                  <AssistSources sourceVersions={editorAssistPreview.sourceVersions} staleSources={editorAssistPreview.staleSources} />
                                  <Button size="sm" variant="outline" onClick={acceptEditorialAssist}>
                                    {editorAssistPreview.suggestion.action === "rewrite" ? "Применить к выделенному" : "Создать черновик варианта"}
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => setEditorAssistPreview(null)}>Отменить</Button>
                                </AlertDescription>
                              </Alert>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ) : null}
                </aside>
                {check ? (
                  <div className="desk-editor-check flex min-w-0 flex-col gap-3">
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
                    {check.ai && <CanonAiReview review={check.ai} />}
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
                      {...downloadProps}
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
          focusedArticleId={focusedArticleId}
          legacy={legacy}
          busy={busy}
          onImport={canWork ? importArchive : undefined}
          onUseBlock={canWork ? (reference) => void chooseArticleBlock(reference) : undefined}
        />
      </div>
    </div>
  );
}
