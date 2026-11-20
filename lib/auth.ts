import { cardContent, folderIds, getCardStatus, getApprovedVersion, getPublicApprovedCard, getRequiredUniversityApprovals, getUniversityFullName, getUniversityIdFromFolder, getUniversityName, type KnowledgeCard } from "./knowledge";

export const ROLES = [
  "admin",
  "ministry",
  "rio",
  "chkk",
  "university_owner",
  "university_pr",
  "guest",
] as const;

export type Role = (typeof ROLES)[number];

export type DemoAccount = {
  id: string;
  name: string;
  role: Role;
  organization: string;
  position: string;
  universityId?: string;
  ownershipLabel: string;
  ownerAliases: string[];
  organizationAliases: string[];
  demoHint: string;
};

export type SessionUser = Omit<DemoAccount, "demoHint"> & {
  soleUniversityOwner?: boolean;
};

export const roleLabels: Record<Role, string> = {
  admin: "Администратор канона",
  ministry: "Министерство образования и науки",
  rio: "АНО «РИОН»",
  chkk: "Концессионер ООО «ЧКК»",
  university_owner: "Владелец карточки в вузе",
  university_pr: "PR-команда / редактор вуза",
  guest: "Гость",
};

export const roleShortLabels: Record<Role, string> = {
  admin: "Координатор",
  ministry: "Министерство",
  rio: "АНО «РИОН»",
  chkk: "ООО «ЧКК»",
  university_owner: "Владелец карточки",
  university_pr: "PR-команда вуза",
  guest: "Гость",
};

export const roleDefinitions: Record<
  Role,
  { description: string; capabilities: string[]; restrictions: string[] }
> = {
  admin: {
    description:
      "Координатор канона: ведёт всю базу, модерирует новые карточки и настраивает структуру.",
    capabilities: [
      "Редактирует все разделы и любую карточку",
      "Модерирует новые карточки и подтверждает черновики",
      "Управляет конструктором типов и общими параметрами кампуса",
      "Одобряет совместные проекты после подтверждения вузов-участников",
    ],
    restrictions: [
      "Не заменяет запросы на правку молчаливым изменением чужой карточки",
    ],
  },
  ministry: {
    description:
      "Представитель Министерства образования и науки Челябинской области.",
    capabilities: [
      "Читает базу знаний",
      "Проверяет тексты и запрашивает аналитику",
      "Пишет статьи в умном редакторе",
      "Отправляет владельцу запрос на правку комментарием",
    ],
    restrictions: [
      "Не редактирует чужие карточки напрямую",
      "Не управляет типами карточек и параметрами кампуса",
    ],
  },
  rio: {
    description:
      "АНО «РИОН»: работает только со своими карточками в зоне ответственности.",
    capabilities: [
      "Редактирует карточки, где указан владельцем или представителем АНО «РИОН»",
      "Читает базу, проверяет тексты, пишет статьи и собирает аналитику",
      "Отправляет запрос на правку владельцу чужой карточки",
    ],
    restrictions: [
      "Не редактирует чужие карточки",
      "Не управляет типами карточек и параметрами кампуса",
    ],
  },
  chkk: {
    description:
      "Концессионер ООО «ЧКК»: работает только со своими карточками в зоне ответственности.",
    capabilities: [
      "Редактирует карточки, где указан владельцем или представителем ООО «ЧКК»",
      "Читает базу, проверяет тексты, пишет статьи и собирает аналитику",
      "Отправляет запрос на правку владельцу чужой карточки",
    ],
    restrictions: [
      "Не редактирует чужие карточки",
      "Не управляет типами карточек и параметрами кампуса",
    ],
  },
  university_owner: {
    description:
      "Ответственный за карточку в вузе: редактирует только те карточки, где указан владельцем.",
    capabilities: [
      "Редактирует карточки, где указан владельцем",
      "Добавляет новые карточки своего вуза (после проверки координатором)",
      "Видит запросы на правку в своих карточках",
      "Читает базу, проверяет тексты, пишет статьи и собирает аналитику",
    ],
    restrictions: [
      "Не редактирует утверждённые карточки других вузов",
      "Не управляет типами карточек и параметрами кампуса",
    ],
  },
  university_pr: {
    description:
      "PR-команда или редактор вуза: готовит черновики карточек и отправляет их координатору.",
    capabilities: [
      "Добавляет карточки только черновиком",
      "Черновик уходит координатору на подтверждение и не попадает в канон до одобрения",
      "Для совместного проекта требуется подтверждение второго вуза-участника",
      "Читает базу, проверяет тексты, пишет статьи и собирает аналитику",
    ],
    restrictions: [
      "Не редактирует утверждённые карточки других вузов",
      "Не управляет типами карточек и параметрами кампуса",
    ],
  },
  guest: {
    description:
      "Гость: просматривает канон и проверяет тексты без права менять базу.",
    capabilities: [
      "Читает базу знаний",
      "Проверяет тексты на искажения фактов",
      "Собирает аналитику и пишет статьи",
    ],
    restrictions: [
      "Не создаёт и не редактирует карточки",
      "Не отправляет запросы на правку",
      "Не управляет типами карточек и параметрами кампуса",
    ],
  },
};

