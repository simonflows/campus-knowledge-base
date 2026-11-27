import { z } from "zod";
import { areCardOwnerIdsAssignable, resolveLegacyCardOwnerIds } from "./auth";
import {
  folderIds,
  isCardReadyForPublication,
  type KnowledgeCard,
} from "./knowledge";
import { sessionDirectory } from "./pilot-auth";
import { getStorageMode } from "./db";
import { createPendingDiskSync } from "./disk-sync";
import {
  getCardTypeById,
  getKnowledgeCardById,
  insertApprovedKnowledgeCard,
} from "./models";
import { isManagedStrategyCard } from "./strategy";
import {
  buildCustomFieldValuesSchema,
  canonicalCustomFieldValues,
  knowledgeCardInputSchema,
} from "./validation/knowledge";

export class ImportValidationError extends Error {}

const label = z.string().trim().min(1).max(200);
const metadata = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  status: z.literal("approved"),
  participantApprovals: z.array(label).optional(),
});
const manifestSchema = z.strictObject({
  approvedBy: label,
  approvedAt: z.iso.datetime({ offset: true }),
  cards: z.array(z.unknown()).min(1),
});

function parseManifest(value: unknown) {
  const manifest = manifestSchema.safeParse(value);
  if (!manifest.success)
    throw new ImportValidationError(
      "Проверьте поля approvedBy, approvedAt и cards файла импорта."
    );
  const { approvedBy, approvedAt, cards } = manifest.data;
  const directory = sessionDirectory();
  const ids = new Set<string>();
  return cards.map((row, index) => {
    const meta = metadata.safeParse(row);
    const input = knowledgeCardInputSchema.safeParse(row);
    if (!meta.success || !input.success)
      throw new ImportValidationError(
        `Карточка №${index + 1}: проверьте id, статус approved и поля выбранного типа.`
      );
    const { id, participantApprovals = [] } = meta.data;
    if (ids.has(id))
      throw new ImportValidationError(
        `Карточка №${index + 1}: повторяется id.`
      );
    ids.add(id);
    const card = input.data;
    if (
      isManagedStrategyCard(card) ||
      ((card.type === "project" || card.type === "laboratory") &&
        card.strategyLinks?.length)
    ) {
      throw new ImportValidationError(
        `Карточка №${index + 1}: документы, связи и показатели вносятся через согласование карточек.`
      );
    }
    if (!isCardReadyForPublication(card)) {
      throw new ImportValidationError(
        `Карточка №${index + 1}: для утверждённого проекта укажите стадию и контур по источникам.`
      );
    }
    if (card.type === "custom")
      card.folderId = folderIds.customType(card.customTypeId);
    const ownerIds =
      card.ownerIds ?? resolveLegacyCardOwnerIds(card, directory) ?? [];
    if (!areCardOwnerIdsAssignable(card, ownerIds, directory)) {
      throw new ImportValidationError(
        `Карточка №${index + 1}: проверьте права и идентификаторы владельцев.`
      );
    }
    const joint = card.type === "project" && card.isJoint;
    if (
      joint &&
      card.participantUniversityIds.some(
        (university) => !participantApprovals.includes(university)
      )
    ) {
      throw new ImportValidationError(
        `Карточка №${index + 1}: нужны подтверждения всех вузов-участников.`
      );
    }
    return {
      ...card,
      id,
      ownerIds,
      status: meta.data.status,
      ...(joint && { participantApprovals: card.participantUniversityIds }),
      reviewedBy: approvedBy,
      reviewedAt: approvedAt,
      updatedAt: approvedAt,
      createdAt: approvedAt,
      diskSync: createPendingDiskSync(),
    };
  });
}

export async function importApprovedKnowledge(value: unknown, apply = false) {
  const cards = parseManifest(value);
  const result = { validated: cards.length, inserted: 0, preserved: 0 };
  // Custom fields use the definitions already installed in the target database.
  if (
    (apply || cards.some((card) => card.type === "custom")) &&
    (await getStorageMode()) !== "dynamodb"
  ) {
    throw new ImportValidationError(
      "Для этой операции нужна подключённая база DynamoDB."
    );
  }
  const validated: KnowledgeCard[] = [];
  for (const card of cards) {
    if (card.type !== "custom") {
      validated.push(card);
      continue;
    }
    const definition = await getCardTypeById(card.customTypeId);
    if (!definition)
      throw new ImportValidationError(
        "Пользовательский тип карточки отсутствует в базе."
      );
    const fields = buildCustomFieldValuesSchema(definition)
      .strict()
      .safeParse(card.customFields);
    if (!fields.success)
      throw new ImportValidationError(
        "Проверьте поля пользовательской карточки."
      );
    validated.push({
      ...card,
      customFields: canonicalCustomFieldValues(fields.data),
    });
  }
  if (!apply) return result;
  for (const card of validated) {
    if (await getKnowledgeCardById(card.id)) {
      result.preserved++;
      continue;
    }
    try {
      await insertApprovedKnowledgeCard(card);
      result.inserted++;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.name === "ConditionalCheckFailedException" &&
          (await getKnowledgeCardById(card.id))
        )
      )
        throw error;
      result.preserved++;
    }
  }
  return result;
}
