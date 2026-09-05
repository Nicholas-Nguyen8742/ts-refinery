import { describe, expect, it } from 'vitest';
import type { DocStatus } from '@repo/db';
import { FakeEmbeddingProvider, type EmbeddingProvider } from '@repo/embedding-core';
import {
  buildEmbeddingInput,
  handleEmbeddingJob,
  type EmbedderStore,
  type SearchUnit,
} from '../handler';

const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const CHUNK_A = '33333333-3333-4333-8333-333333333333';
const CHUNK_B = '44444444-4444-4444-8444-444444444444';

function createFakeStore(units: SearchUnit[]) {
  const upserts: Array<{ chunkId: string; vector: number[] }> = [];
  const marked: string[][] = [];
  const statuses: DocStatus[] = [];

  const store: EmbedderStore = {
    async fetchSearchUnits(ids) {
      return units.filter((unit) => ids.includes(unit.id));
    },
    async upsertEmbeddings(rows) {
      upserts.push(...rows);
    },
    async markEmbedded(chunkIds) {
      marked.push(chunkIds);
    },
    async setStatus(_documentId, status) {
      statuses.push(status);
    },
  };

  return { store, upserts, marked, statuses };
}

const UNITS: SearchUnit[] = [
  { id: CHUNK_A, content: 'lease terms body', headerPath: ['Annual Report', 'Leases'] },
  { id: CHUNK_B, content: 'no structure here', headerPath: [] },
];

describe('buildEmbeddingInput', () => {
  it('prefixes the header breadcrumb when present', () => {
    expect(buildEmbeddingInput(UNITS[0] as SearchUnit)).toBe(
      'Annual Report > Leases\n\nlease terms body',
    );
    expect(buildEmbeddingInput(UNITS[1] as SearchUnit)).toBe('no structure here');
  });
});

describe('handleEmbeddingJob', () => {
  it('embeds search units in order, upserts, marks, and flips status to READY', async () => {
    const { store, upserts, marked, statuses } = createFakeStore(UNITS);
    const provider = new FakeEmbeddingProvider(4);

    await handleEmbeddingJob(
      { store, provider },
      { documentId: DOCUMENT_ID, chunkIds: [CHUNK_A, CHUNK_B] },
    );

    expect(upserts.map((row) => row.chunkId)).toEqual([CHUNK_A, CHUNK_B]);
    for (const row of upserts) expect(row.vector).toHaveLength(4);
    expect(marked).toEqual([[CHUNK_A, CHUNK_B]]);
    expect(statuses).toEqual(['READY']);

    // Vectors correspond to the breadcrumb-prefixed inputs, in unit order.
    const expected = await provider.embed(UNITS.map(buildEmbeddingInput));
    expect(upserts.map((row) => row.vector)).toEqual(expected);
  });

  it('marks the document READY when all chunks vanished (deleted/re-parsed)', async () => {
    const { store, upserts, statuses } = createFakeStore([]);

    await handleEmbeddingJob(
      { store, provider: new FakeEmbeddingProvider(4) },
      { documentId: DOCUMENT_ID, chunkIds: [CHUNK_A] },
    );

    expect(upserts).toEqual([]);
    expect(statuses).toEqual(['READY']);
  });

  it('fails loudly if the provider returns the wrong number of vectors', async () => {
    const { store } = createFakeStore(UNITS);
    const brokenProvider: EmbeddingProvider = {
      name: 'broken',
      dimensions: 4,
      async embed() {
        return [[0, 0, 0, 0]]; // one vector for two inputs
      },
    };

    await expect(
      handleEmbeddingJob({ store, provider: brokenProvider }, { documentId: DOCUMENT_ID, chunkIds: [CHUNK_A, CHUNK_B] }),
    ).rejects.toThrow('returned 1 vectors for 2 chunks');
  });
});
