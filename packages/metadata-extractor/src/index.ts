import { z } from 'zod';

export interface MetadataRule {
  key: string;
  /** First match wins. Capture group 1 (if present) becomes the value, else the full match. */
  pattern: RegExp;
}

/**
 * Rule-based metadata extraction over parsed Markdown.
 * Deterministic and free — run this in the CPU-bound parser worker, not
 * against an LLM. (An LLM-based extractor can be layered on later behind the
 * same MetadataRule/Record<string, string> contract.)
 */
export function extractMetadata(content: string, rules: MetadataRule[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const rule of rules) {
    // Reset lastIndex so stateful (g/y-flagged) regexes are reusable across documents.
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(content);
    if (!match) continue;
    const value = (match[1] ?? match[0]).trim();
    if (value) metadata[rule.key] = value;
  }
  return metadata;
}

export type MetadataValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: string[] };

/** Validate extracted metadata against a Zod contract before persisting. */
export function validateMetadata<T>(
  schema: z.ZodType<T>,
  data: unknown,
): MetadataValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}

/** Sensible defaults applied to every document during parsing. */
export const defaultMetadataRules: MetadataRule[] = [
  { key: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { key: 'documentDate', pattern: /\b(\d{4}-\d{2}-\d{2})\b/ },
  { key: 'invoiceNumber', pattern: /\bInvoice\s*(?:No\.?|#)\s*([A-Z0-9-]+)\b/i },
];
