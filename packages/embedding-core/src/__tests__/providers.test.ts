import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingError,
  FakeEmbeddingProvider,
  OpenAiEmbeddingProvider,
} from '../providers';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FakeEmbeddingProvider', () => {
  it('produces deterministic, unit-norm vectors of the configured dimension', async () => {
    const provider = new FakeEmbeddingProvider(16);
    const [a, b] = await provider.embed(['same text', 'same text']);
    const [c] = await provider.embed(['different text']);

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(16);

    const norm = Math.sqrt(a!.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 9);
  });

  it('returns [] for empty input', async () => {
    expect(await new FakeEmbeddingProvider(4).embed([])).toEqual([]);
  });
});

describe('OpenAiEmbeddingProvider', () => {
  it('batches inputs, sends auth header, and preserves input order', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        calls.push({ url: String(input), body, headers });
        const batch = body.input as string[];
        // Respond out of order to prove the provider re-sorts by index.
        const data = batch
          .map((_, index) => ({ index, embedding: [index, 0, 0] }))
          .reverse();
        return jsonResponse({ object: 'list', data });
      }),
    );

    const provider = new OpenAiEmbeddingProvider({ apiKey: 'test-key', batchSize: 2 });
    const vectors = await provider.embed(['a', 'b', 'c', 'd', 'e']);

    expect(vectors).toHaveLength(5);
    expect(vectors[0]).toEqual([0, 0, 0]); // order preserved despite reversed response
    expect(vectors[1]).toEqual([1, 0, 0]);
    expect(calls).toHaveLength(3); // batches of 2, 2, 1
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer test-key');
    expect(calls[0]?.body.model).toBe('text-embedding-3-small');
    expect(calls[2]?.body.input).toEqual(['e']);
  });

  it('respects a custom base URL', async () => {
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calledUrl = String(input);
        return jsonResponse({ data: [{ index: 0, embedding: [0] }] });
      }),
    );

    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'k',
      baseUrl: 'http://localhost:8080/v1/',
      model: 'nomic-embed-text',
    });
    await provider.embed(['hello']);
    expect(calledUrl).toBe('http://localhost:8080/v1/embeddings');
  });

  it('throws EmbeddingError with status on API failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );

    const provider = new OpenAiEmbeddingProvider({ apiKey: 'k' });
    const error = await provider.embed(['hello']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).status).toBe(429);
    expect((error as EmbeddingError).message).toContain('429');
  });

  it('returns [] for empty input without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new OpenAiEmbeddingProvider({ apiKey: 'k' }).embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
