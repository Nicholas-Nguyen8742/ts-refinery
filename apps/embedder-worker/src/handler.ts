import type { DocStatus } from '@repo/db';
import type { EmbeddingProvider } from '@repo/embedding-core';
import type { EmbeddingJobPayload } from '@repo/queue';

export interface SearchUnit {
  id: string;
  content: string;
  headerPath: string[];
}

/** Persistence boundary of the embedder worker; faked in tests. */
export interface EmbedderStore {
  fetchSearchUnits(ids: string[]): Promise<SearchUnit[]>;
  upsertEmbeddings(rows: Array<{ chunkId: string; vector: number[] }>): Promise<void>;
  markEmbedded(chunkIds: string[]): Promise<void>;
  setStatus(documentId: string, status: DocStatus): Promise<void>;
}

export interface EmbedderWorkerDeps {
  store: EmbedderStore;
  provider: EmbeddingProvider;
}

/**
 * Prefix chunk text with its header breadcrumb before embedding so the vector
 * captures structural context ("Section 4 > Lease Agreements"), not just body text.
 */
export function buildEmbeddingInput(unit: SearchUnit): string {
  return unit.headerPath.length > 0
    ? `${unit.headerPath.join(' > ')}\n\n${unit.content}`
    : unit.content;
}

export async function handleEmbeddingJob(
  deps: EmbedderWorkerDeps,
  payload: EmbeddingJobPayload,
): Promise<void> {
  const units = await deps.store.fetchSearchUnits(payload.chunkIds);
  if (units.length === 0) {
    // Chunks may have vanished (document deleted/re-parsed) — treat as done.
    await deps.store.setStatus(payload.documentId, 'READY');
    return;
  }

  const vectors = await deps.provider.embed(units.map(buildEmbeddingInput));
  if (vectors.length !== units.length) {
    throw new Error(`Provider returned ${vectors.length} vectors for ${units.length} chunks`);
  }

  await deps.store.upsertEmbeddings(
    units.map((unit, index) => ({ chunkId: unit.id, vector: vectors[index] as number[] })),
  );
  await deps.store.markEmbedded(units.map((unit) => unit.id));
  await deps.store.setStatus(payload.documentId, 'READY');
}
