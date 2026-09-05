import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, parseFile, UnsupportedFileTypeError } from '../index';
import { buildSimplePdf } from './fixtures/build-pdf';

describe('parseFile', () => {
  it('converts HTML to markdown and extracts native metadata', async () => {
    const html =
      '<html><head><title>Annual Report</title>' +
      '<meta name="author" content="Finance Dept">' +
      '</head><body><h1>Revenue</h1><p>Grew strongly.</p></body></html>';

    const result = await parseFile(Buffer.from(html), 'text/html');
    expect(result.markdown).toContain('# Revenue');
    expect(result.markdown).toContain('Grew strongly.');
    expect(result.extractedMetadata).toMatchObject({
      title: 'Annual Report',
      author: 'Finance Dept',
    });
  });

  it('passes markdown and plain text through untouched', async () => {
    const markdown = '# Doc\n\ntext\n';
    expect(await parseFile(Buffer.from(markdown), 'text/markdown')).toEqual({
      markdown,
      extractedMetadata: {},
    });
    expect(await parseFile(Buffer.from(markdown), 'text/plain')).toEqual({
      markdown,
      extractedMetadata: {},
    });
  });

  it('extracts text and info-dictionary metadata from a real minimal PDF', async () => {
    const pdf = buildSimplePdf({ text: 'Annual Report 2024', title: 'Hello PDF' });

    const result = await parseFile(pdf, 'application/pdf');
    expect(result.markdown).toContain('Annual Report 2024');
    expect(result.extractedMetadata.title).toBe('Hello PDF');
  });

  it('throws UnsupportedFileTypeError for unknown mime types', async () => {
    await expect(parseFile(Buffer.from('binary'), 'image/png')).rejects.toThrow(
      UnsupportedFileTypeError,
    );
    await expect(parseFile(Buffer.from('binary'), 'image/png')).rejects.toThrow(
      'Unsupported file type: image/png',
    );
  });
});

describe('htmlToMarkdown', () => {
  it('downgrades headings and tables', () => {
    const md = htmlToMarkdown('<h2>Section</h2><p>Body</p>');
    expect(md).toContain('## Section');
    expect(md).toContain('Body');
  });
});
