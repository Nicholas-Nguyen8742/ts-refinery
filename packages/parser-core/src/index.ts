import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { extractPdf } from './pdf-parser';

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/markdown',
  'text/plain',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export interface ParsedDocument {
  markdown: string;
  extractedMetadata: Record<string, string>;
}

export class UnsupportedFileTypeError extends Error {
  constructor(public readonly mimeType: string) {
    super(`Unsupported file type: ${mimeType}`);
    this.name = 'UnsupportedFileTypeError';
  }
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

/**
 * Strip the doctype and <head> before downgrading so <title>/<meta>/<script>
 * content never leaks into the markdown body.
 */
function stripHtmlHead(html: string): string {
  return html.replace(/<!doctype[^>]*>/i, '').replace(/<head\b[\s\S]*?<\/head>/i, '');
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(stripHtmlHead(html));
}

function extractHtmlMetadata(html: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (title) metadata.title = title;
  const author = /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.trim();
  if (author) metadata.author = author;
  return metadata;
}

/**
 * Compile a raw file buffer into the pipeline's intermediate representation:
 * structured Markdown plus best-effort native metadata.
 */
export async function parseFile(buffer: Buffer, mimeType: string): Promise<ParsedDocument> {
  switch (mimeType) {
    case 'application/pdf':
      return extractPdf(buffer);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      // mammoth removed convertToMarkdown long ago; the supported path is
      // DOCX -> semantic HTML -> Markdown via turndown.
      const result = await mammoth.convertToHtml({ buffer });
      return { markdown: htmlToMarkdown(result.value), extractedMetadata: {} };
    }

    case 'text/html': {
      const html = buffer.toString('utf-8');
      return { markdown: htmlToMarkdown(html), extractedMetadata: extractHtmlMetadata(html) };
    }

    case 'text/markdown':
    case 'text/plain':
      return { markdown: buffer.toString('utf-8'), extractedMetadata: {} };

    default:
      throw new UnsupportedFileTypeError(mimeType);
  }
}
