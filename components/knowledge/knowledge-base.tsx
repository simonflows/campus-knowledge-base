"use client";
import { WorkspaceMasthead } from "@/components/workspace-masthead";
import { AnimatedNumber } from "@/components/motion/animated-number";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  BookOpen,
  FileText,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  FolderTree,
  Globe2,
  Handshake,
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

import { AppLink as Link, useWorkspaceNavigation } from "@/components/navigation/workspace-navigation";
import {
  searchKnowledgeCards,
  getSearchFragment,
} from "@/lib/knowledge-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { getFolderDisplayName, getFolderDisplayPath } from "./folder-labels";
import { KnowledgeCardDetail } from "@/components/knowledge/knowledge-card-detail";
import { KnowledgeCardForm } from "@/components/knowledge/knowledge-card-form";
import { ImportedDraftNotice } from "@/components/knowledge/imported-draft-notice";
import { KnowledgeModerationPanel } from "@/components/knowledge/knowledge-moderation-panel";
import { KnowledgeTree } from "@/components/knowledge/knowledge-tree";
import { KnowledgeTypeConstructor } from "@/components/knowledge/knowledge-type-constructor";
import { HistoricalKnowledgeVersion, KnowledgeVersionPanel } from "@/components/knowledge/knowledge-version-panel";
import {
  canCreateCard,
  canManageTypes,
  canModerate,
  roleShortLabels,
  type CardOwnerCandidate,
  type SessionUser,
} from "@/lib/auth";
import { diskSyncStatusLabels } from "@/lib/disk-sync";
import type { ReadyArticle } from "@/lib/articles";
import {
  buildKnowledgeTree,
  CARD_STATUSES,
  cardStatusLabels,
  findFolder,
  folderIds,
  getCardStatus,
  getCardsForFolder,
  getCardTypeLabel,
  getUniversityFullName,
  isJointProject,
  isJointReferenceForFolder,
  placementStatusLabels,
  type CardStatus,
  type CardTypeWithStats,
  type KnowledgeCard,
  type KnowledgeCardType,
} from "@/lib/knowledge";
import { cn } from "@/lib/utils";
import { cardTypeIcons as cardIcons } from "./knowledge-icons";

type KnowledgeBaseProps = {
  initialCards: KnowledgeCard[];
  initialCustomTypes: CardTypeWithStats[];
  initialCardId?: string | null;
  initialAction?: string | null;
  initialFolderId?: string | null;
  initialQuery?: string;
  initialFolderArticles?: Pick<ReadyArticle, "id" | "title">[] | null;
  dbAvailable: boolean;
  currentUser: SessionUser | null;
  ownerCandidates?: CardOwnerCandidate[];
};

