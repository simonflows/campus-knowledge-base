import "@/app/data-workspaces.css";

import { BookOpenCheck } from "lucide-react";
import Link from "next/link";

import { KnowledgeBase } from "@/components/knowledge/knowledge-base";
import { visibleKnowledgeCards } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { staffDirectory } from "@/lib/account-directory";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { StorageUnavailable } from "@/components/storage-unavailable";
import {
  getAllCardTypes,
  getAllArticles,
  getAllKnowledgeCards,
  customCardCounts,
} from "@/lib/models";
import {
  folderIds,
  getPublicApprovedCard,
  getUniversityIdFromFolder,
  type CardTypeDefinition,
  type CardTypeWithStats,
} from "@/lib/knowledge";

export const dynamic = "force-dynamic";

function withStats(
  types: CardTypeDefinition[],
  counts: Record<string, number>
): CardTypeWithStats[] {
  return types.map((type) => ({ ...type, cardCount: counts[type.id] ?? 0 }));
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{
    card?: string;
    action?: string;
    folder?: string;
    q?: string;
    version?: string;
  }>;
}) {
  const articleFolder = searchParams.then(params => {
    const universityId = params.folder ? getUniversityIdFromFolder(params.folder) : null;
    return !params.card && universityId && params.folder === folderIds.subfolder(universityId, "articles") ? universityId : null;
  });
  const [user, data, params, articles] = await Promise.all([
    getSessionUser(),
    Promise.all([
      getAllKnowledgeCards(),
      getAllCardTypes(),
      getReadableStorageMode(),
    ]).catch(() => null),
    searchParams,
    articleFolder.then(universityId => universityId
      ? getAllArticles().then(items => items
        .filter(article => article.universityId === universityId)
        .map(({ id, title }) => ({ id, title }))).catch(() => null)
      : undefined),
  ]);
  if (!data) return <StorageUnavailable title="База знаний" />;
  const [allCards, types, mode] = data;
  const cards = visibleKnowledgeCards(user, allCards);
  const customTypes = withStats(types, customCardCounts(cards));
  const dbAvailable = mode !== "static-export";

  const approvedOnly = params.version === "approved";
  const ownerCandidates = !approvedOnly && user?.role === "admin"
    ? (await staffDirectory())
      .filter(({ role }) => ["university_owner", "rio", "chkk"].includes(role))
      .map(({ id, role, universityId, ownershipLabel }) => ({ id, role, universityId, ownershipLabel }))
    : [];
  return (
    <>
      {approvedOnly ? (
        <div className="atlas-wrap data-index-version">
          <p>
            <BookOpenCheck className="size-4" aria-hidden="true" />
            Утверждённая версия из источника
          </p>
          {params.card ? (
            <Link href={`/knowledge?card=${encodeURIComponent(params.card)}`}>
              Открыть карточку в справочнике
            </Link>
          ) : null}
        </div>
      ) : null}
      <KnowledgeBase
        key={JSON.stringify(params)}
        initialQuery={params.q ?? ""}
        initialCards={
          approvedOnly
            ? cards.flatMap((card) => {
                const approved = getPublicApprovedCard(card);
                return approved ? [approved] : [];
              })
            : cards
        }
        initialCustomTypes={customTypes}
        initialCardId={params.card ?? null}
        initialAction={approvedOnly ? null : (params.action ?? null)}
        initialFolderId={params.folder ?? null}
        initialFolderArticles={articles}
        dbAvailable={dbAvailable}
        currentUser={approvedOnly ? null : user}
        ownerCandidates={ownerCandidates}
      />
    </>
  );
}
