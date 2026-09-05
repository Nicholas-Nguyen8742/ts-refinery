import { z } from 'zod';
import { DEFAULT_REDIS_URL, loadEnv } from '@repo/config';

export const embedderWorkerEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default(DEFAULT_REDIS_URL),
    // I/O-bound work: higher concurrency is safe and desirable.
    EMBEDDER_CONCURRENCY: z.coerce.number().int().positive().default(8),
    EMBEDDING_PROVIDER: z.enum(['openai', 'fake']).default('openai'),
    EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(256),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_BASE_URL: z.string().min(1).default('https://api.openai.com/v1'),
  })
  .superRefine((env, ctx) => {
    if (env.EMBEDDING_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai',
      });
    }
  });

export type EmbedderWorkerEnv = z.infer<typeof embedderWorkerEnvSchema>;

export function loadEmbedderWorkerEnv(): EmbedderWorkerEnv {
  return loadEnv(embedderWorkerEnvSchema);
}
