import {
  canConfirmStakeholderApproval,
  canEditCard,
  canManageEditRequests,
  canManageTypes,
  canRequestEdit,
  getDemoAccount,
  visibleKnowledgeCard,
} from "./auth";
import {
  allDemoCards,
  demoArticles,
  demoUser,
  getDemoCard,
  moderateDemoCard,
  nextDemoTimestamp,
  saveDemoCard,
  updateDemoCard,
} from "./browser-demo";
import {
  demoError,
  type DemoCall,
  type DemoHandler,
} from "./browser-demo-http";
import { demoCardRevisionId, demoCardVersionId } from "./browser-demo-version";
import {
  cardContent,
  getApprovedVersion,
  getCardStatus,
  getRequiredStakeholderApprovals,
  type KnowledgeCard,
} from "./knowledge";
import { canVerifyCardFreshness } from "./knowledge-freshness";
import {
  editRequestCreateSchema,
  editRequestUpdateSchema,
  moderationActionSchema,
} from "./validation/access";
import {
  buildCustomFieldValuesSchema,
  canonicalKnowledgeFolder,
  cardTypeInputSchema,
  cardTypeUpdateSchema,
  knowledgeCardInputSchema,
  updateCardFreshnessSchema,
} from "./validation/knowledge";

function cardTypes(call: DemoCall, id?: string) {
  const state = call.state;
  const user = demoUser(state);
  const types = state.cardTypes ?? [];
  const counts = allDemoCards(state).filter((card) => card.type === "custom");
  if (call.method === "GET")
    return Response.json(
      types.map((type) => ({
        ...type,
        cardCount: counts.filter((card) => card.customTypeId === type.id)
          .length,
      }))
    );
  if (!canManageTypes(user))
    return demoError("Конструктор доступен учебному координатору.", 403);
  if (call.method === "POST" && !id) {
    const input = cardTypeInputSchema.parse(call.body());
    const now = nextDemoTimestamp();
    const type = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    call.save({ ...state, cardTypes: [...types, type] });
    return Response.json({ ...type, cardCount: 0 }, { status: 201 });
  }
  const type = types.find((item) => item.id === id);
  if (!type) return demoError("Учебный тип карточки не найден.", 404);
  const cardCount = counts.filter((card) => card.customTypeId === id).length;
  if (call.method === "DELETE") {
    if (cardCount) return demoError("У этого типа есть карточки.", 409);
    call.save({ ...state, cardTypes: types.filter((item) => item.id !== id) });
    return Response.json({ success: true });
  }
  if (call.method === "PATCH") {
    const input = cardTypeUpdateSchema.parse(call.body());
    if (
      input.organizationScope !== undefined &&
      (input.organizationScope ?? undefined) !== type.organizationScope
    )
      return demoError("Доступ типа задаётся при создании.", 409);
    const updated = {
      ...type,
      ...cardTypeInputSchema.parse({
        ...type,
        ...input,
        organizationScope: type.organizationScope,
      }),
      updatedAt: nextDemoTimestamp(type.updatedAt),
    };
    if (
      cardCount &&
      JSON.stringify(updated.fields) !== JSON.stringify(type.fields)
    )
      return demoError(
        "Сначала перенесите карточки, использующие поля этого типа.",
        409
      );
    call.save({
      ...state,
      cardTypes: types.map((item) => (item.id === id ? updated : item)),
    });
    return Response.json({ ...updated, cardCount });
  }
}

function versionView(card: KnowledgeCard) {
  return {
    id: demoCardVersionId(card),
    cardId: card.id,
    snapshot: card,
    recordedAt: card.reviewedAt ?? card.updatedAt,
    actorName: card.reviewedBy || "Учебная версия",
    reason: card.changeReason || "Снимок учебной карточки",
    legacyBaseline: !card.reviewedAt,
  };
}

function history(call: DemoCall, card: KnowledgeCard, versionId?: string) {
  const state = call.state;
  const published = getApprovedVersion(card);
  const snapshots = [
    ...(published ? [published] : []),
    ...(state.cardVersions ?? []).filter((version) => version.id === card.id),
  ];
  const versions = [
    ...new Map(
      snapshots
        .reverse()
        .map((snapshot) => [demoCardVersionId(snapshot), versionView(snapshot)])
    ).values(),
  ].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const user = demoUser(state);
  if (versionId) {
    const version = versions.find((entry) => entry.id === versionId);
    return version
      ? Response.json(version)
      : demoError("Учебная версия карточки недоступна.", 404);
  }
  return Response.json({
    currentVersionId: published ? demoCardVersionId(published) : null,
    cardUpdatedAt: card.updatedAt,
    publishedUpdatedAt: published?.updatedAt ?? null,
    canVerifyFreshness: canVerifyCardFreshness(user, card),
    responsibleId: card.freshness?.responsibleId,
    versions: versions.map(({ snapshot: _snapshot, ...version }) => version),
  });
}

