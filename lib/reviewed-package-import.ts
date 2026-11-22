import { createHash } from "node:crypto";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { universities } from "./data";
import { docClient, getStorageMode } from "./db";
import { createPendingDiskSync } from "./disk-sync";
import { syncKnowledgeCardRecord } from "./disk-sync-service";
import {
  getApprovedVersion,
  getCardStatus,
  getRequiredUniversityApprovals,
  isCardReadyForPublication,
  type KnowledgeCard,
} from "./knowledge";
import {
  describeApprovedCardVersion,
  getApprovedCardVersion,
  getCardVersionId,
  insertCardVersion,
  type ApprovedCardVersion,
} from "./knowledge-versions";
import { getKnowledgeCardById } from "./models";
import { TableName } from "./schema";
import {
  evidenceUrlSchema,
  knowledgeCardInputSchema,
  knowledgeSourceSchema,
} from "./validation/knowledge";

const importActor = {
  id: "reviewed-package-import",
  name: "Координатор по поручению владельца: независимая сверка официальных источников",
};
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const reviewerText = z.string().trim().min(1).max(300);
const catalog = z.strictObject({
  preparedAt: timestamp,
  method: z.string().trim().min(1),
  cards: z.array(z.unknown()).min(1),
});
const review = z.strictObject({
  packageSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  reviewedAt: timestamp,
  reviewer: reviewerText,
  approvedIds: z.array(id),
  pendingIds: z.array(id),
  reviewDocument: reviewerText,
});
const sourceMetadata = z.strictObject({
  url: evidenceUrlSchema,
  publisher: reviewerText,
  publishedAt: z.iso.date().nullish(),
  checkedAt: timestamp,
  claims: z.array(z.string().trim().min(1)),
});
const entry = z.strictObject({
  card: z.unknown(),
  proposedStatus: z.enum(["approved", "pending"]),
  approvalBasis: z.string().trim().min(1).max(500),
  requiresParticipantApproval: z.boolean(),
  sources: z.array(sourceMetadata).min(1).max(24),
  openQuestions: z.array(z.string().trim().min(1)),
});
const identifiers = z.object({
  id,
  requiredApprovalUniversityIds: z
    .array(
      z
        .string()
        .refine((value) =>
          universities.some((university) => university.id === value)
        )
    )
    .optional(),
});

type Disposition = "approved" | "pending";
type ValidationCode =
  | "invalid-verification"
  | "hash-mismatch"
  | "invalid-package"
  | "invalid-card"
  | "invalid-coverage"
  | "approval-denied"
  | "missing-reviewers"
  | "custom-type"
  | "sync-requires-apply"
  | "database-unavailable";

export class ReviewedPackageError extends Error {
  constructor(
    readonly code: ValidationCode,
    readonly cardId?: string
  ) {
    super(code);
    this.name = "ReviewedPackageError";
  }
}

type Provenance = {
  kind: "reviewed-package";
  packageSha256: string;
  reviewedAt: string;
  reviewer: string;
  reviewDocument: string;
  importedAt: string;
  disposition: Disposition;
  requiresParticipantApproval: boolean;
  openQuestions: string[];
  evidence: z.infer<typeof sourceMetadata>[];
};
type ImportedCard = KnowledgeCard & { importProvenance: Provenance };
type ReviewedVersion = ApprovedCardVersion & {
  importProvenance: Pick<
    Provenance,
    "kind" | "packageSha256" | "reviewedAt" | "reviewer" | "reviewDocument"
  >;
};
type Item = {
  card: ImportedCard;
  disposition: Disposition;
  version?: ReviewedVersion;
};

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReviewedPackageError("invalid-package");
  }
}

