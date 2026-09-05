import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const docStatusEnum = pgEnum('doc_status', [
  'PENDING',
  'PARSING',
  'EMBEDDING',
  'READY',
  'FAILED',
]);

export type DocStatus = (typeof docStatusEnum.enumValues)[number];

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileName: varchar('file_name').notNull(),
  mimeType: varchar('mime_type').notNull(),
  s3Key: varchar('s3_key').notNull().unique(),
  status: docStatusEnum('status').default('PENDING').notNull(),
  // Extracted title, author, dates, emails, tenant scoping, ...
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * A chunk is either a parent (large context unit fed to the LLM) or a child
 * (small, highly specific search unit). Children carry `parentId`; parents
 * have `parentId = NULL`.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .references(() => documents.id, { onDelete: 'cascade' })
      .notNull(),

    // Parent-child hierarchy: search on the child, feed the parent to the LLM.
    parentId: uuid('parent_id').references((): AnyPgColumn => chunks.id, { onDelete: 'cascade' }),

    // Structural context, e.g. ["Annual Report", "Section 4", "Lease Agreements"]
    headerPath: jsonb('header_path').$type<string[]>(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),

    // ID of the corresponding vector in the vector store (chunk id itself for PgVector).
    vectorId: uuid('vector_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('chunks_document_id_idx').on(table.documentId), index('chunks_parent_id_idx').on(table.parentId)],
);

/**
 * Embedding dimensions must match the configured provider
 * (OpenAI text-embedding-3-small = 1536). Changing this requires a migration
 * AND a full re-embed of every document.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * PgVector-backed vector storage. Only "search units" get a row here:
 * a child chunk, or a parent that is small enough to stand alone.
 */
export const chunkEmbeddings = pgTable('chunk_embeddings', {
  chunkId: uuid('chunk_id')
    .primaryKey()
    .references(() => chunks.id, { onDelete: 'cascade' }),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
