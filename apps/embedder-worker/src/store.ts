import { eq, inArray, sql } from 'drizzle-orm';
import { chunks, documents, type DocStatus, type RefineryDb } from '@repo/db';
import { PgVectorStore } from '@repo/embedding-core';
import type { EmbedderStore } from './handler';

export function createDrizzleEmbedderStore(db: RefineryDb): EmbedderStore {
  const vectorStore = new PgVectorStore(db);

  return {
    async fetchSearchUnits(ids) {
      const rows = await db
        .select({ id: chunks.id, content: chunks.content, headerPath: chunks.headerPath })
        .from(chunks)
        .where(inArray(chunks.id, ids));
      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        headerPath: row.headerPath ?? [],
      }));
    },

    async upsertEmbeddings(rows) {
      await vectorStore.upsert(rows.map((row) => ({ id: row.chunkId, vector: row.vector })));
    },

    async markEmbedded(chunkIds) {
      // PgVector rows are keyed by chunk id, so the vector id IS the chunk id.
      await db
        .update(chunks)
        .set({ vectorId: sql`${chunks.id}` })
        .where(inArray(chunks.id, chunkIds));
    },

    async setStatus(documentId, status: DocStatus) {
      await db.update(documents).set({ status }).where(eq(documents.id, documentId));
    },
  };
}
