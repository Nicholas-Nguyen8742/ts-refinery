import { Worker } from 'bullmq';
import { createDb } from '@repo/db';
import {
  connectionFromUrl,
  embeddingJobPayloadSchema,
  QUEUE_NAMES,
} from '@repo/queue';
import {
  FakeEmbeddingProvider,
  OpenAiEmbeddingProvider,
  type EmbeddingProvider,
} from '@repo/embedding-core';
import { loadEmbedderWorkerEnv } from './env';
import { handleEmbeddingJob, type EmbedderWorkerDeps } from './handler';
import { createDrizzleEmbedderStore } from './store';

const env = loadEmbedderWorkerEnv();

const provider: EmbeddingProvider =
  env.EMBEDDING_PROVIDER === 'fake'
    ? new FakeEmbeddingProvider(env.EMBEDDING_DIMENSIONS)
    : new OpenAiEmbeddingProvider({
        apiKey: env.OPENAI_API_KEY as string, // validated by the env schema
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIMENSIONS,
        batchSize: env.EMBEDDING_BATCH_SIZE,
        baseUrl: env.OPENAI_BASE_URL,
      });

const deps: EmbedderWorkerDeps = {
  store: createDrizzleEmbedderStore(createDb(env.DATABASE_URL)),
  provider,
};

const worker = new Worker(
  QUEUE_NAMES.embedding,
  async (job) => {
    const payload = embeddingJobPayloadSchema.parse(job.data);
    await handleEmbeddingJob(deps, payload);
  },
  { connection: connectionFromUrl(env.REDIS_URL), concurrency: env.EMBEDDER_CONCURRENCY },
);

worker.on('completed', (job) => {
  console.log(`[embedder-worker] job ${job.id} completed`);
});

worker.on('failed', (job, error) => {
  console.error(`[embedder-worker] job ${job?.id} failed: ${error.message}`);
});

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(
  `[embedder-worker] listening on queue "${QUEUE_NAMES.embedding}" (provider=${env.EMBEDDING_PROVIDER}, concurrency=${env.EMBEDDER_CONCURRENCY})`,
);
