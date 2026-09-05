export interface SimplePdfOptions {
  /** Text drawn on the single page (WinAnsi/ASCII subset only). */
  text: string;
  /** Optional document title recorded in the info dictionary. */
  title?: string;
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a byte-exact minimal PDF (correct xref offsets) so parser tests can
 * exercise pdf-parse without committing binary fixtures.
 */
export function buildSimplePdf(options: SimplePdfOptions): Buffer {
  const contentStream = `BT /F1 12 Tf 72 720 Td (${escapePdfString(options.text)}) Tj ET`;

  const objects: string[] = ['', // 1-based indexing; slot 0 unused
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (options.title !== undefined) {
    objects.push(`<< /Title (${escapePdfString(options.title)}) >>`);
  }

  const infoObjectNumber = options.title !== undefined ? objects.length - 1 : 0;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xrefOffset = body.length;
  const size = objects.length; // entries 0..(size-1)
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n += 1) {
    body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }

  const infoRef = infoObjectNumber > 0 ? ` /Info ${infoObjectNumber} 0 R` : '';
  body += `trailer\n<< /Size ${size} /Root 1 0 R${infoRef} >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(body, 'latin1');
}