export function prepareReviewedPackage(
  bytes: Uint8Array,
  verification: unknown,
  importedAt = new Date().toISOString()
) {
  const checked = review.safeParse(verification);
  if (!checked.success) throw new ReviewedPackageError("invalid-verification");
  const { approvedIds, pendingIds, reviewedAt, reviewer, reviewDocument } =
    checked.data;
  const packageSha256 = createHash("sha256").update(bytes).digest("hex");
  if (packageSha256 !== checked.data.packageSha256.toLowerCase())
    throw new ReviewedPackageError("hash-mismatch");
  const packageData = catalog.safeParse(parseJson(bytes));
  if (!packageData.success) throw new ReviewedPackageError("invalid-package");
  const verdicts = new Map<string, Disposition>();
  for (const [ids, disposition] of [
    [approvedIds, "approved"],
    [pendingIds, "pending"],
  ] as const) {
    for (const cardId of ids) {
      if (verdicts.has(cardId))
        throw new ReviewedPackageError("invalid-coverage", cardId);
      verdicts.set(cardId, disposition);
    }
  }
  if (verdicts.size !== packageData.data.cards.length)
    throw new ReviewedPackageError("invalid-coverage");

  const seen = new Set<string>();
  const items = packageData.data.cards.map((raw): Item => {
    const row = entry.safeParse(raw);
    if (!row.success) throw new ReviewedPackageError("invalid-card");
    const {
      card: rawCard,
      proposedStatus,
      requiresParticipantApproval,
      approvalBasis,
      openQuestions,
    } = row.data;
    const meta = identifiers.safeParse(rawCard);
    if (!meta.success) throw new ReviewedPackageError("invalid-card");
    const cardId = meta.data.id;
    const disposition = verdicts.get(cardId);
    if (!disposition || seen.has(cardId))
      throw new ReviewedPackageError("invalid-coverage", cardId);
    seen.add(cardId);

    const content = knowledgeCardInputSchema.safeParse(rawCard);
    if (!content.success)
      throw new ReviewedPackageError("invalid-card", cardId);
    const input = content.data;
    if (input.type === "custom")
      throw new ReviewedPackageError("custom-type", cardId);
    const participants =
      input.type === "project" && input.isJoint
        ? input.participantUniversityIds
        : [];
    const requiredApprovals = Array.from(
      new Set([
        ...participants,
        ...(meta.data.requiredApprovalUniversityIds ?? []),
      ])
    );
    const approved = disposition === "approved";
    if (
      approved &&
      (proposedStatus !== "approved" ||
        requiresParticipantApproval ||
        requiredApprovals.length ||
        (input.type === "project" && input.isJoint) ||
        !isCardReadyForPublication(input))
    )
      throw new ReviewedPackageError("approval-denied", cardId);
    if (requiresParticipantApproval && !requiredApprovals.length)
      throw new ReviewedPackageError("missing-reviewers", cardId);

    const sources = z.array(knowledgeSourceSchema).safeParse(
      row.data.sources.map((source) => ({
        url: source.url,
        title: source.publisher,
        ...(source.publishedAt && { publishedAt: source.publishedAt }),
      }))
    );
    if (!sources.success)
      throw new ReviewedPackageError("invalid-card", cardId);
    const provenance = {
      kind: "reviewed-package" as const,
      packageSha256,
      reviewedAt,
      reviewer,
      reviewDocument,
    };
    const card: ImportedCard = {
      ...input,
      id: cardId,
      ownerIds: [],
      status: disposition,
      sources: sources.data,
      changeReason: approvalBasis,
      createdAt: importedAt,
      updatedAt: importedAt,
      diskSync: createPendingDiskSync(),
      ...(approved && { reviewedBy: importActor.name, reviewedAt: importedAt }),
      ...(requiredApprovals.length && {
        requiredApprovalUniversityIds: requiredApprovals,
      }),
      importProvenance: {
        ...provenance,
        importedAt,
        disposition,
        requiresParticipantApproval,
        openQuestions,
        evidence: row.data.sources,
      },
    };
    const version = approved
      ? {
          ...describeApprovedCardVersion(card, {
            legacyBaseline: false,
            recordedAt: importedAt,
            actor: importActor,
            reason: approvalBasis,
          }),
          importProvenance: provenance,
        }
      : undefined;
    return { card, disposition, version };
  });
  return { packageSha256, items };
}

type Outcome =
  | "would-insert"
  | "inserted"
  | "preserved"
  | "collision"
  | "snapshot-conflict"
  | "write-failed";
type UploadOutcome =
  | "synced"
  | "failed"
  | "pending"
  | "skipped-changed"
  | "skipped-write-failed";
type ReportRow = {
  id: string;
  status: Disposition;
  outcome: Outcome;
  sync?: UploadOutcome;
};

function sameContent(existing: KnowledgeCard, item: Item) {
  return (
    getCardStatus(existing) === item.disposition &&
    (item.disposition === "pending"
      ? !existing.approvedSnapshot &&
        JSON.stringify([...getRequiredUniversityApprovals(existing)].sort()) ===
          JSON.stringify([...getRequiredUniversityApprovals(item.card)].sort())
      : getApprovedVersion(existing) === existing) &&
    getCardVersionId(existing) === getCardVersionId(item.card)
  );
}

function sameImportProof(
  stored: Partial<ReviewedVersion>,
  expected: ReviewedVersion
) {
  const proof = stored.importProvenance;
  return (
    stored.id === expected.id &&
    stored.cardId === expected.cardId &&
    stored.snapshot?.id === expected.cardId &&
    getApprovedVersion(stored.snapshot) === stored.snapshot &&
    getCardVersionId(stored.snapshot) === expected.id &&
    stored.actorId === expected.actorId &&
    stored.actorName === expected.actorName &&
    stored.reason === expected.reason &&
    stored.legacyBaseline === false &&
    stored.recordedAt === stored.snapshot.reviewedAt &&
    stored.snapshot.reviewedBy === importActor.name &&
    proof?.kind === expected.importProvenance.kind &&
    proof.packageSha256 === expected.importProvenance.packageSha256 &&
    proof.reviewedAt === expected.importProvenance.reviewedAt &&
    proof.reviewer === expected.importProvenance.reviewer &&
    proof.reviewDocument === expected.importProvenance.reviewDocument
  );
}

