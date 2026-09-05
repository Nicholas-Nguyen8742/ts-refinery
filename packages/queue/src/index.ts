import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { z } from 'zod';

// Re-exported so consumers can type queue handles without depending on bullmq directly.
export type { Queue } from 'bullmq';

// Re-exported so consumers can type queue handles without depending on bullmq directly.
export type { Queue } from 'bullmq';

export const QUEUE_NAMES = {
  parsing: 'parsing-queue',
  embedding: 'embedding-queue',
} as const;

// Deliberately not z.string().uuid(): keeps this contract stable across Zod majors.
const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'must be a UUID',
  );

/** Payload for jobs on the parsing queue (API -> parser worker). */
export const parseJobPayloadSchema = z.object({
  documentId: uuidSchema,
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
});

/** Payload for jobs on the embedding queue (parser worker -> embedder worker). */
export const embeddingJobPayloadSchema = z.object({
  documentId: uuidSchema,
  chunkIds: z.array(uuidSchema).min(1),
});

export type ParseJobPayload = z.infer<typeof parseJobPayloadSchema>;
export type EmbeddingJobPayload = z.infer<typeof embeddingJobPayloadSchema>;

/**
 * Shared retry/cleanup policy. Parsing and embedding are idempotent (re-runs
 * replace chunks and upsert vectors), so automatic retries are safe.
 */
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 3000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export function connectionFromUrl(url: string): ConnectionOptions {
  // BullMQ requires an unbounded retry policy on its blocking connections so a
  // Redis restart degrades into a pause instead of a dead worker.
  return { url, maxRetriesPerRequest: null };
}

export function createParsingQueue(connection: ConnectionOptions): Queue<ParseJobPayload> {
  return new Queue<ParseJobPayload>(QUEUE_NAMES.parsing, { connection, defaultJobOptions });
}

export function createEmbeddingQueue(connection: ConnectionOptions): Queue<EmbeddingJobPayload> {
  return new Queue<EmbeddingJobPayload>(QUEUE_NAMES.embedding, { connection, defaultJobOptions });
}
