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
import { installPilotFixture } from "./pilot-fixture";

let phase = "scope-guard";
let closeClient: (() => void) | undefined;

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
  assert.notEqual(
    process.env.CAMPUS_LOCAL_DEMO,
    "true",
    "Use DynamoDB acceptance mode"
  );
  // Only the test process receives synthetic accounts; real runtime secrets are neither read nor printed.
  process.env.YANDEX_DISK_OAUTH_TOKEN = "";
  process.env.YANDEX_AI_STUDIO_API_KEY = "";
  process.env.ALIBABA_DASHSCOPE_API_KEY = "";
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
  // Guard every routed read/write, including nested transaction operations, before invoking any model.
  docClient.send = (async (command: unknown, ...rest: unknown[]) => {
    const forward = (operation: unknown) => {
      checkTableOperation(operation, allowed);
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
  const { knowledgeSeedCards, folderIds } = await import("../lib/knowledge");
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
  const { createEditorial, mutateEditorial } =
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
    console.error(
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
