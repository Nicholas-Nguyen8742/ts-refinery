import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { chunks, documents, type RefineryDb } from '@repo/db';
import { SUPPORTED_MIME_TYPES } from '@repo/parser-core';
import { parseJobPayloadSchema, type ParseJobPayload, type Queue } from '@repo/queue';
import { objectExists, presignPutObject, type S3Client } from '@repo/storage';

export interface ApiDeps {
  db: RefineryDb;
  s3: S3Client;
  bucket: string;
  parsingQueue: Queue<ParseJobPayload>;
  presignExpiresSeconds: number;
  maxUploadBytes: number;
}

const createDocumentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum([...SUPPORTED_MIME_TYPES]),
  sizeBytes: z.number().int().positive(),
});

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', service: 'ts-refinery-api' }));

  /**
   * Step 1 of the upload flow: register the document and hand back a
   * presigned PUT URL. The file bytes never flow through this process.
   */
  app.post('/documents', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = createDocumentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid request',
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
        400,
      );
    }

    const { fileName, mimeType, sizeBytes } = parsed.data;
    if (sizeBytes > deps.maxUploadBytes) {
      return c.json(
        { error: `File exceeds maximum upload size of ${deps.maxUploadBytes} bytes` },
        413,
      );
    }

    const documentId = crypto.randomUUID();
    const s3Key = `documents/${documentId}/${sanitizeFileName(fileName)}`;
    await deps.db.insert(documents).values({
      id: documentId,
      fileName,
      mimeType,
      s3Key,
      status: 'PENDING',
    });

    const uploadUrl = await presignPutObject(
      deps.s3,
      deps.bucket,
      s3Key,
      mimeType,
      deps.presignExpiresSeconds,
    );

    return c.json(
      {
        documentId,
        s3Key,
        uploadUrl,
        expiresInSeconds: deps.presignExpiresSeconds,
      },
      201,
    );
  });

  /**
   * Step 4 of the upload flow: the client signals that the direct-to-S3
   * upload finished. We verify the object exists, then enqueue parsing.
   * No parsing happens inside the HTTP lifecycle.
   */
  app.post('/documents/:id/complete', async (c) => {
    const documentId = c.req.param('id');
    const rows = await deps.db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const document = rows[0];
    if (!document) return c.json({ error: 'Document not found' }, 404);
    if (document.status !== 'PENDING') {
      return c.json({ error: `Document is already in state ${document.status}` }, 409);
    }

    const exists = await objectExists(deps.s3, deps.bucket, document.s3Key);
    if (!exists) {
      return c.json({ error: 'Upload not found in storage; PUT the file to uploadUrl first' }, 422);
    }

    await deps.parsingQueue.add(
      'parse-document',
      parseJobPayloadSchema.parse({
        documentId: document.id,
        s3Key: document.s3Key,
        mimeType: document.mimeType,
      }),
    );

    return c.json({ documentId: document.id, status: 'QUEUED_FOR_PARSING' }, 202);
  });

  app.get('/documents/:id', async (c) => {
    const documentId = c.req.param('id');
    const rows = await deps.db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const document = rows[0];
    if (!document) return c.json({ error: 'Document not found' }, 404);

    // count() ignores NULLs, so counting parentId gives the child total.
    const [totals] = await deps.db
      .select({ total: count(), children: count(chunks.parentId) })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));

    const totalChunks = totals?.total ?? 0;
    const childChunks = totals?.children ?? 0;

    return c.json({
      ...document,
      chunkCounts: { total: totalChunks, parents: totalChunks - childChunks, children: childChunks },
    });
  });

  return app;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  return cleaned || 'file';
}
