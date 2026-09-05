// Import the library entry directly; the package root index runs a debug CLI
// snippet that does not belong inside a worker process.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { ParsedDocument } from './index';

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator'] as const;
const XMP_KEYS = ['Title', 'Author', 'CreationDate', 'ModDate'] as const;

/**
 * Extract text from a PDF buffer.
 *
 * Honesty note: pdf-parse yields a flat text stream. Heading reconstruction
 * from PDFs is a heuristic at best, so structure-aware chunking downstream
 * operates on whatever markdown structure exists. Scanned (image-only) PDFs
 * produce empty text and will yield zero chunks — OCR is out of scope for v1
 * and the pipeline surfaces that as an empty, READY document.
 */
export async function extractPdf(buffer: Buffer): Promise<ParsedDocument> {
  const result = await pdfParse(buffer);
  const metadata: Record<string, string> = {};

  const info = (result.info ?? {}) as Record<string, unknown>;
  for (const key of INFO_KEYS) {
    const value = info[key];
    if (typeof value === 'string' && value.trim()) {
      metadata[key.toLowerCase()] = value.trim();
    }
  }

  // pdf.js exposes XMP metadata behind a `.get(name)` accessor.
  const xmp = result.metadata as { get?: (name: string) => unknown } | null;
  if (xmp && typeof xmp.get === 'function') {
    for (const key of XMP_KEYS) {
      try {
        const value = await xmp.get(key);
        if (typeof value === 'string' && value.trim() && !metadata[key.toLowerCase()]) {
          metadata[key.toLowerCase()] = value.trim();
        }
      } catch {
        // metadata is best-effort; never fail a parse over it
      }
    }
  }

  return { markdown: result.text, extractedMetadata: metadata };
}
