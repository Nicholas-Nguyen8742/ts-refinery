import { serve } from '@hono/node-server';
import { createDb } from '@repo/db';
import { connectionFromUrl, createParsingQueue } from '@repo/queue';
import { createS3Client } from '@repo/storage';
import { createApp } from './app';
import { loadApiEnv } from './env';

const env = loadApiEnv();

const app = createApp({
  db: createDb(env.DATABASE_URL),
  s3: createS3Client({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  }),
  bucket: env.S3_BUCKET,
  parsingQueue: createParsingQueue(connectionFromUrl(env.REDIS_URL)),
  presignExpiresSeconds: env.PRESIGN_EXPIRES_SECONDS,
  maxUploadBytes: env.MAX_UPLOAD_BYTES,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[api] ts-refinery API listening on http://localhost:${info.port}`);
});
