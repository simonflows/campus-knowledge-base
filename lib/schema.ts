import {
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
} from "@aws-sdk/client-dynamodb";

export const TableName = {
  INFORMATION_REQUESTS: "information-requests",
  KNOWLEDGE_CARDS: "knowledge-cards",
  KNOWLEDGE_CARD_TYPES: "knowledge-card-types",
  ARTICLES: "knowledge-articles",
  EDITORIAL_DOCUMENTS: "editorial-documents",
  EDITORIAL_REVISIONS: "editorial-revisions",
} as const;

export type TableName = (typeof TableName)[keyof typeof TableName];

export interface TableSchema {
  name: TableName;
  keySchema: KeySchemaElement[];
  attributeDefinitions: AttributeDefinition[];
  globalSecondaryIndexes?: GlobalSecondaryIndex[];
}

export const TABLE_SCHEMAS: Record<TableName, TableSchema> = {
  [TableName.INFORMATION_REQUESTS]: {
    name: TableName.INFORMATION_REQUESTS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  },
  [TableName.EDITORIAL_DOCUMENTS]: {
    name: TableName.EDITORIAL_DOCUMENTS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  },
  [TableName.EDITORIAL_REVISIONS]: {
    name: TableName.EDITORIAL_REVISIONS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  },
  [TableName.KNOWLEDGE_CARDS]: {
    name: TableName.KNOWLEDGE_CARDS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  },
  [TableName.KNOWLEDGE_CARD_TYPES]: {
    name: TableName.KNOWLEDGE_CARD_TYPES,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  },
  [TableName.ARTICLES]: {
    name: TableName.ARTICLES,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  },
};

export const TABLE_NAMES: TableName[] = Object.values(TableName);
