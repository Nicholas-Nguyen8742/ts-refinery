import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultMetadataRules,
  extractMetadata,
  validateMetadata,
  type MetadataRule,
} from '../index';

describe('extractMetadata', () => {
  it('uses capture group 1 when present, else the full match', () => {
    const rules: MetadataRule[] = [
      { key: 'invoice', pattern: /Invoice\s*#\s*([A-Z0-9-]+)/i },
      { key: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    ];

    const metadata = extractMetadata(
      'Please pay Invoice #INV-2024-001; questions to finance@example.com.',
      rules,
    );
    expect(metadata).toEqual({
      invoice: 'INV-2024-001',
      email: 'finance@example.com',
    });
  });

  it('returns only matched keys', () => {
    expect(extractMetadata('nothing here', defaultMetadataRules)).toEqual({});
  });

  it('applies the first match only', () => {
    const metadata = extractMetadata('a@one.com b@two.com', defaultMetadataRules);
    expect(metadata.email).toBe('a@one.com');
  });

  it('is safe to reuse stateful (global-flag) regexes across calls', () => {
    const rules: MetadataRule[] = [{ key: 'date', pattern: /\b(\d{4}-\d{2}-\d{2})\b/g }];
    const content = 'signed 2024-05-01';
    expect(extractMetadata(content, rules)).toEqual({ date: '2024-05-01' });
    // Second call would skip the match if lastIndex were not reset.
    expect(extractMetadata(content, rules)).toEqual({ date: '2024-05-01' });
  });
});

describe('validateMetadata', () => {
  const schema = z.object({ email: z.string().min(5), title: z.string().optional() });

  it('passes valid metadata through', () => {
    const result = validateMetadata(schema, { email: 'a@b.com' });
    expect(result).toEqual({ success: true, data: { email: 'a@b.com' } });
  });

  it('reports readable issues for invalid metadata', () => {
    const result = validateMetadata(schema, { email: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toContain('email');
    }
  });
});