const universityOwners: Array<{
  id: string;
  name: string;
  universityId: string;
  organization: string;
  ownershipLabel: string;
}> = [
  {
    id: "demo-owner-susu",
    name: "Анна Смирнова",
    universityId: "susu",
    organization: "ЮУрГУ",
    ownershipLabel: "Анна Смирнова, ЮУрГУ",
  },
  {
    id: "demo-owner-csu",
    name: "Елена Ковалёва",
    universityId: "csu",
    organization: "ЧелГУ",
    ownershipLabel: "Елена Ковалёва, ЧелГУ",
  },
  {
    id: "demo-owner-midis",
    name: "Мария Лебедева",
    universityId: "midis",
    organization: "МИДиС",
    ownershipLabel: "Мария Лебедева, МИДиС",
  },
  {
    id: "demo-owner-susmu",
    name: "Дмитрий Петров",
    universityId: "susmu",
    organization: "ЮУГМУ",
    ownershipLabel: "Дмитрий Петров, ЮУГМУ",
  },
  {
    id: "demo-owner-sursau",
    name: "Ирина Волкова",
    universityId: "sursau",
    organization: "ЮУрГАУ",
    ownershipLabel: "Ирина Волкова, ЮУрГАУ",
  },
  {
    id: "demo-owner-mgtu",
    name: "Ольга Соколова",
    universityId: "mgtu",
    organization: "МГТУ им. Г. И. Носова",
    ownershipLabel: "Ольга Соколова, МГТУ им. Г. И. Носова",
  },
  {
    id: "demo-owner-suspgu",
    name: "Светлана Морозова",
    universityId: "suspgu",
    organization: "ЮУрГГПУ",
    ownershipLabel: "Светлана Морозова, ЮУрГГПУ",
  },
];

const universityPrAccounts: Array<{
  id: string;
  name: string;
  universityId: string;
  organization: string;
}> = [
  {
    id: "demo-pr-susu",
    name: "Павел Кузнецов",
    universityId: "susu",
    organization: "ЮУрГУ",
  },
  {
    id: "demo-pr-csu",
    name: "Марина Титова",
    universityId: "csu",
    organization: "ЧелГУ",
  },
  {
    id: "demo-pr-midis",
    name: "Алина Соколова",
    universityId: "midis",
    organization: "МИДиС",
  },
  {
    id: "demo-pr-susmu",
    name: "Илья Егоров",
    universityId: "susmu",
    organization: "ЮУГМУ",
  },
  {
    id: "demo-pr-sursau",
    name: "Оксана Белова",
    universityId: "sursau",
    organization: "ЮУрГАУ",
  },
  {
    id: "demo-pr-mgtu",
    name: "Роман Фролов",
    universityId: "mgtu",
    organization: "МГТУ им. Г. И. Носова",
  },
  {
    id: "demo-pr-suspgu",
    name: "Татьяна Зайцева",
    universityId: "suspgu",
    organization: "ЮУрГГПУ",
  },
];

