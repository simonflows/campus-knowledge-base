import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { TableName, TABLE_SCHEMAS } from "../lib/schema";
import type { KnowledgeCard } from "../lib/knowledge";
import type { ReadyArticle } from "../lib/articles";
import { installPilotFixture } from "./pilot-fixture";

let phase = "scope-guard";
let closeClient: (() => void) | undefined;
const reportError = console.error.bind(console);

class ScopeViolation extends Error {
  constructor() {
    super("Table operation outside the test scope");
    this.name = "ScopeViolation";
  }
}

function checkTableOperation(command: unknown, tables: Set<string>): void {
  const scoped = (name?: string) => {
    if (!name || !tables.has(name)) throw new ScopeViolation();
  };
  if (command instanceof TransactWriteCommand) {
    const items = command.input.TransactItems;
    if (!items?.length) throw new ScopeViolation();
    for (const item of items) {
      const operations = [
        item.Put,
        item.Update,
        item.Delete,
        item.ConditionCheck,
      ].filter((entry) => entry !== undefined);
      if (operations.length !== 1) throw new ScopeViolation();
      scoped(operations[0]?.TableName);
    }
    return;
  }
  if (
    command instanceof CreateTableCommand ||
    command instanceof DescribeTableCommand ||
    command instanceof GetCommand ||
    command instanceof PutCommand ||
    command instanceof ScanCommand ||
    command instanceof UpdateCommand
  ) {
    scoped(command.input.TableName);
    return;
  }
  throw new ScopeViolation();
}

