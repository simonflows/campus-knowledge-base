import { z } from "zod";
import { universities } from "@/lib/data";

import {
  CONTOURS,
  CUSTOM_FIELD_TYPES,
  PLACEMENT_STATUSES,
  READINESS_STAGES,
  type CardTypeDefinition,
  type CustomCardField,
  type CustomFieldValue,
} from "@/lib/knowledge";

const text = z.string().trim().min(1, "Заполните поле");
const longText = z.string().trim().min(1, "Заполните поле").max(10_000);
const textList = z.array(text).default([]);
const universityIdSchema = text.refine(
  (id) => universities.some((university) => university.id === id),
  "Выберите вуз из списка резидентов"
);
const ownerIds = z.array(text.max(80)).max(2000)
  .refine(ids => new Set(ids).size === ids.length, "Владельцы не должны повторяться")
  .optional();

export const evidenceUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url("Укажите ссылку на документ")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Документ должен иметь безопасную HTTPS-ссылку без логина и пароля");

export const cardVersionIdSchema = z.string().regex(/^cv-[0-9a-f]{64}$/);

export const knowledgeSourceSchema = z.object({
  url: evidenceUrlSchema,
  title: text.max(300),
  publishedAt: z.iso.date().optional(),
  scope: text.max(400).optional(),
});

export const verifiedCardFactSchema = z.object({
  id: text.max(80),
  label: text.max(200),
  value: text.max(120),
  unit: text.max(80),
  year: z.number().int().min(1900).max(2200),
  scope: text.max(400),
  kind: z.enum(["actual", "plan"]),
  evidenceUrl: evidenceUrlSchema,
});

const evidenceFields = {
  // Empty explicitly clears the previous public reason. Omitted fields preserve older clients.
  changeReason: z.string().trim().max(500).optional(),
  sources: z.array(knowledgeSourceSchema).max(24).optional(),
  verifiedFacts: z.array(verifiedCardFactSchema).max(32)
    .refine(facts => new Set(facts.map(fact => fact.id)).size === facts.length, "Факты не должны повторяться")
    .optional(),
};

export const updateCardFreshnessSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("schedule"),
    nextReviewAt: z.iso.date().nullable(),
    responsibleId: text.max(80).nullable().optional(),
  }),
  z.strictObject({
    action: z.literal("verify"),
    versionId: cardVersionIdSchema,
  }),
]);

export function canonicalCustomFieldValues(fields: Record<string, CustomFieldValue | undefined>): Record<string, CustomFieldValue> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, CustomFieldValue] => entry[1] !== undefined)
  );
}

export const structuredMetricSchema = z.object({
  id: text.max(80),
  label: text.max(200),
  value: z.number().finite().nonnegative(),
  unit: text.max(80),
  year: z.number().int().min(1900).max(2200),
  kind: z.enum(["actual", "plan"]),
  evidenceUrl: evidenceUrlSchema,
  verifiedAt: z.iso.date(),
  owner: text.max(200),
});

const baseCardSchema = z.object({
  ...evidenceFields,
  ownerIds,
  title: text.max(200),
  folderId: text,
  owners: z.array(text).min(1, "Укажите хотя бы одного владельца карточки"),
  referenceDescription: longText,
  stopFormula: longText,
});

const projectCardSchema = baseCardSchema.extend({
  type: z.literal("project"),
  sphere: text,
  initiatorUniversityId: universityIdSchema.or(z.literal("")),
  coExecutors: textList,
  industrialPartner: text,
  readinessStage: z.enum(READINESS_STAGES),
  contour: z.enum(CONTOURS),
  confirmedFigures: textList,
  isJoint: z.boolean().default(false),
  participantUniversityIds: z.array(universityIdSchema).default([]),
  externalParticipantNames: z.array(text.max(300)).max(20).optional(),
});

const laboratoryCardSchema = baseCardSchema.extend({
  type: z.literal("laboratory"),
  affiliation: text,
  partner: text,
  head: text,
  placementStatus: z.enum(PLACEMENT_STATUSES),
  placementDetails: text,
  workDirections: textList,
  equipment: textList,
  confirmedIndicators: textList,
});

const campusMetricSchema = z.object({
  label: text,
  value: text,
  note: text,
});

const campusTariffSchema = z.object({
  label: text,
  value: text,
});

const campusLegalEntitySchema = z.object({
  name: text,
  role: text,
});

const campusCardSchema = baseCardSchema.extend({
  type: z.literal("campus"),
  campusMetrics: z.array(campusMetricSchema).min(1),
  tariffs: z.array(campusTariffSchema).min(1),
  legalEntities: z.array(campusLegalEntitySchema).min(1),
  stopList: z.array(text).min(1),
});

const universityCardSchema = baseCardSchema.extend({
  type: z.literal("university"),
  universityId: text.refine(
    (id) => universities.some((university) => university.id === id),
    "Выберите вуз"
  ),
  structuredMetrics: z.array(structuredMetricSchema).max(100).default([]),
});

export const customCardFieldInputSchema = z
  .object({
    id: text.max(80),
    name: text.max(120),
    type: z.enum(CUSTOM_FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(text.max(120)).default([]),
  })
  .superRefine((field, ctx) => {
    if (field.type === "select" && field.options.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "Добавьте хотя бы один вариант выбора",
      });
    }
  });