export const demoAccounts: DemoAccount[] = [
  {
    id: "demo-admin",
    name: "Администратор канона",
    role: "admin",
    organization: "Координационный центр канона",
    position: "Администратор канона (координатор)",
    ownershipLabel: "Координационный центр канона",
    ownerAliases: ["Администратор канона"],
    organizationAliases: ["Координационный центр канона"],
    demoHint:
      "Проверьте полный доступ: редактирование любой карточки, очередь подтверждения и конструктор типов.",
  },
  {
    id: "demo-ministry",
    name: "Наталья Григорьева",
    role: "ministry",
    organization: "Минобрнауки Челябинской области",
    position: "Представитель Министерства образования и науки",
    ownershipLabel: "Наталья Григорьева, Минобрнауки Челябинской области",
    ownerAliases: ["Наталья Григорьева"],
    organizationAliases: ["Минобрнауки Челябинской области"],
    demoHint:
      "Откройте чужую карточку и отправьте запрос на правку: он придёт владельцу комментарием.",
  },
  {
    id: "demo-rio",
    name: "Сергей Иванов",
    role: "rio",
    organization: "АНО «РИОН»",
    position: "Руководитель направления АНО «РИОН»",
    ownershipLabel: "Сергей Иванов, АНО «РИОН»",
    ownerAliases: ["Сергей Иванов"],
    organizationAliases: ["АНО «РИОН»"],
    demoHint:
      "Проверьте зону ответственности: доступны только карточки с владельцем из АНО «РИОН».",
  },
  {
    id: "demo-chkk",
    name: "Виктор Козлов",
    role: "chkk",
    organization: "ООО «ЧКК»",
    position: "Представитель концессионера ООО «ЧКК»",
    ownershipLabel: "Виктор Козлов, ООО «ЧКК»",
    ownerAliases: ["Виктор Козлов"],
    organizationAliases: ["ООО «ЧКК»"],
    demoHint:
      "Проверьте зону ответственности: редактируются только карточки концессионера.",
  },
  ...universityOwners.map<DemoAccount>((owner) => ({
    id: owner.id,
    name: owner.name,
    role: "university_owner",
    organization: owner.organization,
    position: `Владелец карточки, ${owner.organization}`,
    universityId: owner.universityId,
    ownershipLabel: owner.ownershipLabel,
    ownerAliases: [owner.name],
    organizationAliases: [],
    demoHint:
      "Откройте свою карточку — она доступна для правки. Чужие утверждённые карточки только для чтения.",
  })),
  ...universityPrAccounts.map<DemoAccount>((account) => ({
    id: account.id,
    name: account.name,
    role: "university_pr",
    organization: account.organization,
    position: `PR-команда, ${account.organization}`,
    universityId: account.universityId,
    ownershipLabel: `${account.name}, ${account.organization}`,
    ownerAliases: [account.name],
    organizationAliases: [],
    demoHint:
      "Добавьте карточку: она сохранится черновиком и уйдёт координатору на подтверждение.",
  })),
  {
    id: "demo-guest",
    name: "Гость",
    role: "guest",
    organization: "Внешний участник",
    position: "Гость с правом просмотра и проверки текста",
    ownershipLabel: "Гость",
    ownerAliases: [],
    organizationAliases: [],
    demoHint:
      "Проверьте ограничения: база и проверка текста доступны, кнопок редактирования нет.",
  },
];

export function getDemoAccount(
  id: string | null | undefined
): DemoAccount | null {
  if (!id) return null;

  return demoAccounts.find((account) => account.id === id) ?? null;
}

export function toSessionUser(account: DemoAccount): SessionUser {
  return {
    id: account.id,
    name: account.name,
    role: account.role,
    organization: account.organization,
    position: account.position,
    universityId: account.universityId,
    soleUniversityOwner: account.role === "university_owner",
    ownershipLabel: account.ownershipLabel,
    ownerAliases: account.ownerAliases,
    organizationAliases: account.organizationAliases,
  };
}