function freshness(call: DemoCall, card: KnowledgeCard) {
  const state = call.state;
  const user = demoUser(state);
  const input = updateCardFreshnessSchema.parse(call.body());
  const expected = call.headers.get("If-Match");
  if (expected !== card.updatedAt)
    return demoError("Карточка изменилась. Откройте её заново.", 409);
  const data = { ...card.freshness };
  if (input.action === "verify") {
    if (!canVerifyCardFreshness(user, card))
      return demoError("Сверка доступна ответственному.", 403);
    const approved = getApprovedVersion(card);
    if (!approved || demoCardVersionId(approved) !== input.versionId)
      return demoError("Утверждённая версия изменилась.", 409);
    data.lastVerifiedAt = nextDemoTimestamp();
    data.verifiedVersionId = input.versionId;
    delete data.nextReviewAt;
  } else {
    if (!canEditCard(user, card))
      return demoError("План сверки обновляет владелец или координатор.", 403);
    data.nextReviewAt = input.nextReviewAt ?? undefined;
    if (input.responsibleId !== undefined) {
      if (user.role !== "admin")
        return demoError("Ответственного назначает координатор.", 403);
      const person = getDemoAccount(input.responsibleId);
      if (input.responsibleId && (!person || person.role === "guest"))
        return demoError("Выберите учебного сотрудника.", 400);
      data.responsibleId = person?.id;
      data.responsibleName = person?.name;
    }
  }
  const updated = {
    ...card,
    freshness: data,
    updatedAt: nextDemoTimestamp(card.updatedAt),
  };
  call.save(updateDemoCard(state, updated));
  return Response.json(visibleKnowledgeCard(user, updated));
}

function editRequests(call: DemoCall, card: KnowledgeCard) {
  const state = call.state;
  const user = demoUser(state);
  const requests = card.editRequests ?? [];
  const now = nextDemoTimestamp();
  let next: typeof requests;
  let recipient: "owner" | "coordinator" | undefined;
  if (call.method === "POST") {
    if (!canRequestEdit(user, card))
      return demoError("Этой учебной роли недоступен запрос на правку.", 403);
    const { message } = editRequestCreateSchema.parse(call.body());
    recipient = card.ownerIds?.length ? "owner" : "coordinator";
    next = [
      ...requests,
      {
        id: crypto.randomUUID(),
        authorId: user.id,
        authorName: user.name,
        authorRole: user.role,
        authorOrganization: user.organization,
        message,
        createdAt: now,
        status: "open",
        recipient,
      },
    ];
  } else {
    if (!canManageEditRequests(user, card))
      return demoError("Решение по запросу принимает учебный владелец.", 403);
    const input = editRequestUpdateSchema.parse(call.body());
    if (!requests.some((item) => item.id === input.requestId))
      return demoError("Запрос на правку не найден.", 404);
    next = requests.map((item) =>
      item.id !== input.requestId
        ? item
        : {
            ...item,
            status: input.action === "resolve" ? "resolved" : "open",
            resolvedAt: input.action === "resolve" ? now : undefined,
            resolvedBy: input.action === "resolve" ? user.name : undefined,
            resolution: input.resolution,
          }
    );
  }
  const updated = {
    ...card,
    editRequests: next,
    updatedAt: nextDemoTimestamp(card.updatedAt),
  };
  call.save(updateDemoCard(state, updated));
  return Response.json(visibleKnowledgeCard(user, updated), {
    headers: recipient ? { "X-Canon-Edit-Request-Recipient": recipient } : {},
  });
}