const cardTypeFieldsSchema = z
  .array(customCardFieldInputSchema)
  .min(1, "Добавьте хотя бы одно поле")
  .max(50, "Слишком много полей")
  .superRefine((fields, ctx) => {
    const ids = new Set<string>();

    fields.forEach((field, index) => {
      if (ids.has(field.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Идентификаторы полей не должны повторяться",
        });
      }

      ids.add(field.id);
    });
  });

export const cardTypeInputSchema = z.object({
  name: text.max(120),
  description: z.string().trim().max(500).default(""),
  fields: cardTypeFieldsSchema,
});

export const cardTypeUpdateSchema = z
  .object({
    name: text.max(120).optional(),
    description: z.string().trim().max(500).optional(),
    fields: cardTypeFieldsSchema.optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.fields !== undefined,
    { message: "Нет данных для обновления" }
  );

export type CardTypeInput = z.infer<typeof cardTypeInputSchema>;

const customCardSchema = z.object({
  ...evidenceFields,
  ownerIds,
  type: z.literal("custom"),
  customTypeId: text,
  title: text.max(200),
  folderId: z.string().trim().optional().default(""),
  owners: z.array(text).min(1, "Укажите хотя бы одного владельца карточки"),
  referenceDescription: z.string().trim().max(10_000).default(""),
  stopFormula: z.string().trim().max(10_000).default(""),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const knowledgeCardInputSchema = z
  .discriminatedUnion("type", [
    projectCardSchema,
    laboratoryCardSchema,
    campusCardSchema,
    customCardSchema,
    universityCardSchema,
  ])
  .superRefine((card, ctx) => {
    if (card.type === "university") {
      if (card.folderId !== `01_universities/${card.universityId}/passport`) {
        ctx.addIssue({
          code: "custom",
          path: ["folderId"],
          message: "Паспорт должен храниться в папке своего вуза",
        });
      }
      const keys = card.structuredMetrics.map(
        (metric) =>
          `${metric.label.toLowerCase().trim()}|${metric.unit.toLowerCase().trim()}|${metric.year}|${metric.kind}`
      );
      if (
        new Set(keys).size !== keys.length ||
        new Set(card.structuredMetrics.map((metric) => metric.id)).size !==
          card.structuredMetrics.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["structuredMetrics"],
          message: "Показатель, единица, год и статус должны быть уникальны",
        });
      }
    }
    if (card.type === "project" && !card.isJoint && !card.initiatorUniversityId) {
      ctx.addIssue({
        code: "custom",
        path: ["initiatorUniversityId"],
        message: "Для проекта одного вуза укажите вуз-инициатор",
      });
    }
    if (
      card.type === "project" &&
      card.isJoint &&
      ((new Set(card.participantUniversityIds).size < 2 && !(card.participantUniversityIds.length >= 1 && card.externalParticipantNames?.length)) ||
        (card.initiatorUniversityId && !card.participantUniversityIds.includes(card.initiatorUniversityId)))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["participantUniversityIds"],
        message: "Укажите двух участников: вузы-резиденты либо вуз-резидент и внешняя организация. Если инициатор известен, включите его в список.",
      });
    }
    if (card.type === "project" && card.externalParticipantNames?.length && !card.isJoint) {
      ctx.addIssue({ code: "custom", path: ["isJoint"], message: "Проект с внешним соавтором отмечается как совместный" });
    }
  });

export type KnowledgeCardInput = z.infer<typeof knowledgeCardInputSchema>;

function isEmptyValue(value: unknown): value is undefined | null | "" | [] {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function customFieldValueSchema(field: CustomCardField) {
  let base: z.ZodType<CustomFieldValue>;

  switch (field.type) {
    case "longText":
      base = z.string().trim().max(10_000, "Слишком длинный текст");
      break;
    case "number":
      base = z.number().finite("Введите число");
      break;
    case "date":
      base = z
        .string()
        .trim()
        .pipe(z.iso.date("Укажите дату в формате ГГГГ-ММ-ДД"));
      break;
    case "list":
      base = z.array(z.string().trim().min(1, "Заполните элемент списка"));
      break;
    case "select":
      base = z
        .string()
        .trim()
        .refine(
          (value) => field.options.includes(value),
          "Выберите значение из списка"
        );
      break;
    case "cardReference":
      base = z.string().trim().min(1, "Выберите карточку");
      break;
    default:
      base = z.string().trim().max(1_000, "Слишком длинный текст");
  }

  const schema = z.unknown().transform((value, ctx) => {
    const normalized = typeof value === "string" ? value.trim() : value;
    if (isEmptyValue(normalized)) {
      if (field.required) {
        ctx.addIssue({
          code: "custom",
          message: "Заполните обязательное поле",
        });
        return z.NEVER;
      }
      return normalized;
    }

    const parsed = base.safeParse(normalized);

    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message: parsed.error.issues[0]?.message ?? "Некорректное значение",
      });
      return z.NEVER;
    }
    return parsed.data;
  });
  return field.required ? schema : schema.optional();
}

export function buildCustomFieldValuesSchema(typeDef: CardTypeDefinition) {
  return z.object(
    Object.fromEntries(
      typeDef.fields.map((field) => [field.id, customFieldValueSchema(field)])
    )
  );
}
