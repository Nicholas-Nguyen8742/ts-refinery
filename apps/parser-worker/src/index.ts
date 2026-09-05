import { Worker } from 'bullmq';
import { createDb } from '@repo/db';
import {
  connectionFromUrl,
  createEmbeddingQueue,
  parseJobPayloadSchema,
  QUEUE_NAMES,
} from '@repo/queue';
import { createS3Client, getObjectBuffer } from '@repo/storage';
import { loadParserWorkerEnv } from './env';
import { handleParseJob, type ParserWorkerDeps } from './handler';
import { createDrizzleParserStore } from './store';

const env = loadParserWorkerEnv();

const db = createDb(env.DATABASE_URL);
const store = createDrizzleParserStore(db);
const s3 = createS3Client({
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});
const embeddingQueue = createEmbeddingQueue(connectionFromUrl(env.REDIS_URL));
const redisConnection = connectionFromUrl(env.REDIS_URL);

const deps: ParserWorkerDeps = {
  store,
  downloadFile: (s3Key) => getObjectBuffer(s3, env.S3_BUCKET, s3Key),
  // Correct inter-queue handoff: jobs are added through the BullMQ Queue API,
  // never via raw Redis commands.
  enqueueEmbedding: (payload) => embeddingQueue.add('embed-chunks', payload),
};

const worker = new Worker(
  QUEUE_NAMES.parsing,
  async (job) => {
    const payload = parseJobPayloadSchema.parse(job.data);
    await handleParseJob(deps, payload);
  },
  { connection: redisConnection, concurrency: env.PARSER_CONCURRENCY },
);

worker.on('completed', (job) => {
  console.log(`[parser-worker] job ${job.id} completed`);
});

// FAILED only after the final attempt — a retrying job stays PARSING, which
// is the truthful state.
worker.on('failed', async (job, error) => {
  console.error(`[parser-worker] job ${job?.id} failed: ${error.message}`);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    const parsed = parseJobPayloadSchema.safeParse(job.data);
    if (parsed.success) {
      await store.setStatus(parsed.data.documentId, 'FAILED').catch(() => undefined);
    }
  }
});

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(
  `[parser-worker] listening on queue "${QUEUE_NAMES.parsing}" (concurrency=${env.PARSER_CONCURRENCY})`,
);
