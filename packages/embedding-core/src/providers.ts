export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Returns one vector per input string, in input order. */
  embed(input: string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface OpenAiEmbeddingOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  /** Inputs per HTTP request. Well under OpenAI's 2048-input cap by default. */
  batchSize?: number;
  baseUrl?: string;
}

/**
 * Minimal fetch-based OpenAI embeddings client. Deliberately no SDK
 * dependency — the embeddings endpoint is a single POST.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly baseUrl: string;

  constructor(options: OpenAiEmbeddingOptions) {
    this.name = options.model ?? 'text-embedding-3-small';
    this.dimensions = options.dimensions ?? 1536;
    this.apiKey = options.apiKey;
    this.batchSize = options.batchSize ?? 256;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];

    const vectors: number[][] = [];
    for (let start = 0; start < input.length; start += this.batchSize) {
      const batch = input.slice(start, start + this.batchSize);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.name, input: batch }),
      });

      if (!response.ok) {
        throw new EmbeddingError(
          `Embedding request failed (${response.status}): ${await safeReadBody(response)}`,
          response.status,
        );
      }

      const payload = (await response.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
      };
      const ordered = [...payload.data]
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.embedding);

      if (ordered.length !== batch.length) {
        throw new EmbeddingError(`Expected ${batch.length} embeddings, received ${ordered.length}`);
      }
      vectors.push(...ordered);
    }

    return vectors;
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable response body>';
  }
}

/**
 * Deterministic hash-based provider for tests and local development without
 * API keys. Vectors are stable across runs but carry no semantic meaning.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake-embedding';

  constructor(readonly dimensions: number = 8) {}

  async embed(input: string[]): Promise<number[][]> {
    return input.map((text) => deterministicVector(text, this.dimensions));
  }
}

function deterministicVector(text: string, dimensions: number): number[] {
  // FNV-1a hash as the seed.
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  // LCG expansion into [-1, 1].
  const vector: number[] = [];
  let state = seed >>> 0;
  for (let i = 0; i < dimensions; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vector.push((state / 0xffffffff) * 2 - 1);
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
