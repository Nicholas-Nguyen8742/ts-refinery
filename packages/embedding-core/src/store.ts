import { sql } from 'drizzle-orm';
import { chunkEmbeddings, type RefineryDb } from '@repo/db';

export interface VectorPoint {
  id: string;
  vector: number[];
}

export interface VectorStore {
  upsert(points: VectorPoint[]): Promise<void>;
}

const UPSERT_BATCH_SIZE = 500;

/** PgVector-backed store: one embedding row per search-unit chunk. */
export class PgVectorStore implements VectorStore {
  constructor(private readonly db: RefineryDb) {}

  async upsert(points: VectorPoint[]): Promise<void> {
    for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
      const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
      if (batch.length === 0) continue;
      await this.db
        .insert(chunkEmbeddings)
        .values(batch.map((point) => ({ chunkId: point.id, embedding: point.vector })))
        .onConflictDoUpdate({
          target: chunkEmbeddings.chunkId,
          set: { embedding: sql`excluded.embedding` },
        });
    }
  }
}

/** In-memory store for tests. */
export class MemoryVectorStore implements VectorStore {
  readonly points = new Map<string, number[]>();

  async upsert(points: VectorPoint[]): Promise<void> {
    for (const point of points) {
      this.points.set(point.id, point.vector);
    }
  }
}