export function normalizeOwnerLabel(value: string): string {
  return value.toLowerCase().replace(/[«»"]/g, "").replace(/\s+/g, " ").trim();
}

export function isCardOwner(
  user: SessionUser | null,
  owners: string[],
  ownerIds?: string[]
): boolean {
  if (!user) return false;
  if (ownerIds !== undefined) return ownerIds.includes(user.id);

  const people = new Set(user.ownerAliases.map(normalizeOwnerLabel));
  const organizations = new Set(user.organizationAliases.map(normalizeOwnerLabel));
  const ownOrganization = normalizeOwnerLabel(user.organization);
  return owners.some((owner) => {
    const label = normalizeOwnerLabel(owner);
    const separator = label.lastIndexOf(",");
    if (separator < 0) return people.has(label) || organizations.has(label);
    const name = label.slice(0, separator).trim();
    const organization = label.slice(separator + 1).trim();
    return organizations.has(organization) || (
      organization === ownOrganization &&
      ((!name.includes(",") && people.has(name)) || people.has(name + ", " + organization))
    );
  });
}

export type CardOwnerAssignment = Pick<KnowledgeCard, "type" | "folderId" | "owners"> & {
  universityId?: string;
  initiatorUniversityId?: string;
  isJoint?: boolean;
  participantUniversityIds?: string[];
};

export type CardOwnerCandidate = Pick<SessionUser, "id" | "role" | "universityId" | "ownershipLabel">;

export function canAssignCardOwner(user: Pick<CardOwnerCandidate, "role" | "universityId">, card: CardOwnerAssignment): boolean {
  if (card.type === "campus" || card.folderId === folderIds.campus) return false;
  const folderUniversity = getUniversityIdFromFolder(card.folderId);
  if (user.role === "rio" || user.role === "chkk") {
    return !folderUniversity && card.type !== "university" && card.type !== "project";
  }
  if (!user.universityId || (user.role !== "university_owner" && user.role !== "university_pr")) return false;
  if (folderUniversity && folderUniversity !== user.universityId) return false;
  if (card.type === "university") return card.universityId === user.universityId;
  if (card.type === "project") {
    return card.isJoint
      ? Boolean(card.participantUniversityIds?.includes(user.universityId))
      : card.initiatorUniversityId === user.universityId;
  }
  return true;
}

function hasCardOwnership(user: SessionUser, card: KnowledgeCard): boolean {
  const scoped = card.ownerIds !== undefined ||
    user.role === "university_owner" || user.role === "university_pr";
  if (scoped && !canAssignCardOwner(user, card)) return false;
  return isCardOwner(user, card.owners, card.ownerIds);
}

export function sameCardOwnerScope(previous: CardOwnerAssignment, next: CardOwnerAssignment): boolean {
  const oldParticipants = new Set(previous.participantUniversityIds);
  const newParticipants = new Set(next.participantUniversityIds);
  return previous.folderId === next.folderId &&
    previous.universityId === next.universityId &&
    previous.initiatorUniversityId === next.initiatorUniversityId &&
    Boolean(previous.isJoint) === Boolean(next.isJoint) &&
    (!next.isJoint || (oldParticipants.size === newParticipants.size &&
      [...newParticipants].every(id => oldParticipants.has(id))));
}

export function areCardOwnerIdsAssignable(card: CardOwnerAssignment, ids: string[], directory: SessionUser[]): boolean {
  const eligible = new Set(directory.filter(user => canAssignCardOwner(user, card)).map(user => user.id));
  return new Set(ids).size === ids.length && ids.every(id => eligible.has(id));
}

/** A partial match could discard a co-owner. Leave the entire assignment for manual review. */
export function resolveLegacyCardOwnerIds(card: CardOwnerAssignment, directory: SessionUser[]): string[] | null {
  if (!card.owners.length) return null;
  const ids = new Set<string>();
  for (const label of card.owners) {
    const matches = directory.filter(user => isCardOwner(user, [label]));
    const [owner] = matches;
    if (matches.length !== 1 || owner.role !== "university_owner" || !canAssignCardOwner(owner, card)) return null;
    ids.add(owner.id);
  }
  return [...ids];
}

export function canManageTypes(user: SessionUser | null): boolean {
  return user?.role === "admin";
}

export function canEditCampus(user: SessionUser | null): boolean {
  return user?.role === "admin";
}

export function canModerate(user: SessionUser | null): boolean {
  return user?.role === "admin";
}

export function canCreateCard(user: SessionUser | null): boolean {
  if (!user) return false;

  return ["admin", "rio", "chkk", "university_owner", "university_pr"].includes(
    user.role
  );
}

export function canRequestEdit(
  user: SessionUser | null,
  card: KnowledgeCard
): boolean {
  if (!user || user.role === "guest") return false;

  return !canEditCard(user, card) && (canSeeCard(user, card) || !!getApprovedVersion(card));
}

export function canEditCard(
  user: SessionUser | null,
  card: KnowledgeCard
): boolean {
  if (!user || user.role === "guest" || user.role === "ministry") return false;

  if (user.role === "admin") return true;

  if (card.type === "campus") return false;
  if (card.type === "university") {
    if (user.universityId !== card.universityId) return false;
    if (user.role === "university_pr") return true;
    if (user.role !== "university_owner") return false;
    const institutionNames = [user.organization, getUniversityFullName(card.universityId), getUniversityName(card.universityId)]
      .map(normalizeOwnerLabel);
    return hasCardOwnership(user, card) ||
      (card.ownerIds === undefined && user.soleUniversityOwner === true &&
        card.owners.some(label => institutionNames.includes(normalizeOwnerLabel(label))));
  }

  if (card.ownerIds === undefined && getCardStatus(card) !== "approved" && card.submittedBy === user.id) {
    return true;
  }

  return hasCardOwnership(user, card);
}

export function canSeeCard(
  user: SessionUser | null,
  card: KnowledgeCard
): boolean {
  if (getCardStatus(card) === "approved") return true;

  if (!user || user.role === "guest") return false;

  if (canEditCard(user, card)) return true;
  if (card.submittedBy === user.id) return true;
  if (hasCardOwnership(user, card)) return true;

  return Boolean(
    user.universityId &&
    getRequiredUniversityApprovals(card).includes(user.universityId)
  );
}

export function canConfirmJointParticipation(
  user: SessionUser | null,
  card: KnowledgeCard
): boolean {
  if (!user?.universityId) return false;
  if (getCardStatus(card) !== "pending") return false;
  if (!getRequiredUniversityApprovals(card).includes(user.universityId)) return false;

  return !(card.participantApprovals ?? []).includes(user.universityId);
}

export function visibleKnowledgeCard(user: SessionUser | null, card: KnowledgeCard): KnowledgeCard | null {
  const currentVisible = canSeeCard(user, card);
  const visible = currentVisible ? cardContent(card) : getPublicApprovedCard(card);
  if (!visible) return null;
  if (card.ownerIds !== undefined) {
    // Clients calculate the edit controls from this view. Keep other employees' IDs private.
    visible.ownerIds = user?.role === "admin" ? card.ownerIds :
      user && currentVisible && hasCardOwnership(user, card) ? [user.id] : [];
  }
  const editor = canEditCard(user, card);
  if (editor || (currentVisible && getCardStatus(card) !== "approved")) {
    Object.assign(visible, {
      submittedBy: card.submittedBy,
      submittedByName: card.submittedByName,
      reviewedBy: card.reviewedBy,
      reviewedAt: card.reviewedAt,
      reviewComment: card.reviewComment,
      participantApprovals: card.participantApprovals,
      requiredApprovalUniversityIds: card.requiredApprovalUniversityIds,
    });
    if (getCardStatus(card) !== "approved" && card.approvedSnapshot) {
      visible.approvedSnapshot = getPublicApprovedCard(card) ?? undefined;
    }
  }
  if (editor) visible.diskSync = card.diskSync;
  const requests = editor ? card.editRequests : user && user.role !== "guest" ? card.editRequests?.filter((r) => r.authorId === user.id) : [];
  if (requests?.length) visible.editRequests = requests;
  return visible;
}

export function visibleKnowledgeCards(user: SessionUser | null, cards: KnowledgeCard[]): KnowledgeCard[] {
  return cards.flatMap((card) => visibleKnowledgeCard(user, card) ?? []);
}

export function getUserOwnershipLabel(user: SessionUser): string {
  return user.ownershipLabel;
}

export function demoAccountsByRole(): Array<{
  role: Role;
  accounts: DemoAccount[];
}> {
  return ROLES.map((role) => ({
    role,
    accounts: demoAccounts.filter((account) => account.role === role),
  }));
}
