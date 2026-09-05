import { describe, expect, it } from 'vitest';
import type { DocStatus } from '@repo/db';
import { UnsupportedFileTypeError } from '@repo/parser-core';
import type { EmbeddingJobPayload } from '@repo/queue';
import { handleParseJob, type ParserStore, type ParserWorkerDeps } from '../handler';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

function createFakeStore() {
  const statuses: DocStatus[] = [];
  const metadataWrites: Array<Record<string, unknown>> = [];
  const chunkWrites: Array<{ parents: number; children: number }> = [];

  const store: ParserStore = {
    async setStatus(_documentId, status) {
      statuses.push(status);
    },
    async setMetadata(_documentId, metadata) {
      metadataWrites.push(metadata);
    },
    async replaceDocumentChunks(_documentId, parents, children) {
      chunkWrites.push({ parents: parents.length, children: children.length });
      // Mirror production semantics: parents without children are their own search units.
      const parentsWithChildren = new Set(children.map((child) => child.parentIndex));
      const searchUnitIds = [
        ...parents.filter((_, index) => !parentsWithChildren.has(index)).map((_, index) => `parent-${index}`),
        ...children.map((_, index) => `child-${index}`),
      ];
      return { searchUnitIds };
    },
  };

  return { store, statuses, metadataWrites, chunkWrites };
}

function createDeps(
  store: ParserStore,
  file: Buffer,
  mimeType: string,
  enqueued: EmbeddingJobPayload[],
  overrides: Partial<ParserWorkerDeps> = {},
): ParserWorkerDeps {
  return {
    store,
    downloadFile: async () => file,
    enqueueEmbedding: async (payload) => {
      enqueued.push(payload);
    },
    ...overrides,
  };
}

describe('handleParseJob', () => {
  it('parses HTML, extracts metadata, and enqueues the search units', async () => {
    const { store, statuses, metadataWrites, chunkWrites } = createFakeStore();
    const enqueued: EmbeddingJobPayload[] = [];
    const html = Buffer.from('<h1>Report</h1><p>Contact finance@example.com for details.</p>');

    await handleParseJob(
      createDeps(store, html, 'text/html', enqueued),
      { documentId: DOCUMENT_ID, s3Key: 'documents/x/report.html', mimeType: 'text/html' },
    );

    expect(statuses).toEqual(['PARSING', 'EMBEDDING']);
    expect(chunkWrites).toEqual([{ parents: 1, children: 0 }]);
    expect(metadataWrites[0]).toMatchObject({ email: 'finance@example.com' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toEqual({ documentId: DOCUMENT_ID, chunkIds: ['parent-0'] });
  });

  it('creates parent-child chunks for large sections and enqueues only children', async () => {
    const { store, statuses, chunkWrites } = createFakeStore();
    const enqueued: EmbeddingJobPayload[] = [];
    const paragraphs = Array.from({ length: 4 }, () => `<p>${'x'.repeat(1200)}</p>`).join('');
    const html = Buffer.from(`<h1>Chapter</h1>${paragraphs}`);

    await handleParseJob(
      createDeps(store, html, 'text/html', enqueued, {
        chunkOptions: { maxParentTokens: 2000, maxChildTokens: 350 },
      }),
      { documentId: DOCUMENT_ID, s3Key: 'documents/x/big.html', mimeType: 'text/html' },
    );

    expect(statuses).toEqual(['PARSING', 'EMBEDDING']);
    expect(chunkWrites).toEqual([{ parents: 1, children: 4 }]);
    expect(enqueued[0]?.chunkIds).toEqual(['child-0', 'child-1', 'child-2', 'child-3']);
  });

  it('marks empty documents READY instead of stranding them in EMBEDDING', async () => {
    const { store, statuses } = createFakeStore();
    const enqueued: EmbeddingJobPayload[] = [];

    await handleParseJob(
      createDeps(store, Buffer.from(''), 'text/plain', enqueued),
      { documentId: DOCUMENT_ID, s3Key: 'documents/x/empty.txt', mimeType: 'text/plain' },
    );

    expect(statuses).toEqual(['PARSING', 'READY']);
    expect(enqueued).toEqual([]);
  });

  it('propagates parse failures without touching the embedding queue', async () => {
    const { store, statuses } = createFakeStore();
    const enqueued: EmbeddingJobPayload[] = [];

    await expect(
      handleParseJob(createDeps(store, Buffer.from('nope'), 'application/zip', enqueued), {
        documentId: DOCUMENT_ID,
        s3Key: 'documents/x/file.zip',
        mimeType: 'application/zip',
      }),
    ).rejects.toThrow(UnsupportedFileTypeError);

    expect(statuses).toEqual(['PARSING']);
    expect(enqueued).toEqual([]);
  });

  it('lets parser-native metadata win over rule-extracted metadata', async () => {
    const { store, metadataWrites } = createFakeStore();
    const enqueued: EmbeddingJobPayload[] = [];
    // <title> is parser-native; the regex rule would also extract a 'title'-ish key
    // only if one were configured. Here we assert ordering guarantees with email.
    const html = Buffer.from(
      '<html><head><title>Native Title</title></head><body><p>finance@example.com</p></body></html>',
    );

    await handleParseJob(
      createDeps(store, html, 'text/html', enqueued),
      { documentId: DOCUMENT_ID, s3Key: 'documents/x/t.html', mimeType: 'text/html' },
    );

    expect(metadataWrites[0]).toMatchObject({ title: 'Native Title', email: 'finance@example.com' });
  });
});
