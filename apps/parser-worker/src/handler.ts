import { refineMarkdown, type ChildChunk, type ChunkOptions, type ParentChunk } from '@repo/chunking-engine';
import type { DocStatus } from '@repo/db';
import {
  defaultMetadataRules,
  extractMetadata,
  type MetadataRule,
} from '@repo/metadata-extractor';
import { parseFile } from '@repo/parser-core';
import type { EmbeddingJobPayload, ParseJobPayload } from '@repo/queue';

/**
 * Persistence boundary of the parser worker. Narrow enough to fake in tests
 * without Postgres; implemented on top of Drizzle in ./store.
 */
export interface ParserStore {
  setStatus(documentId: string, status: DocStatus): Promise<void>;
  setMetadata(documentId: string, metadata: Record<string, unknown>): Promise<void>;
  /**
   * Idempotently replace all chunks of a document. Returns the IDs that must
   * be embedded: children where they exist, otherwise the parent itself.
   */
  replaceDocumentChunks(
    documentId: string,
    parents: ParentChunk[],
    children: ChildChunk[],
  ): Promise<{ searchUnitIds: string[] }>;
}

export interface ParserWorkerDeps {
  store: ParserStore;
  downloadFile(s3Key: string): Promise<Buffer>;
  enqueueEmbedding(payload: EmbeddingJobPayload): Promise<void>;
  chunkOptions?: ChunkOptions;
  metadataRules?: MetadataRule[];
}

/**
 * Pure orchestration of one parse job. No BullMQ, S3, or Postgres imports —
 * the wiring lives in ./index so this stays unit-testable.
 */
export async function handleParseJob(
  deps: ParserWorkerDeps,
  payload: ParseJobPayload,
): Promise<void> {
  const { documentId, s3Key, mimeType } = payload;

  await deps.store.setStatus(documentId, 'PARSING');

  const file = await deps.downloadFile(s3Key);
  const { markdown, extractedMetadata } = await parseFile(file, mimeType);

  // Rule-based metadata first; parser-native metadata (PDF info dict, HTML
  // <title>) wins on conflicts because it is structurally authoritative.
  const metadata: Record<string, unknown> = {
    ...extractMetadata(markdown, deps.metadataRules ?? defaultMetadataRules),
    ...extractedMetadata,
  };
  if (Object.keys(metadata).length > 0) {
    await deps.store.setMetadata(documentId, metadata);
  }

  const refined = refineMarkdown(markdown, deps.chunkOptions);
  const { searchUnitIds } = await deps.store.replaceDocumentChunks(
    documentId,
    refined.parents,
    refined.children,
  );

  if (searchUnitIds.length > 0) {
    await deps.enqueueEmbedding({ documentId, chunkIds: searchUnitIds });
    await deps.store.setStatus(documentId, 'EMBEDDING');
  } else {
    // Empty/scanned documents produce nothing to embed — do not strand them in EMBEDDING.
    await deps.store.setStatus(documentId, 'READY');
  }
}