export const handleDemoKnowledge: DemoHandler = (call) => {
  const { pathname, searchParams } = call.url;
  const typeRoute = /^\/api\/knowledge\/card-types(?:\/([^/]+))?$/.exec(
    pathname
  );
  if (typeRoute) return cardTypes(call, typeRoute[1]);
  const cardRoute =
    /^\/api\/knowledge\/cards(?:\/([^/]+)(?:\/(moderation|edit-requests|versions|freshness|usage)(?:\/([^/]+))?)?)?$/.exec(
      pathname
    );
  if (!cardRoute) return;
  const [, routeId, resource, versionId] = cardRoute;
  const id = routeId ? decodeURIComponent(routeId) : searchParams.get("id");
  const state = call.state;
  const user = demoUser(state);
  const card = id ? getDemoCard(state, id) : undefined;
  const visible = card && visibleKnowledgeCard(user, card);
  if (
    !resource &&
    ((call.method === "POST" && !id) || (call.method === "PUT" && card))
  ) {
    let input = knowledgeCardInputSchema.parse(call.body());
    if (card && call.headers.get("If-Match") !== card.updatedAt)
      return demoError("Карточка изменилась. Откройте её заново.", 409);
    if (input.type === "custom") {
      const { customTypeId } = input;
      const type = state.cardTypes?.find((item) => item.id === customTypeId);
      if (!type) return demoError("Учебный тип карточки недоступен.", 404);
      input = {
        ...input,
        customFields: buildCustomFieldValuesSchema(type).parse(
          input.customFields
        ),
      };
    }
    const folderId = canonicalKnowledgeFolder(input);
    if (!folderId) return demoError("Выберите раздел учебной базы.", 400);
    const next = saveDemoCard(state, { ...input, folderId }, card ?? null);
    call.save(next.state);
    return Response.json(visibleKnowledgeCard(user, next.card), {
      status: card ? 200 : 201,
    });
  }
  if (!resource && call.method === "GET" && !id)
    return Response.json(
      allDemoCards(state).flatMap(
        (item) => visibleKnowledgeCard(user, item) ?? []
      )
    );
  if (!card || !visible) return demoError("Учебная карточка не найдена.", 404);
  if (!resource && call.method === "GET") return Response.json(visible);
  if (!resource && call.method === "DELETE") {
    if (user.role !== "admin")
      return demoError("Удаление доступно координатору.", 403);
    if (card.id === "campus-passport")
      return demoError("Паспорт кампуса защищён от удаления.", 409);
    call.save({
      ...state,
      removedCardIds: [...(state.removedCardIds ?? []), card.id],
      updates: state.updates.filter((item) => item.id !== card.id),
    });
    return Response.json({ success: true });
  }
  if (resource === "versions" && call.method === "GET")
    return history(call, card, versionId);
  if (resource === "freshness" && call.method === "PATCH")
    return freshness(call, card);
  if (resource === "edit-requests" && ["POST", "PATCH"].includes(call.method))
    return editRequests(call, card);
  if (resource === "usage" && call.method === "GET") {
    return Response.json({
      items: demoArticles(state)
        .filter((article) => article.sourceCardIds.includes(card.id))
        .map((article) => ({
          id: article.id,
          title: article.title,
          kind: "article",
          status: "Утверждена",
          href: `/editor?article=${encodeURIComponent(article.id)}`,
          versionId: article.sourceVersions?.find(
            (source) => source.cardId === card.id
          )?.versionId,
          versionDate: article.updatedAt,
        })),
    });
  }
  if (resource !== "moderation" || call.method !== "POST") return;
  const { action, comment } = moderationActionSchema.parse(call.body());
  if (
    call.headers.get("If-Match") !== card.updatedAt ||
    getCardStatus(card) !== "pending"
  )
    return demoError("Учебная редакция изменилась.", 409);
  if (action === "confirm-stakeholder") {
    if (!canConfirmStakeholderApproval(user, card))
      return demoError("Этой роли не назначено согласование.", 403);
    const now = nextDemoTimestamp(card.updatedAt);
    const updated = {
      ...card,
      updatedAt: now,
      stakeholderApprovals: {
        ...card.stakeholderApprovals,
        [user.role]: {
          actorId: user.id,
          at: now,
          revisionId: demoCardRevisionId(card),
          comment,
        },
      },
    };
    call.save(updateDemoCard(state, updated));
    return Response.json(visibleKnowledgeCard(user, updated));
  }
  if (
    action === "approve" &&
    getRequiredStakeholderApprovals(card).some(
      (role) =>
        card.stakeholderApprovals?.[role]?.revisionId !==
        demoCardRevisionId(card)
    )
  ) {
    return demoError("Дождитесь согласования всех учебных организаций.", 409);
  }
  const next = moderateDemoCard(
    state,
    card.id,
    action === "approve"
      ? "approve"
      : action === "reject"
        ? "return"
        : "confirm"
  );
  const saved = getDemoCard(next, card.id)!;
  const updated =
    comment && action === "reject"
      ? { ...saved, reviewComment: comment }
      : saved;
  const previous = action === "approve" ? getApprovedVersion(card) : null;
  call.save({
    ...updateDemoCard(next, updated),
    ...(previous && {
      cardVersions: [...(next.cardVersions ?? []), cardContent(previous)],
    }),
  });
  return Response.json(visibleKnowledgeCard(user, updated));
};