async function observe(item: Item): Promise<Outcome> {
  const existing = (await getKnowledgeCardById(
    item.card.id
  )) as ImportedCard | null;
  if (existing && !sameContent(existing, item)) return "collision";
  const version = item.version
    ? await getApprovedCardVersion(item.version.id)
    : null;
  if (!existing) return version ? "snapshot-conflict" : "would-insert";
  if (
    item.version &&
    existing.importProvenance?.packageSha256 ===
      item.card.importProvenance.packageSha256 &&
    (!version || !sameImportProof(version, item.version))
  ) {
    return "snapshot-conflict";
  }
  return "preserved";
}

async function insert(item: Item): Promise<Outcome> {
  const cardWrite = {
    TableName: TableName.KNOWLEDGE_CARDS,
    Item: item.card,
    ConditionExpression: "attribute_not_exists(id)",
  };
  try {
    if (item.version) {
      await docClient.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: cardWrite },
            { Put: insertCardVersion(item.version) },
          ],
        })
      );
    } else {
      await docClient.send(new PutCommand(cardWrite));
    }
    return "inserted";
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "ConditionalCheckFailedException",
        "TransactionCanceledException",
      ].includes(error.name)
    ) {
      const observed = await observe(item).catch(() => "write-failed" as const);
      if (observed !== "would-insert") return observed;
    }
    return "write-failed";
  }
}

async function synchronize(item: Item): Promise<UploadOutcome> {
  try {
    const actual = await getKnowledgeCardById(item.card.id);
    if (
      !actual ||
      !sameContent(actual, item) ||
      (await observe(item)) !== "preserved"
    )
      return "skipped-changed";
    const updated = await syncKnowledgeCardRecord(actual);
    if (!sameContent(updated, item)) return "skipped-changed";
    const sync = updated.diskSync;
    if (
      sync?.status === "synced" &&
      sync.sourceUpdatedAt === updated.updatedAt &&
      sync.filePath &&
      sync.summaryPath &&
      sync.fileUploaded &&
      sync.summaryUploaded
    )
      return "synced";
    return sync?.status === "pending" ? "pending" : "failed";
  } catch {
    return "failed";
  }
}

export async function importReviewedPackage(
  bytes: Uint8Array,
  verification: unknown,
  options: { apply?: boolean; sync?: boolean } = {}
) {
  if (options.sync && !options.apply)
    throw new ReviewedPackageError("sync-requires-apply");
  const { packageSha256, items } = prepareReviewedPackage(bytes, verification);
  if ((await getStorageMode()) !== "dynamodb")
    throw new ReviewedPackageError("database-unavailable");
  const rows: ReportRow[] = [];
  for (const item of items) {
    rows.push({
      id: item.card.id,
      status: item.disposition,
      outcome: await observe(item),
    });
  }

  if (options.apply) {
    for (const [index, row] of rows.entries()) {
      if (row.outcome === "would-insert")
        row.outcome = await insert(items[index]);
    }
  }

  const writeFailed = rows.filter(
    (row) => row.outcome === "write-failed"
  ).length;
  if (options.sync) {
    for (const [index, item] of items.entries()) {
      if (item.disposition !== "approved") continue;
      const row = rows[index];
      if (writeFailed) row.sync = "skipped-write-failed";
      else if (row.outcome === "preserved" || row.outcome === "inserted")
        row.sync = await synchronize(item);
      else row.sync = "skipped-changed";
    }
  }
  return {
    mode: options.apply ? "apply" : "dry-run",
    packageSha256,
    validated: rows.length,
    approved: rows.filter((row) => row.status === "approved").length,
    pending: rows.filter((row) => row.status === "pending").length,
    wouldInsert: rows.filter((row) => row.outcome === "would-insert").length,
    inserted: rows.filter((row) => row.outcome === "inserted").length,
    preserved: rows.filter((row) => row.outcome === "preserved").length,
    conflicts: rows.filter(
      (row) =>
        row.outcome === "collision" || row.outcome === "snapshot-conflict"
    ).length,
    writeFailed,
    synced: rows.filter((row) => row.sync === "synced").length,
    syncUnresolved: rows.filter((row) => row.sync && row.sync !== "synced")
      .length,
    rows,
  };
}