export function KnowledgeBase({
  initialCards,
  initialCustomTypes,
  initialCardId,
  initialAction,
  initialFolderId,
  initialQuery = "",
  initialFolderArticles,
  dbAvailable,
  currentUser,
  ownerCandidates,
}: KnowledgeBaseProps) {
  const router = useWorkspaceNavigation();
  const params = router.searchParams;
  const requestedVersion = params.get("version");
  const historicalVersion = requestedVersion === "approved" ? null : requestedVersion;
  const requestedVersionCard = params.get("card");
  const requestedFolder = params.get("folder") ?? initialFolderId;
  const requestedQuery = params.get("q") ?? (params.size === 0 ? initialQuery : "");
  const [cards, setCards] = useState<KnowledgeCard[]>(initialCards);
  const [customTypes, setCustomTypes] =
    useState<CardTypeWithStats[]>(initialCustomTypes);
  const initialCard = initialCardId
    ? (initialCards.find((card) => card.id === initialCardId) ?? null)
    : null;
  const [selectedFolderId, setSelectedFolderId] = useState(
    () => requestedFolder && findFolder(requestedFolder, buildKnowledgeTree(initialCustomTypes))
      ? requestedFolder
      : initialCard?.folderId ?? folderIds.campus
  );
  const [selectedCardId, setSelectedCardId] = useState<string | null>(
    initialCard?.id ?? null
  );
  const canAddCard = canCreateCard(currentUser) && dbAvailable;
  const [showForm, setShowForm] = useState(
    Boolean(initialAction === "new" && canAddCard)
  );
  const [showConstructor, setShowConstructor] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [isMobileTreeOpen, setIsMobileTreeOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState(requestedQuery);
  const [globalSearch, setGlobalSearch] = useState(
    params.get("scope") === "all" || (!requestedFolder && Boolean(requestedQuery.trim()))
  );
  const [typeFilter, setTypeFilter] = useState<"all" | KnowledgeCardType>(() => {
    const candidate = params.get("type");
    return candidate && Object.hasOwn(cardIcons, candidate) ? candidate as KnowledgeCardType : "all";
  });
  const [statusFilter, setStatusFilter] = useState<"all" | CardStatus>(
    CARD_STATUSES.find((status) => status === params.get("status")) ?? "all"
  );

  const tree = useMemo(() => buildKnowledgeTree(customTypes), [customTypes]);
  const selectedFolder = findFolder(selectedFolderId, tree);
  const hasFilters =
    searchQuery.trim().length > 0 ||
    typeFilter !== "all" ||
    statusFilter !== "all";
  const showingArticles = !globalSearch && Boolean(selectedFolder?.universityId &&
    selectedFolderId === folderIds.subfolder(selectedFolder.universityId, "articles"));
  const folderArticles = selectedFolderId === initialFolderId ? initialFolderArticles : undefined;
  const articleQuery = searchQuery.trim().toLocaleLowerCase("ru");
  const visibleArticles = folderArticles?.filter((article) =>
    article.title.toLocaleLowerCase("ru").includes(articleQuery)
  );
  const scopedCards = useMemo(
    () => globalSearch ? cards : getCardsForFolder(selectedFolderId, cards, tree),
    [globalSearch, selectedFolderId, cards, tree]
  );

  const folderCards = useMemo(() => {
    if (!hasFilters) return scopedCards;
    return searchKnowledgeCards(scopedCards, searchQuery).filter(
      (card) =>
        (typeFilter === "all" || card.type === typeFilter) &&
        (statusFilter === "all" || getCardStatus(card) === statusFilter)
    );
  }, [
    hasFilters,
    scopedCards,
    searchQuery,
    typeFilter,
    statusFilter,
  ]);
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;
  const editingCard = editingCardId
    ? (cards.find((card) => card.id === editingCardId) ?? null)
    : null;
  const pendingCards = useMemo(
    () => cards.filter((card) => getCardStatus(card) === "pending"),
    [cards]
  );
  const jointCount = cards.filter((card) => isJointProject(card)).length;
  const plannedLabCount = cards.filter(
    (card) => card.type === "laboratory" && card.placementStatus === "planned"
  ).length;
  const canUseConstructor = canManageTypes(currentUser);
  const canModerateCards = canModerate(currentUser) && dbAvailable;

  const resetFilters = () => {
    setGlobalSearch(false);
    setSearchQuery("");
    setTypeFilter("all");
    setStatusFilter("all");
  };

  const catalogParams = () => {
    const next = new URLSearchParams({ folder: selectedFolderId });
    if (globalSearch) next.set("scope", "all");
    if (searchQuery.trim()) next.set("q", searchQuery.trim());
    if (typeFilter !== "all") next.set("type", typeFilter);
    if (statusFilter !== "all") next.set("status", statusFilter);
    return next;
  };

  const handleSelectFolder = (folderId: string) => {
    const next = new URLSearchParams({ folder: folderId });
    if (params.toString() !== next.toString()) {
      router.push(`/knowledge?${next}`, { scroll: false });
    }
    setSelectedFolderId(folderId);
    setSelectedCardId(null);
    setEditingCardId(null);
    setShowForm(false);
    setIsMobileTreeOpen(false);
    resetFilters();
  };

  const handleCardDeleted = (cardId: string) => {
    const removed = cards.find((c) => c.id === cardId);
    setCards((current) => current.filter((c) => c.id !== cardId));
    if (removed?.type === "custom") {
      const typeId = removed.customTypeId;
      setCustomTypes((current) =>
        current.map((t) =>
          t.id === typeId
            ? { ...t, cardCount: Math.max(0, t.cardCount - 1) }
            : t
        )
      );
    }
    setSelectedCardId(null);
    setEditingCardId(null);
  };

  const handleOpenCard = (cardId: string) => {
    const next = catalogParams();
    if (params.toString() !== next.toString()) {
      router.replaceHistory(`/knowledge?${next}`);
    }
    next.set("card", cardId);
    router.push(`/knowledge?${next}`, { scroll: false });
    setSelectedCardId(cardId);
    setEditingCardId(null);
    setShowForm(false);
  };

  const handleCreated = (card: KnowledgeCard) => {
    setCards((current) => [...current, card]);

    if (card.type === "custom") {
      const typeId = card.customTypeId;
      setCustomTypes((current) =>
        current.map((type) =>
          type.id === typeId ? { ...type, cardCount: type.cardCount + 1 } : type
        )
      );
    }

    setSelectedFolderId(card.folderId);
    setSelectedCardId(card.id);
    setShowForm(false);
    setEditingCardId(null);
  };

  const handleCardUpdated = (card: KnowledgeCard) => {
    setCards((current) =>
      current.map((item) => (item.id === card.id ? card : item))
    );
  };

  const handleCardSaved = (card: KnowledgeCard) => {
    handleCardUpdated(card);
    setEditingCardId(null);
  };

  const handleTypeCreated = (type: CardTypeWithStats) => {
    setCustomTypes((current) => [...current, type]);
    setSelectedFolderId(type.organizationScope === "chkk" ? folderIds.chkkParameters : folderIds.customType(type.id));
    setSelectedCardId(null);
    setShowForm(false);
  };

  const handleTypeUpdated = (type: CardTypeWithStats) => {
    setCustomTypes((current) =>
      current.map((item) => (item.id === type.id ? type : item))
    );
  };

  const handleTypeDeleted = (typeId: string) => {
    setCustomTypes((current) => current.filter((type) => type.id !== typeId));

    if (selectedFolderId === folderIds.customType(typeId)) {
      setSelectedFolderId(folderIds.campus);
      setSelectedCardId(null);
    }
  };

  return (
    <div className="atlas-wrap data-workspace data-index">
      <WorkspaceMasthead
        id="knowledge-title"
        icon={BookOpen}
        title="База знаний"
        description="Общие параметры кампуса, вузы-резиденты и совместные проекты."
      >
        <div className="data-index-meta">
          <dl className="data-index-stats">
            <div>
              <dt>Карточки</dt>
              <dd>
                <AnimatedNumber value={cards.length} />
              </dd>
            </div>
            <div>
              <dt>Вузы</dt>
              <dd>
                <AnimatedNumber value={7} />
              </dd>
            </div>
            <div>
              <dt>Совместные проекты</dt>
              <dd>
                <AnimatedNumber value={jointCount} />
              </dd>
            </div>
          </dl>
          <span className="data-index-role">
            {currentUser ? (
              <ShieldCheck aria-hidden="true" />
            ) : (
              <LockKeyhole aria-hidden="true" />
            )}
            {currentUser
              ? roleShortLabels[currentUser.role]
              : "Гостевой просмотр"}
          </span>
        </div>
      </WorkspaceMasthead>

      <div className="data-index-grid">
        <aside className="data-index-sidebar">
          <div className="mb-3 lg:hidden">
            <Button
              type="button"
              variant="outline"
              className="data-index-mobile-tree w-full justify-between"
              aria-expanded={isMobileTreeOpen}
              aria-controls="knowledge-tree-panel"
              onClick={() => setIsMobileTreeOpen((open) => !open)}
            >
              <span className="flex items-center gap-2 truncate">
                <FolderTree className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">
                  Папка:{" "}
                  {selectedFolder
                    ? getFolderDisplayName(selectedFolder)
                    : "Выбрать"}
                </span>
              </span>
              {isMobileTreeOpen ? (
                <ChevronUp className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0" />
              )}
            </Button>
          </div>
          <Card
            id="knowledge-tree-panel"
            className={cn(
              "data-index-tree",
              !isMobileTreeOpen && "hidden lg:block"
            )}
          >
            <CardContent className="max-h-[60vh] overflow-y-auto px-2 lg:max-h-[calc(100vh-12rem)]">
              <KnowledgeTree
                cards={cards}
                tree={tree}
                selectedFolderId={selectedFolderId}
                onSelect={handleSelectFolder}
              />
            </CardContent>
            <div className="data-index-note">
              Объектов со статусом «Планируется к открытию в УНК кампуса»:{" "}
              {plannedLabCount}.
            </div>
          </Card>
        </aside>

        <section className="data-index-results min-w-0 space-y-5">
          {canModerateCards && <ImportedDraftNotice cards={pendingCards} />}
          {canModerateCards ? (
            <KnowledgeModerationPanel
              cards={pendingCards}
              onCardUpdated={handleCardUpdated}
              onOpenCard={handleOpenCard}
            />
          ) : null}

          {selectedCard && editingCard ? (
            <KnowledgeCardForm
              key={editingCard.id}
              cards={cards}
              customTypes={customTypes}
              dbAvailable={dbAvailable}
              currentUser={currentUser}
              ownerCandidates={ownerCandidates}
              initialCard={editingCard}
              onCreated={handleCreated}
              onUpdated={handleCardSaved}
              onCancel={() => setEditingCardId(null)}
            />
          ) : historicalVersion && requestedVersionCard ? (
            <HistoricalKnowledgeVersion
              key={`${requestedVersionCard}:${historicalVersion}`}
              cardId={requestedVersionCard}
              versionId={historicalVersion}
              onOpenCurrent={() => setSelectedCardId(requestedVersionCard)}
            >
              {(snapshot) => <KnowledgeCardDetail
                card={snapshot}
                cards={[]}
                customTypes={customTypes}
                tree={tree}
                dbAvailable={false}
                currentUser={null}
                readOnlyVersion
                onBack={() => {
                  setSelectedCardId(snapshot.id);
                  router.push("/knowledge?" + new URLSearchParams({ card: snapshot.id }), { scroll: false });
                }}
                onOpenFolder={handleSelectFolder}
                onEdit={() => {}}
                onCardUpdated={() => {}}
              />}
            </HistoricalKnowledgeVersion>
          ) : selectedCard ? (
            <KnowledgeCardDetail
              card={selectedCard}
              cards={cards}
              customTypes={customTypes}
              tree={tree}
              dbAvailable={dbAvailable}
              currentUser={currentUser}
              additionalSections={<KnowledgeVersionPanel
                key={`${selectedCard.id}:${selectedCard.updatedAt}`}
                card={selectedCard}
                currentUser={currentUser}
                ownerCandidates={ownerCandidates ?? []}
                dbAvailable={dbAvailable}
                onUpdated={handleCardUpdated}
              />}
              onBack={() => {
                router.push(`/knowledge?${catalogParams()}`, { scroll: false });
                setSelectedCardId(null);
              }}
              onOpenFolder={handleSelectFolder}
              onEdit={() => setEditingCardId(selectedCard.id)}
              onCardUpdated={handleCardUpdated}
              onCardDeleted={handleCardDeleted}
            />
          ) : (
            <>
              <Card className="data-index-toolbar">
                <CardHeader className="gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      {(globalSearch || selectedFolderId.includes("/")) && (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          {globalSearch ? (
                            <Globe2
                              aria-hidden="true"
                              className="size-3 shrink-0"
                            />
                          ) : (
                            <FolderOpen
                              aria-hidden="true"
                              className="size-3 shrink-0"
                            />
                          )}
                          {globalSearch
                            ? "Во всех папках"
                            : getFolderDisplayPath(selectedFolderId, tree)}
                        </p>
                      )}
                      <h2 className="font-heading text-xl font-semibold tracking-tight break-words sm:text-2xl">
                        {globalSearch
                          ? "Результаты поиска и фильтрации"
                          : selectedFolder
                            ? getFolderDisplayName(selectedFolder)
                            : "База знаний"}
                      </h2>
                      {!globalSearch && selectedFolder?.description && (
                        <CardDescription>{selectedFolder.description}</CardDescription>
                      )}
                    </div>
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                      {canUseConstructor ? (
                        <Button
                          type="button"
                          className="h-10 flex-1 sm:h-8 sm:flex-none"
                          variant={showConstructor ? "outline" : "secondary"}
                          onClick={() => {
                            setShowConstructor((value) => !value);
                            setShowForm(false);
                          }}
                        >
                          <Settings2 className="h-4 w-4" />
                          {showConstructor
                            ? "Скрыть конструктор"
                            : "Конструктор типов"}
                        </Button>
                      ) : null}
                      {globalSearch && searchQuery.trim() && currentUser?.role !== "author" && (
                        <Link
                          href={`/requests?${new URLSearchParams({ q: `Нужны сведения по запросу: ${searchQuery}` }).toString()}`}
                          className="text-primary underline underline-offset-4"
                        >
                          Запросить данные у другого вуза
                        </Link>
                      )}
                      {canAddCard && !showingArticles ? (
                        <Button
                          type="button"
                          className="h-10 flex-1 sm:h-8 sm:flex-none"
                          onClick={() => {
                            setShowForm((value) => !value);
                            setShowConstructor(false);
                          }}
                          variant={showForm ? "outline" : "default"}
                        >
                          <Plus className="h-4 w-4" />
                          {showForm ? "Скрыть форму" : "Добавить карточку"}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <div role="status" aria-atomic="true">
                      {showingArticles ? (
                        visibleArticles ? <Badge variant="secondary">Статьи: {visibleArticles.length}</Badge> : null
                      ) : (
                        <Badge variant="secondary">
                          {hasFilters
                            ? `Найдено: ${folderCards.length} из ${scopedCards.length}`
                            : `Карточки: ${folderCards.length}`}
                        </Badge>
                      )}
                    </div>
                    {!globalSearch && selectedFolder?.universityId && selectedFolder.kind !== "university" ? (
                      <span>
                        {getUniversityFullName(selectedFolder.universityId)}
                      </span>
                    ) : null}
                  </div>

                  <div className="data-index-search" data-articles={showingArticles || undefined}>
                    <div className="relative">
                      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={searchInput}
                        aria-label={globalSearch ? "Поиск по всей базе" : "Поиск в текущей папке"}
                        name="q"
                        type="search"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={showingArticles ? "Название статьи" : globalSearch
                          ? "Название, вуз, партнёр"
                          : "Поиск в папке"}
                        className="h-10 pl-9 pr-8"
                      />
                      {searchQuery ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery("");
                            searchInput.current?.focus();
                          }}
                          aria-label="Очистить поиск"
                          className="data-index-clear text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>

                    {!showingArticles && (<select
                      aria-label="Фильтр по типу карточки"
                      value={typeFilter}
                      onChange={(event) =>
                        setTypeFilter(
                          event.target.value as "all" | KnowledgeCardType
                        )
                      }
                      className="h-10 rounded-md border border-input bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="all">Все типы</option>
                      <option value="project">Проекты и продукты</option>
                      <option value="laboratory">Лаборатории</option>
                      <option value="university">Паспорт вуза</option>
                      <option value="campus">Паспорт кампуса</option>
                      <option value="custom">Пользовательские</option>
                    </select>)}

                    {!showingArticles && (<select
                      aria-label="Фильтр по статусу модерации"
                      value={statusFilter}
                      onChange={(event) =>
                        setStatusFilter(
                          event.target.value as "all" | CardStatus
                        )
                      }
                      className="h-10 rounded-md border border-input bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="all">Любой статус</option>
                      <option value="approved">Утверждена</option>
                      <option value="pending">На подтверждении</option>
                      <option value="rejected">Отклонена</option>
                    </select>)}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant={globalSearch ? "secondary" : "outline"}
                      size="sm"
                      aria-pressed={globalSearch}
                      className="min-h-10 sm:min-h-8"
                      onClick={() => setGlobalSearch((active) => !active)}
                    >
                      <Globe2 data-icon="inline-start" aria-hidden="true" />
                      Искать по всей базе
                    </Button>
                    {hasFilters || globalSearch ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-10 gap-1 text-xs sm:min-h-8"
                        onClick={() => {
                          resetFilters();
                          const next = new URLSearchParams({ folder: selectedFolderId });
                          if (params.toString() !== next.toString()) {
                            router.replaceHistory(`/knowledge?${next}`);
                          }
                          searchInput.current?.focus();
                        }}
                      >
                        <X data-icon="inline-start" aria-hidden="true" />
                        {globalSearch ? "Сбросить и вернуться в папку" : "Сбросить фильтры"}
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
              </Card>

              {showConstructor ? (
                <KnowledgeTypeConstructor
                  customTypes={customTypes}
                  dbAvailable={dbAvailable}
                  onCreated={handleTypeCreated}
                  onUpdated={handleTypeUpdated}
                  onDeleted={handleTypeDeleted}
                  onClose={() => setShowConstructor(false)}
                />
              ) : null}

              {showForm ? (
                <KnowledgeCardForm
                  cards={cards}
                  customTypes={customTypes}
                  dbAvailable={dbAvailable}
                  currentUser={currentUser}
                  ownerCandidates={ownerCandidates}
                  defaultFolderId={selectedFolderId}
                  onCreated={handleCreated}
                  onCancel={() => setShowForm(false)}
                />
              ) : null}

              {showingArticles ? (
                <Card>
                  <CardContent>
                    {visibleArticles?.length ? (
                      <ul className="flex flex-col gap-3">
                        {visibleArticles.map(article => (
                          <li key={article.id}>
                            <Link
                              className="inline-flex items-center gap-2 text-sm font-medium text-primary underline underline-offset-4"
                              href={`/editor?${new URLSearchParams({ article: article.id })}`}
                            >
                              <FileText className="size-4 shrink-0" aria-hidden="true" />
                              {article.title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground" role="status">
                        {folderArticles === null ? "Библиотека временно недоступна."
                          : folderArticles === undefined ? "Загружаем статьи…"
                            : searchQuery.trim() ? "Ничего не найдено" : "В этой папке пока нет согласованных статей."}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ) : folderCards.length === 0 ? (
                <Card className="rounded-3xl border-0 py-12 text-center shadow-sm ring-1 ring-foreground/10">
                  <CardContent className="flex flex-col items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <FolderTree className="h-5 w-5" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {hasFilters
                          ? "Ничего не найдено"
                          : "В этой папке пока нет карточек"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {hasFilters
                          ? "Попробуйте другое название, число или снимите фильтры."
                          : "Добавьте карточку выбранного типа или создайте новый тип в конструкторе."}
                      </p>
                    </div>
                    {canAddCard ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-10 sm:h-7"
                        onClick={() => setShowForm(true)}
                      >
                        <Plus className="h-4 w-4" />
                        Добавить карточку
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Создавать карточки могут владельцы, PR-команды вузов,
                        АНО «РИОН», ООО «ЧКК» и администратор базы.
                      </p>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className="data-index-records">
                  {folderCards.map((card, index) => {
                    const isReference = isJointReferenceForFolder(
                      card,
                      selectedFolderId
                    );

                    const Icon = cardIcons[card.type];

                    return (
                      <Card
                        key={card.id}
                        className="data-index-record atlas-stagger-item"
                        style={{ "--stagger-i": index } as CSSProperties}
                      >
                        <button
                          type="button"
                          aria-label={`Открыть карточку: ${card.title}`}
                          onClick={() => handleOpenCard(card.id)}
                          className="data-index-record-link"
                        >
                          <div className="data-record-glyph">
                            <Icon aria-hidden="true" />
                          </div>
                          <div className="data-record-content">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="secondary">
                                {getCardTypeLabel(card, customTypes)}
                              </Badge>
                              <Badge
                                variant="outline"
                                className={cn(
                                  getCardStatus(card) === "approved" &&
                                    "border-emerald-200 text-emerald-700",
                                  getCardStatus(card) === "pending" &&
                                    "border-amber-300 text-amber-700",
                                  getCardStatus(card) === "rejected" &&
                                    "border-destructive/30 text-destructive"
                                )}
                              >
                                {cardStatusLabels[getCardStatus(card)]}
                              </Badge>
                              {card.type === "project" ? (
                                <Badge variant="outline">
                                  {card.readinessStage}
                                </Badge>
                              ) : null}
                              {card.type === "laboratory" ? (
                                <Badge
                                  className={cn(
                                    card.placementStatus === "planned"
                                      ? "bg-amber-100 text-amber-700 hover:bg-amber-100"
                                      : "bg-emerald-100 text-emerald-700 hover:bg-emerald-100"
                                  )}
                                >
                                  {placementStatusLabels[card.placementStatus]}
                                </Badge>
                              ) : null}
                              {isJointProject(card) ? (
                                <Badge className="bg-primary/10 text-primary hover:bg-primary/10">
                                  <Handshake className="h-3 w-3" />
                                  Совместный проект
                                </Badge>
                              ) : null}
                              {isReference ? (
                                <Badge
                                  variant="outline"
                                  className="border-primary/30 text-primary"
                                >
                                  <Link2 className="h-3 w-3" />
                                  Ссылка на общую карточку
                                </Badge>
                              ) : null}
                              {card.diskSync ? (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    card.diskSync.status === "synced" &&
                                      "border-emerald-200 text-emerald-700",
                                    card.diskSync.status === "failed" &&
                                      "border-amber-300 text-amber-700"
                                  )}
                                >
                                  {diskSyncStatusLabels[card.diskSync.status]}
                                </Badge>
                              ) : null}
                            </div>

                            <div className="space-y-1">
                              <h2 className="data-record-title">
                                {card.title}
                              </h2>
                              <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                                {(searchQuery
                                  ? getSearchFragment(card, searchQuery)
                                  : card.referenceDescription) ||
                                  "Карточка пользовательского типа: заполните поля, заданные администратором базы."}
                              </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                              <span className="inline-flex min-w-0 items-center gap-1.5 break-words">
                                <Users className="h-3.5 w-3.5 shrink-0" />
                                {card.owners.join(" · ")}
                              </span>
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                <FolderTree className="h-3.5 w-3.5 shrink-0" />
                                {getFolderDisplayPath(card.folderId, tree)}
                              </span>
                            </div>
                          </div>
                          <ArrowUpRight
                            className="data-record-arrow"
                            aria-hidden="true"
                          />
                        </button>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