// This operational acceptance test never addresses application tables. It is not a fixture initializer.
async function main() {
  const prefix = process.env.CAMPUS_RELEASE_QA_PREFIX ?? "";
  assert.match(
    prefix,
    /^qa095-[a-z0-9-]{8,45}-$/,
    "An explicit isolated qa095 prefix is required"
  );
  assert.equal(
    process.env.CAMPUS_RELEASE_STORAGE_TEST,
    "yes",
    "Explicit storage acceptance mode is required"
  );
  const endpoint = new URL(process.env.DOCUMENT_API_ENDPOINT ?? "");
  assert.ok(
    endpoint.protocol === "https:" ||
      ["http://127.0.0.1:8000", "http://localhost:8000"].includes(
        endpoint.origin
      )
  );
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.hash);
  assert.equal(process.env.USE_DATABASE, "true");
  if (endpoint.protocol === "http:") {
    assert.ok(
      process.env.AWS_ACCESS_KEY_ID === "campusLocalTest" &&
        process.env.AWS_SECRET_ACCESS_KEY === "localTestOnly",
      "Loopback smoke uses only synthetic credentials"
    );
  }
  assert.notEqual(
    process.env.OUTPUT_MODE,
    "export",
    "Use DynamoDB acceptance mode"
  );
  assert.equal(process.env.CANON_DISK_RECOVERY, "false", "QA requires the recovery timer to be off");
  assert.notEqual(
    process.env.CAMPUS_LOCAL_DEMO,
    "true",
    "Use DynamoDB acceptance mode"
  );
  // Only the test process receives synthetic accounts; real runtime secrets are neither read nor printed.
  process.env.YANDEX_DISK_OAUTH_TOKEN = "";
  process.env.YANDEX_AI_STUDIO_API_KEY = "";
  process.env.ALIBABA_DASHSCOPE_API_KEY = "";
  process.env.CAMPUS_PUBLIC_ORIGIN = "https://release-storage-qa.invalid";
  console.error = () => {};
  globalThis.fetch = async () => {
    throw new ScopeViolation();
  };
  const people = installPilotFixture();
  const schemas = Object.values(TABLE_SCHEMAS).map((schema) => ({
    ...schema,
    name: prefix + schema.name,
  }));
  assert.equal(schemas.length, 8);
  const allowed = new Set<string>(schemas.map((schema) => schema.name));
  assert.equal(allowed.size, 8);
  assert.throws(
    () =>
      checkTableOperation(
        new PutCommand({
          TableName: TableName.KNOWLEDGE_CARDS,
          Item: { id: "pure-guard-check" },
        }),
        allowed
      ),
    ScopeViolation
  );
  assert.throws(
    () => checkTableOperation(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: prefix + TableName.ARTICLES, Item: { id: "pure-guard-check" } } },
      { ConditionCheck: {
        TableName: TableName.KNOWLEDGE_CARDS, Key: { id: "pure-guard-check" },
        ConditionExpression: "attribute_exists(id)",
      } },
    ] }), allowed),
    ScopeViolation,
  );
  assert.throws(
    () =>
      checkTableOperation(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: prefix + TableName.KNOWLEDGE_CARDS,
                Item: { id: "pure-guard-check" },
              },
            },
            {
              Put: {
                TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
                Item: { id: "pure-guard-check" },
              },
            },
          ],
        }),
        allowed
      ),
    ScopeViolation
  );
  const healthTable = prefix + TableName.KNOWLEDGE_CARDS;
  const additive = new Set([
    prefix + TableName.KNOWLEDGE_CARD_VERSIONS,
    prefix + TableName.WORKFLOW_RECORDS,
  ]);
  const { docClient, resetDbAvailableCache } = await import("../lib/db");
  closeClient = () => docClient.destroy();
  const send = docClient.send.bind(docClient);
  let beforeEditorialWrite: ((operation: TransactWriteCommand) => Promise<void>) | undefined;
  // Guard every routed read/write, including nested transaction operations, before invoking any model.
  docClient.send = (async (command: unknown, ...rest: unknown[]) => {
    const forward = async (operation: unknown) => {
      checkTableOperation(operation, allowed);
      if (operation instanceof TransactWriteCommand &&
          operation.input.TransactItems?.some(item => item.Put?.TableName === TableName.EDITORIAL_DOCUMENTS)) {
        await beforeEditorialWrite?.(operation);
      }
      return Reflect.apply(send, docClient, [operation, ...rest]);
    };
    if (command instanceof ListTablesCommand) {
      // The production availability probe only needs a successful response. Use
      // a real scoped Describe instead of enumerating working table names.
      await forward(new DescribeTableCommand({ TableName: healthTable }));
      return { TableNames: [healthTable] };
    }
    return forward(command);
  }) as typeof docClient.send;
  resetDbAvailableCache();
  const mapped = TableName as unknown as Record<string, string>;
  for (const [key, name] of Object.entries(mapped)) mapped[key] = prefix + name;
  let createdTables = 0;
  async function ensureTable(schema: (typeof schemas)[number]) {
    let existing;
    try {
      existing = (
        await docClient.send(
          new DescribeTableCommand({ TableName: schema.name })
        )
      ).Table;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ResourceNotFoundException"
      )
        throw error;
    }
    if (!existing) {
      await docClient.send(
        new CreateTableCommand({
          TableName: schema.name,
          KeySchema: schema.keySchema,
          AttributeDefinitions: schema.attributeDefinitions,
          BillingMode: "PAY_PER_REQUEST",
        })
      );
      await waitUntilTableExists(
        { client: docClient, maxWaitTime: 90 },
        { TableName: schema.name }
      );
      existing = (
        await docClient.send(
          new DescribeTableCommand({ TableName: schema.name })
        )
      ).Table;
      createdTables++;
    }
    assert.equal(existing?.TableStatus, "ACTIVE");
    assert.deepEqual(existing?.KeySchema, schema.keySchema);
    assert.deepEqual(
      existing?.AttributeDefinitions,
      schema.attributeDefinitions
    );
  }
  phase = "base-schema";
  for (const schema of schemas.filter((schema) => !additive.has(schema.name)))
    await ensureTable(schema);
  const models = await import("../lib/models");
  const { knowledgeSeedCards, folderIds, getApprovedVersion } = await import("../lib/knowledge");
  const { knowledgeCardInputSchema } =
    await import("../lib/validation/knowledge");
  const { getApprovedCardVersion, getCardVersionId } =
    await import("../lib/knowledge-versions");
  const author = people.account("demo-pr-susu"),
    reviewer = people.account("demo-admin");
  const seed = knowledgeSeedCards.find(
    (card) => card.type === "project" && !card.isJoint
  )!;
  const sample = knowledgeCardInputSchema.parse({
    ...seed,
    title: "QA storage " + randomUUID(),
    owners: ["QA"],
    referenceDescription: "Синтетический текст для проверки хранения.",
    stopFormula: "Использовать только синтетические сведения QA.",
    coExecutors: [],
    industrialPartner: "QA",
    confirmedFigures: [],
  });
  phase = "additive-schema";
  const timestamp = new Date().toISOString();
  const legacy = {
    ...sample,
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "approved",
  };
  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Item: legacy,
      ConditionExpression: "attribute_not_exists(id)",
    })
  );
  for (const schema of schemas.filter((schema) => additive.has(schema.name)))
    await ensureTable(schema);
  const retained = await docClient.send(
    new GetCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Key: { id: legacy.id },
      ConsistentRead: true,
    })
  );
  assert.deepEqual(
    retained.Item,
    legacy,
    "An existing record survives the additive migration"
  );

  phase = "card-version";
  const card = await models.createKnowledgeCard(sample, { status: "approved" });
  assert.equal(
    (await getApprovedCardVersion(getCardVersionId(card)))?.cardId,
    card.id,
    "Card and immutable approved version commit together"
  );
  const changed = await models.updateKnowledgeCard(
    card.id,
    knowledgeCardInputSchema.parse({ ...card, title: card.title + " v2" }),
    { id: reviewer.id, name: reviewer.name, isAdmin: true },
    card.updatedAt
  );
  assert.ok(changed);
  assert.notEqual(getCardVersionId(changed), getCardVersionId(card));
  assert.equal(
    (await getApprovedCardVersion(getCardVersionId(changed)))?.snapshot.title,
    changed.title
  );
  assert.equal(
    (await getApprovedCardVersion(getCardVersionId(card)))?.snapshot.title,
    card.title
  );
  await assert.rejects(
    models.updateKnowledgeCard(
      card.id,
      knowledgeCardInputSchema.parse(card),
      undefined,
      card.updatedAt
    ),
    { name: "ConditionalCheckFailedException" }
  );
  phase = "custom-type-epoch";
  const type = await models.createCardType({
    id: randomUUID(),
    name: "QA storage type",
    description: "",
    fields: [
      {
        id: "scope",
        name: "Scope",
        type: "shortText",
        required: true,
        options: [],
      },
    ],
  });
  await models.createKnowledgeCard(
    {
      type: "custom",
      customTypeId: type.id,
      folderId: folderIds.customType(type.id),
      title: "QA custom card",
      owners: ["QA"],
      referenceDescription: "",
      stopFormula: "",
      customFields: { scope: "Isolated synthetic acceptance" },
    },
    { status: "pending" }
  );
  assert.notEqual(
    (await models.getCardTypeById(type.id))?.updatedAt,
    type.updatedAt
  );
  assert.equal(await models.countKnowledgeCardsByCustomType(type.id), 1);
  await assert.rejects(
    models.updateCardType(type.id, { fields: [] }, type.updatedAt),
    { name: "ConditionalCheckFailedException" }
  );

  phase = "editorial-receipt";
  const { createEditorial, getCurrentEditorialSnapshot, mutateEditorial } =
    await import("../lib/editorial-models");
  const { createEditorialSchema } = await import("../lib/editorial");
  const { updateEditorialReadiness } =
    await import("../lib/editorial-readiness");
  const draft = await createEditorial(
    author,
    createEditorialSchema.parse({
      content: {
        title: "QA exact revision",
        lead: card.referenceDescription,
        sourceCardIds: [card.id],
        sourceVersions: [
          { cardId: card.id, versionId: getCardVersionId(card) },
        ],
        universityId: author.universityId,
        sections: [
          {
            id: "context",
            heading: "Источник",
            level: 2,
            chunks: [{ id: "body", content: card.referenceDescription }],
          },
        ],
      },
    })
  );
  const checked = await updateEditorialReadiness(author, draft.id, {
    action: "check",
    version: draft.version,
    revisionId: draft.revisionId,
  });
  assert.ok(
    checked.check.checkedAt,
    "Exact revision check transaction persists"
  );
  const revised = (
    await mutateEditorial(draft.id, author, {
      action: "save",
      version: draft.version,
      content: { ...draft.content, title: "QA next revision" },
    })
  ).document;
  await assert.rejects(
    updateEditorialReadiness(author, draft.id, {
      action: "check",
      version: draft.version,
      revisionId: draft.revisionId,
    }),
    { status: 409 }
  );
  assert.notEqual(revised.revisionId, draft.revisionId);
  phase = "workflow-cas";
  const { createWorkflowSchema, workflowMutationSchema } =
    await import("../lib/workflow");
  const { createWorkflowRecord, mutateWorkflowRecord, getWorkflowEvents } =
    await import("../lib/workflow-models");
  const input = createWorkflowSchema.parse({
    kind: "package",
    operationId: randomUUID(),
    title: "QA storage package",
    responsibleId: author.id,
  });
  const pack = await createWorkflowRecord(author, input);
  assert.equal((await createWorkflowRecord(author, input)).id, pack.id);
  const mutations = await Promise.allSettled(
    ["QA edit A", "QA edit B"].map((title) =>
      mutateWorkflowRecord(
        author,
        pack.id,
        workflowMutationSchema.parse({
          action: "edit",
          version: pack.version,
          operationId: randomUUID(),
          title,
        })
      )
    )
  );
  assert.equal(
    mutations.filter((result) => result.status === "fulfilled").length,
    1
  );
  assert.equal(
    mutations.filter(
      (result) => result.status === "rejected" && result.reason.status === 409
    ).length,
    1
  );
  assert.deepEqual(
    (await getWorkflowEvents(author, pack.id)).map((event) => event.version),
    [1, 2]
  );
  const stored = await docClient.send(
    new GetCommand({
      TableName: TableName.EDITORIAL_DOCUMENTS,
      Key: { id: draft.id },
      ConsistentRead: true,
    })
  );
  assert.equal(stored.Item?.revisionId, revised.revisionId);
  phase = "disk-registry";
  const { createPendingDiskSync, diskAttemptMatches } =
    await import("../lib/disk-sync");
  const pending = {
    ...createPendingDiskSync(changed.diskSync),
    attemptId: randomUUID(),
    sourceUpdatedAt: changed.updatedAt,
    lastAttemptAt: timestamp,
  };
  await models.setKnowledgeCardDiskSync(
    changed.id,
    pending,
    changed.updatedAt,
    { previous: changed.diskSync },
    AbortSignal.timeout(5_000)
  );
  const summary = {
    id: "disk-registry:qa:" + randomUUID(),
    kind: "disk-registry" as const,
    versionId: randomUUID(),
    entityId: changed.id,
    summaryPath: "qa/synthetic.csv",
    confirmedAt: timestamp,
    fingerprint: randomUUID(),
  };
  const synced = {
    ...pending,
    status: "synced" as const,
    filePath: "qa/synthetic.md",
    summaryPath: summary.summaryPath,
    lastSyncedAt: timestamp,
    fileUploaded: true,
    summaryUploaded: true,
  };
  const finish = (
    expectedVersionId?: string,
    attemptId = pending.attemptId,
    next = summary
  ) =>
    models.setKnowledgeCardDiskSync(
      changed.id,
      synced,
      changed.updatedAt,
      attemptId,
      AbortSignal.timeout(5_000),
      { next, expectedVersionId }
    );
  await assert.rejects(finish(randomUUID()), {
    name: "ConditionalCheckFailedException",
  });
  assert.equal(
    await models.getDiskRegistry(summary.id, AbortSignal.timeout(5_000)),
    null
  );
  const unwritten = await models.getKnowledgeCardById(changed.id);
  assert.equal(unwritten?.diskSync?.status, "pending");
  assert.ok(diskAttemptMatches(unwritten?.diskSync, pending.attemptId));
  assert.equal((await finish())?.diskSync?.status, "synced");
  assert.deepEqual(
    await models.getDiskRegistry(summary.id, AbortSignal.timeout(5_000)),
    summary
  );
  await assert.rejects(
    finish(summary.versionId, randomUUID(), {
      ...summary,
      versionId: randomUUID(),
    }),
    { name: "ConditionalCheckFailedException" }
  );
  assert.deepEqual(
    await models.getDiskRegistry(summary.id, AbortSignal.timeout(5_000)),
    summary
  );

  const createSource = (label: string) => models.createKnowledgeCard(
    knowledgeCardInputSchema.parse({ ...sample, title: sample.title + " " + label, ownerIds: [] }),
    { status: "approved" },
  );

  async function submitEditorialDocument(document: { id: string; version: number; revisionId: string }) {
    return (await mutateEditorial(document.id, author, {
      action: "submit", version: document.version, revisionId: document.revisionId, reviewerId: reviewer.id, comment: "",
    })).document;
  }

  async function submitArticle(heads: KnowledgeCard[], options: { lead?: string; pins?: boolean } = {}) {
    const sources = heads.map(head => {
      const approved = getApprovedVersion(head);
      assert.ok(approved);
      return approved;
    });
    const source = sources[0];
    const lead = options.lead ?? source.referenceDescription;
    const document = await createEditorial(author, createEditorialSchema.parse({
      content: {
        title: "QA approval " + randomUUID(),
        lead,
        sourceCardIds: sources.map(card => card.id),
        ...(options.pins !== false && { sourceVersions: sources.map(card => ({ cardId: card.id, versionId: getCardVersionId(card) })) }),
        universityId: author.universityId,
        sections: [{ id: "qa", heading: "Источник",
          level: 2, chunks: [{ id: "qa-body", content: lead }] }],
      },
    }));
    return submitEditorialDocument(document);
  }

  const approveArticle = (document: Awaited<ReturnType<typeof submitArticle>>) =>
    mutateEditorial(document.id, reviewer, {
      action: "approve", version: document.version, revisionId: document.revisionId, comment: "",
    });

  phase = "article-source-commit";
  const ordinaryArticle = await submitArticle([changed]);
  const ordinary = await approveArticle(ordinaryArticle);
  assert.equal(ordinary.document.status, "approved");
  assert.equal((await models.getArticleById(ordinaryArticle.id))?.approval?.revisionId, ordinaryArticle.revisionId);

  phase = "article-source-commit-race";
  const raceSource = await createSource("race");
  const racedArticle = await submitArticle([raceSource]);
  let insertedRace = false;
  beforeEditorialWrite = async operation => {
    const sourceGuard = operation.input.TransactItems?.find(item => item.ConditionCheck?.Key?.id === raceSource.id)?.ConditionCheck;
    assert.equal(sourceGuard?.TableName, TableName.KNOWLEDGE_CARDS);
    assert.equal(sourceGuard?.ExpressionAttributeValues?.[":sourceHead"], raceSource.updatedAt);
    const replacement = await models.updateKnowledgeCard(
      raceSource.id,
      knowledgeCardInputSchema.parse({ ...raceSource, title: "QA newer source", referenceDescription: "Новая утверждённая формулировка QA." }),
      { id: reviewer.id, name: reviewer.name, isAdmin: true },
      raceSource.updatedAt,
    );
    assert.ok(replacement);
    assert.notEqual(getCardVersionId(replacement), getCardVersionId(raceSource));
    insertedRace = true;
  };
  try {
    await assert.rejects(approveArticle(racedArticle), { status: 409 });
  } finally {
    beforeEditorialWrite = undefined;
  }
  assert.ok(insertedRace);
  assert.equal(await models.getArticleById(racedArticle.id), null);
  const rejectedHead = await docClient.send(new GetCommand({
    TableName: TableName.EDITORIAL_DOCUMENTS, Key: { id: racedArticle.id }, ConsistentRead: true,
  }));
  assert.equal(rejectedHead.Item?.status, "submitted");
  assert.equal(rejectedHead.Item?.version, racedArticle.version);

  phase = "article-approved-snapshot-condition";
  const snapshotSource = await createSource("snapshot");
  const snapshotHead = await models.updateKnowledgeCard(
    snapshotSource.id,
    knowledgeCardInputSchema.parse({ ...snapshotSource, title: "Private QA revision awaiting review" }),
    { id: author.id, name: author.name, isAdmin: false },
    snapshotSource.updatedAt,
  );
  assert.ok(snapshotHead?.approvedSnapshot);
  assert.equal(snapshotHead.status, "pending");
  const snapshotArticle = await submitArticle([snapshotHead]);
  beforeEditorialWrite = async operation => {
    const guard = operation.input.TransactItems?.find(item => item.ConditionCheck?.Key?.id === snapshotHead.id)?.ConditionCheck;
    assert.match(guard?.ConditionExpression ?? "", /approvedSnapshot\.updatedAt/);
    assert.equal(guard?.ExpressionAttributeValues?.[":sourceHead"], snapshotHead.updatedAt);
    assert.equal(guard?.ExpressionAttributeValues?.[":publishedSnapshot"], snapshotSource.updatedAt);
  };
  try {
    await approveArticle(snapshotArticle);
  } finally {
    beforeEditorialWrite = undefined;
  }
  const publishedSnapshotArticle = await models.getArticleById(snapshotArticle.id);
  assert.equal(publishedSnapshotArticle?.sourceCardTitles[0], snapshotSource.title);
  assert.equal(publishedSnapshotArticle?.sourceVersions?.[0]?.versionId, getCardVersionId(snapshotSource));

  phase = "article-transaction-ceiling";
  const manySources = [changed];
  for (let start = 1; start < 22; start += 5) {
    manySources.push(...await Promise.all(
      Array.from({ length: Math.min(5, 22 - start) }, (_, offset) => createSource(`ceiling-${start + offset}`)),
    ));
  }
  const manySourcesArticle = await submitArticle(manySources);
  beforeEditorialWrite = async operation => {
    assert.equal(operation.input.TransactItems?.length, 25);
    assert.equal(operation.input.TransactItems?.filter(item => item.ConditionCheck?.TableName === TableName.KNOWLEDGE_CARDS).length, 22);
  };
  try {
    await approveArticle(manySourcesArticle);
  } finally {
    beforeEditorialWrite = undefined;
  }
  assert.equal((await models.getArticleById(manySourcesArticle.id))?.sourceCardIds.length, 22);

  function basisReference(publication: ReadyArticle) {
    assert.ok(publication.approval);
    const section = publication.sections[0];
    assert.ok(section?.chunks[0]?.content.trim());
    return {
      articleId: publication.id,
      revisionId: publication.approval.revisionId,
      sectionId: section.id,
      chunkId: section.chunks[0].id,
      articleTitle: publication.title,
      sectionHeading: section.heading,
    };
  }

  function basisGuard(operation: TransactWriteCommand, publication: ReadyArticle) {
    const guard = operation.input.TransactItems?.find(item =>
      item.ConditionCheck?.TableName === TableName.ARTICLES && item.ConditionCheck?.Key?.id === publication.id,
    )?.ConditionCheck;
    assert.match(guard?.ConditionExpression ?? "", /approval\.revisionId\s*=\s*:basisRevision/);
    assert.match(guard?.ConditionExpression ?? "", /updatedAt\s*=\s*:basisUpdated/);
    assert.equal(guard?.ExpressionAttributeValues?.[":basisRevision"], publication.approval?.revisionId);
    assert.equal(guard?.ExpressionAttributeValues?.[":basisUpdated"], publication.updatedAt);
  }

  phase = "article-library-basis-readback";
  assert.ok(ordinary.publication);
  const externalPublication = ordinary.publication;
  const basis = basisReference(externalPublication);
  const basisDraftInput = (publication: ReadyArticle) => createEditorialSchema.parse({
    content: { title: "QA draft based on an approved publication", universityId: author.universityId,
      articleBasis: [basisReference(publication)] },
  });
  let observedBasisGuard = false;
  beforeEditorialWrite = async operation => {
    basisGuard(operation, externalPublication);
    observedBasisGuard = true;
  };
  const basisDraft = await createEditorial(author, basisDraftInput(externalPublication)).finally(() => {
    beforeEditorialWrite = undefined;
  });
  assert.ok(observedBasisGuard);
  const storedBasis = await getCurrentEditorialSnapshot(basisDraft.id, author);
  assert.deepEqual(storedBasis.document.content.articleBasis, [basis]);
  assert.deepEqual(storedBasis.revision.content.articleBasis, [basis]);

  phase = "article-library-basis-race";
  for (const race of ["withdraw", "advance"] as const) {
    const publication = { ...externalPublication, id: "qa-basis-race-" + randomUUID() };
    await docClient.send(new PutCommand({
      TableName: TableName.ARTICLES, Item: publication, ConditionExpression: "attribute_not_exists(id)",
    }));
    const rejectedWrites: { table: string; id: string }[] = [];
    const advancedTimestamp = new Date(Date.parse(publication.updatedAt) + 1).toISOString();
    beforeEditorialWrite = async operation => {
      basisGuard(operation, publication);
      for (const { Put } of operation.input.TransactItems ?? []) {
        if (!Put) continue;
        const id: unknown = Put.Item?.id;
        assert.ok(Put.TableName && typeof id === "string");
        rejectedWrites.push({ table: Put.TableName, id });
      }
      assert.deepEqual(rejectedWrites.map(write => write.table).sort(),
        [TableName.EDITORIAL_DOCUMENTS, TableName.EDITORIAL_REVISIONS, TableName.EDITORIAL_REVISIONS].sort());
      // Change exactly one guard operand after the model validated the approved block.
      await docClient.send(new UpdateCommand({
        TableName: TableName.ARTICLES, Key: { id: publication.id },
        ...(race === "withdraw" ? { UpdateExpression: "REMOVE approval" } : {
          UpdateExpression: "SET updatedAt = :next", ExpressionAttributeValues: { ":next": advancedTimestamp },
        }),
        ConditionExpression: "attribute_exists(id)",
      }));
    };
    try {
      await assert.rejects(createEditorial(author, basisDraftInput(publication)), { status: 409 });
    } finally {
      beforeEditorialWrite = undefined;
    }
    assert.equal(rejectedWrites.length, 3);
    for (const write of rejectedWrites) {
      const { Item } = await docClient.send(new GetCommand({
        TableName: write.table, Key: { id: write.id }, ConsistentRead: true,
      }));
      assert.equal(Item, undefined, "Rejected basis must leave no draft, revision or event");
    }
    const { Item: racedBasis } = await docClient.send(new GetCommand({
      TableName: TableName.ARTICLES, Key: { id: publication.id }, ConsistentRead: true,
    }));
    assert.equal(racedBasis?.updatedAt, race === "withdraw" ? publication.updatedAt : advancedTimestamp);
    assert.deepEqual(racedBasis?.approval, race === "withdraw" ? undefined : publication.approval);
  }

  phase = "article-library-own-basis-ceiling";
  const previousEdition = await models.getArticleById(manySourcesArticle.id);
  assert.ok(previousEdition);
  const ownReference = basisReference(previousEdition);
  const { document: ownDraft } = await mutateEditorial(manySourcesArticle.id, author, {
    action: "save", version: (await getCurrentEditorialSnapshot(manySourcesArticle.id, author)).document.version,
    content: { ...manySourcesArticle.content, title: "QA revised edition based on its predecessor", articleBasis: [ownReference] },
  });
  const ownSubmitted = await submitEditorialDocument(ownDraft);
  let observedOwnBasisWrite = false;
  beforeEditorialWrite = async operation => {
    const items = operation.input.TransactItems ?? [];
    assert.equal(items.length, 25);
    assert.equal(items.filter(item => item.ConditionCheck?.TableName === TableName.KNOWLEDGE_CARDS).length, 22);
    assert.equal(items.filter(item => item.ConditionCheck?.TableName === TableName.ARTICLES).length, 0);
    const publicationPuts = items.filter(item => item.Put?.TableName === TableName.ARTICLES);
    assert.equal(publicationPuts.length, 1);
    const put = publicationPuts[0].Put;
    assert.equal(put?.Item?.id, previousEdition.id);
    assert.match(put?.ConditionExpression ?? "", /approval\.revisionId\s*=\s*:basisRevision/);
    assert.match(put?.ConditionExpression ?? "", /updatedAt\s*=\s*:basisUpdated/);
    assert.equal(put?.ExpressionAttributeValues?.[":basisRevision"], ownReference.revisionId);
    assert.equal(put?.ExpressionAttributeValues?.[":basisUpdated"], previousEdition.updatedAt);
    observedOwnBasisWrite = true;
  };
  try {
    await approveArticle(ownSubmitted);
  } finally {
    beforeEditorialWrite = undefined;
  }
  assert.ok(observedOwnBasisWrite);
  const ownPublication = await models.getArticleById(ownDraft.id);
  assert.equal(ownPublication?.approval?.revisionId, ownDraft.revisionId);
  assert.deepEqual(ownPublication?.articleBasis, [ownReference]);

  phase = "article-corpus-contradiction";
  const corpusCampus = structuredClone(knowledgeSeedCards.find(item => item.type === "campus")!);
  assert.equal(corpusCampus.type, "campus");
  corpusCampus.campusMetrics[0].value = "160 000 кв. м";
  await models.createKnowledgeCard(knowledgeCardInputSchema.parse({
    ...corpusCampus, title: "QA corpus campus passport", ownerIds: [],
  }), { status: "approved" });
  for (const pins of [false, true]) {
    const hiddenContradiction = await submitArticle([changed], {
      lead: "Общая площадь объектов кампуса — 150 000 кв. м.", pins,
    });
    await assert.rejects(approveArticle(hiddenContradiction), { status: 422 });
    assert.equal(await models.getArticleById(hiddenContradiction.id), null);
  }

  phase = "campus-stakeholder-cas";
  const { POST: moderate } = await import("../app/api/knowledge/cards/[id]/moderation/route");
  const { NextRequest } = await import("next/server");
  const { SESSION_COOKIE, signSessionToken } = await import("../lib/auth-server");
  const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const campus = await models.createKnowledgeCard(
    knowledgeCardInputSchema.parse({ ...knowledgeSeedCards.find(item => item.type === "campus")!,
      title: "QA campus passport", ownerIds: [] }),
    { status: "pending", submittedBy: reviewer.id, submittedByName: reviewer.name },
  );
  const moderationPath = `/api/knowledge/cards/${campus.id}/moderation`;
  const campusDecision = (profile: string, action: "approve" | "confirm-stakeholder", version?: string) => {
    const headers = new Headers({
      origin: "https://release-storage-qa.invalid",
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${signSessionToken(people.account(profile).id)}`,
    });
    if (version) headers.set("If-Match", version);
    const request = new NextRequest(`https://release-storage-qa.invalid${moderationPath}`, {
      method: "POST", headers, body: JSON.stringify({ action }),
    });
    const store = createRequestStoreForAPI(request, request.nextUrl, {
      tags: [], expirationsByCacheKind: new Map(),
    }, undefined, undefined, undefined);
    return workAsyncStorage.run({} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () =>
      workUnitAsyncStorage.run(store, () => moderate(request, { params: Promise.resolve({ id: campus.id }) })));
  };
  assert.equal((await campusDecision("demo-pr-susu", "confirm-stakeholder", campus.updatedAt)).status, 403);
  assert.equal((await campusDecision("demo-ministry", "approve", campus.updatedAt)).status, 403);
  assert.equal((await campusDecision("demo-admin", "approve", campus.updatedAt)).status, 409);
  assert.equal((await campusDecision("demo-rio", "confirm-stakeholder")).status, 428);
  assert.deepEqual((await models.getKnowledgeCardById(campus.id))?.stakeholderApprovals, undefined);
  assert.equal((await campusDecision("demo-ministry", "confirm-stakeholder", campus.updatedAt)).status, 200);
  const firstPass = await models.getKnowledgeCardById(campus.id);
  assert.ok(firstPass?.stakeholderApprovals?.ministry);
  const editedCampus = await models.updateKnowledgeCard(
    campus.id, knowledgeCardInputSchema.parse({ ...firstPass, title: "QA revised campus passport" }),
    { id: reviewer.id, name: reviewer.name, isAdmin: true }, firstPass.updatedAt,
  );
  assert.ok(editedCampus);
  assert.deepEqual(editedCampus.stakeholderApprovals, {});
  assert.equal((await campusDecision("demo-chkk", "confirm-stakeholder", firstPass.updatedAt)).status, 409);
  const concurrentCampus = await Promise.all(["demo-ministry", "demo-chkk"].map(profile =>
    campusDecision(profile, "confirm-stakeholder", editedCampus.updatedAt)));
  assert.deepEqual(concurrentCampus.map(result => result.status).sort(), [200, 409]);
  let candidate = await models.getKnowledgeCardById(campus.id);
  assert.ok(candidate?.stakeholderApprovals);
  for (const [profile, role] of [["demo-ministry", "ministry"], ["demo-chkk", "chkk"], ["demo-rio", "rio"]] as const) {
    if (!candidate.stakeholderApprovals?.[role]) {
      assert.equal((await campusDecision(profile, "confirm-stakeholder", candidate.updatedAt)).status, 200);
      candidate = await models.getKnowledgeCardById(campus.id);
      assert.ok(candidate);
    }
    assert.equal(candidate.stakeholderApprovals?.[role]?.actorId, people.account(profile).id);
    assert.equal(candidate.stakeholderApprovals?.[role]?.revisionId, getCardVersionId({ ...candidate, approvedSnapshot: undefined }));
  }
  assert.equal((await campusDecision("demo-admin", "approve", candidate.updatedAt)).status, 200);
  assert.equal((await models.getKnowledgeCardById(campus.id))?.status, "approved");

  phase = "nested-snapshot-disk-registry";
  const publicSnapshot = snapshotHead.approvedSnapshot;
  const nestedPending = {
    ...createPendingDiskSync(publicSnapshot.diskSync),
    attemptId: randomUUID(), sourceUpdatedAt: publicSnapshot.updatedAt, lastAttemptAt: timestamp,
  };
  const checkedSignal = () => AbortSignal.timeout(5_000);
  const startNested = await models.setKnowledgeSnapshotDiskSync(
    snapshotHead, publicSnapshot, nestedPending, { previous: publicSnapshot.diskSync }, checkedSignal(),
  );
  assert.equal(startNested?.approvedSnapshot?.diskSync?.attemptId, nestedPending.attemptId);
  assert.equal(startNested?.diskSync?.attemptId, snapshotHead.diskSync?.attemptId);
  const { diskRegistryId, EMPTY_DISK_REGISTRY_FINGERPRINT } = await import("../lib/yandex-disk");
  const { confirmEmptyDiskRegistry } = await import("../lib/disk-sync-service");
  const sequenceFolder = ["QA_Сводки", randomUUID()];
  const scopedRegistry = {
    ...summary, id: diskRegistryId("cards", sequenceFolder), entityId: publicSnapshot.id,
    versionId: randomUUID(), sequence: 1, pendingRows: 0,
    summaryPath: [...sequenceFolder, "synthetic.csv"].join("/"),
  };
  const nestedSynced = {
    ...nestedPending, ...synced, attemptId: nestedPending.attemptId,
    sourceUpdatedAt: publicSnapshot.updatedAt, summaryPath: scopedRegistry.summaryPath,
    filePath: [...sequenceFolder, "synthetic.md"].join("/"),
  };
  await assert.rejects(models.setKnowledgeSnapshotDiskSync(
    { ...snapshotHead, updatedAt: "2000-01-01T00:00:00.000Z" }, publicSnapshot, nestedSynced,
    nestedPending.attemptId, checkedSignal(), { next: scopedRegistry },
  ), { name: "ConditionalCheckFailedException" });
  assert.equal(await models.getDiskRegistry(scopedRegistry.id, checkedSignal()), null);
  const nestedCommit = await models.setKnowledgeSnapshotDiskSync(
    snapshotHead, publicSnapshot, nestedSynced, nestedPending.attemptId, checkedSignal(), { next: scopedRegistry },
  );
  assert.equal(nestedCommit?.status, "pending");
  assert.equal(nestedCommit?.approvedSnapshot?.diskSync?.status, "synced");
  assert.equal(nestedCommit?.diskSync?.status, snapshotHead.diskSync?.status);
  assert.deepEqual(await models.getDiskRegistry(scopedRegistry.id, checkedSignal()), scopedRegistry);

  phase = "disk-receipt-sequence-cas";
  const receiptAt = new Date().toISOString();
  assert.ok(await models.claimDiskRegistryReceipt(scopedRegistry, receiptAt, checkedSignal()));
  await assert.rejects(models.claimDiskRegistryReceipt(scopedRegistry, receiptAt, checkedSignal()), {
    name: "ConditionalCheckFailedException",
  });
  await assert.rejects(models.finishDiskRegistryReceipt(
    scopedRegistry, "2000-01-01T00:00:00.000Z", { path: "synthetic-ineligible.md" }, checkedSignal(),
  ), { name: "ConditionalCheckFailedException" });
  const receiptPath = [...sequenceFolder, "synthetic-confirmation.md"].join("/");
  await models.finishDiskRegistryReceipt(scopedRegistry, receiptAt, { path: receiptPath }, checkedSignal());
  const acknowledged = await models.getDiskRegistry(scopedRegistry.id, checkedSignal());
  assert.equal(acknowledged?.receiptPath, receiptPath);
  assert.equal(acknowledged?.sequence, 1);

  phase = "disk-empty-conditional-replacement";
  let observedNonempty = false;
  assert.equal(await confirmEmptyDiskRegistry(scopedRegistry, async () => {
    observedNonempty = true;
    return false;
  }), false);
  assert.ok(observedNonempty);
  assert.deepEqual(await models.getDiskRegistry(scopedRegistry.id, checkedSignal()), acknowledged);
  const emptyRegistry = {
    ...scopedRegistry, entityId: "", versionId: randomUUID(), sequence: 2,
    fingerprint: EMPTY_DISK_REGISTRY_FINGERPRINT, summaryPath: [...sequenceFolder, "synthetic-empty.csv"].join("/"),
  };
  await assert.rejects(models.replaceDiskRegistry({ next: emptyRegistry, expectedVersionId: randomUUID() }, checkedSignal()), {
    name: "ConditionalCheckFailedException",
  });
  await models.replaceDiskRegistry({ next: emptyRegistry, expectedVersionId: scopedRegistry.versionId }, checkedSignal());
  await assert.rejects(models.finishDiskRegistryReceipt(scopedRegistry, receiptAt, { path: receiptPath }, checkedSignal()), {
    name: "ConditionalCheckFailedException",
  });
  assert.deepEqual(await models.getDiskRegistry(scopedRegistry.id, checkedSignal()), emptyRegistry);

  phase = "image-qa-marker";
  const { articleSeed } = await import("../lib/articles");
  const marker = "qa-marker-" + randomUUID();
  const markerArticle = {
    ...structuredClone(articleSeed[0]),
    id: marker,
    title: "Disposable QA " + marker,
    approval: {
      approvedBy: "qa-fixture",
      approvedAt: new Date().toISOString(),
      revisionId: marker,
    },
  };
  await docClient.send(
    new PutCommand({
      TableName: TableName.ARTICLES,
      Item: markerArticle,
      ConditionExpression: "attribute_not_exists(id)",
    })
  );
  const { Item: storedMarker } = await docClient.send(
    new GetCommand({
      TableName: TableName.ARTICLES,
      Key: { id: marker },
      ConsistentRead: true,
    })
  );
  assert.equal(storedMarker?.id, marker);
  assert.equal(storedMarker?.title, markerArticle.title);
  assert.deepEqual(storedMarker?.approval, markerArticle.approval);

  console.log(
    JSON.stringify({
      status: "passed",
      mode: endpoint.protocol === "http:" ? "local-dynamodb" : "https-document-api",
      scope: prefix,
      tables: schemas.length,
      createdTables,
      marker,
      checks: [
        "namespace-guard",
        "additive-schema-readback",
        "legacy-record-retained",
        "atomic-card-version",
        "stale-card-write",
        "custom-type-epoch",
        "exact-revision-receipt",
        "stale-receipt",
        "workflow-retry",
        "concurrent-cas",
        "immutable-events",
        "atomic-disk-registry",
        "stale-disk-registry",
        "namespace-guard-conditional-check",
        "article-source-commit",
        "article-source-commit-race",
        "article-approved-snapshot-condition",
        "article-transaction-ceiling-25-actions",
        "article-library-basis-readback",
        "article-library-basis-race",
        "article-library-own-basis-transaction-ceiling",
        "article-corpus-contradiction",
        "campus-stakeholder-cas",
        "nested-snapshot-disk-registry",
        "disk-receipt-sequence-cas",
        "disk-empty-conditional-replacement",
        "image-qa-marker",
      ],
    })
  );
}

main()
  .catch((error: unknown) => {
    const types = new Set([
      "AssertionError",
      "TypeError",
      "SyntaxError",
      "RangeError",
      "ZodError",
      "ScopeViolation",
      "ResourceNotFoundException",
      "ResourceInUseException",
      "ValidationException",
      "ConditionalCheckFailedException",
      "TransactionCanceledException",
      "EditorialError",
      "WorkflowError",
      "AccessDeniedException",
      "UnrecognizedClientException",
      "TimeoutError",
    ]);
    const type =
      error instanceof Error && types.has(error.name)
        ? error.name
        : "UnexpectedError";
    reportError(
      JSON.stringify({
        status: "error",
        operation: "isolated-storage-acceptance",
        phase,
        type,
      })
    );
    process.exitCode = 1;
  })
  .finally(() => closeClient?.());
