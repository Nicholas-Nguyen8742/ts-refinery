import { z } from 'zod';
import { booleanFlag, DEFAULT_REDIS_URL, loadEnv } from '@repo/config';

export const parserWorkerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default(DEFAULT_REDIS_URL),
  // CPU-bound work: keep concurrency low so parsing cannot starve the host.
  PARSER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MAX_PARENT_TOKENS: z.coerce.number().int().positive().default(1000),
  MAX_CHILD_TOKENS: z.coerce.number().int().positive().default(250),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFlag.default('true'),
});

export type ParserWorkerEnv = z.infer<typeof parserWorkerEnvSchema>;

export function loadParserWorkerEnv(): ParserWorkerEnv {
  return loadEnv(parserWorkerEnvSchema);
}
