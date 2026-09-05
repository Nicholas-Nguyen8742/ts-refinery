import { eq } from 'drizzle-orm';
import type { ChildChunk, ParentChunk } from '@repo/chunking-engine';
import { chunks, documents, type DocStatus, type RefineryDb } from '@repo/db';
import type { ParserStore } from './handler';

export function createDrizzleParserStore(db: RefineryDb): ParserStore {
  return {
    async setStatus(documentId: string, status: DocStatus): Promise<void> {
      await db.update(documents).set({ status }).where(eq(documents.id, documentId));
    },

    async setMetadata(documentId: string, metadata: Record<string, unknown>): Promise<void> {
      await db.update(documents).set({ metadata }).where(eq(documents.id, documentId));
    },

    async replaceDocumentChunks(documentId, parents, children) {
      return db.transaction(async (tx) => {
        // Idempotent re-parse: wipe the previous hierarchy (embeddings cascade).
        await tx.delete(chunks).where(eq(chunks.documentId, documentId));
        if (parents.length === 0) return { searchUnitIds: [] };

        const parentRows = await tx
          .insert(chunks)
          .values(
            parents.map((parent) => ({
              documentId,
              content: parent.content,
              headerPath: parent.headerPath,
              tokenCount: parent.tokenCount,
            })),
          )
          .returning({ id: chunks.id });

        const parentsWithChildren = new Set(children.map((child) => child.parentIndex));
        const childValues = children.map((child) => {
          const parent = parentRows[child.parentIndex];
          if (!parent) {
            throw new Error(`Chunk references unknown parent index ${child.parentIndex}`);
          }
          return {
            documentId,
            parentId: parent.id,
            content: child.content,
            headerPath: child.headerPath,
            tokenCount: child.tokenCount,
          };
        });

        const childRows =
          childValues.length > 0
            ? await tx.insert(chunks).values(childValues).returning({ id: chunks.id })
            : [];

        const searchUnitIds = [
          ...parentRows
            .filter((_, index) => !parentsWithChildren.has(index))
            .map((row) => row.id),
          ...childRows.map((row) => row.id),
        ];

        return { searchUnitIds };
      });
    },
  };
}
