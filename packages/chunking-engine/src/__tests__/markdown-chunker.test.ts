import { describe, expect, it } from 'vitest';
import {
  chunkByStructure,
  DEFAULT_MAX_PARENT_TOKENS,
  estimateTokens,
  refineMarkdown,
} from '../index';

/** Paragraph filler of exactly `tokens` estimated tokens (4 chars/token). */
function para(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up at ~4 chars per token', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});

describe('refineMarkdown: sections and header paths', () => {
  it('returns no chunks for an empty document', () => {
    expect(refineMarkdown('')).toEqual({ parents: [], children: [] });
    expect(refineMarkdown('   \n\n  ')).toEqual({ parents: [], children: [] });
  });

  it('returns no chunks for a header-only document', () => {
    const refined = refineMarkdown('# Title\n\n## Also Empty\n');
    expect(refined.parents).toEqual([]);
    expect(refined.children).toEqual([]);
  });

  it('tracks nested header paths and resets on a new top-level header', () => {
    const md = [
      '# A', '', 'text a', '',
      '## B', '', 'text b', '',
      '### C', '', 'text c', '',
      '# D', '', 'text d',
    ].join('\n');

    const refined = refineMarkdown(md);
    expect(refined.parents.map((parent) => parent.headerPath)).toEqual([
      ['A'],
      ['A', 'B'],
      ['A', 'B', 'C'],
      ['D'],
    ]);
    expect(refined.parents[0]?.content).toBe('# A\n\ntext a');
    expect(refined.parents[3]?.content).toBe('# D\n\ntext d');
  });

  it('handles header level jumps (# then ###)', () => {
    const refined = refineMarkdown('# Top\n\nbody\n\n### Deep\n\nmore');
    expect(refined.parents.map((parent) => parent.headerPath)).toEqual([
      ['Top'],
      ['Top', 'Deep'],
    ]);
  });

  it('assigns an empty header path to content before any header', () => {
    const refined = refineMarkdown('preamble text\n\n# Later\n\nbody');
    expect(refined.parents[0]?.headerPath).toEqual([]);
    expect(refined.parents[0]?.content).toBe('preamble text');
    expect(refined.parents[1]?.headerPath).toEqual(['Later']);
  });
});

describe('refineMarkdown: size limits and semantic boundaries', () => {
  it('splits an oversized section by paragraphs, never mid-paragraph', () => {
    // Distinct paragraphs so occurrence counting is meaningful.
    const paragraphs = [0, 1, 2].map((index) => `p${index}:${para(600)}`);
    const md = `# Report\n\n${paragraphs.join('\n\n')}`;

    const refined = refineMarkdown(md, {
      maxParentTokens: 1000,
      maxChildTokens: Number.POSITIVE_INFINITY,
    });

    expect(refined.parents.length).toBe(3);
    for (const parent of refined.parents) {
      expect(parent.tokenCount).toBeLessThanOrEqual(1010); // 1000 + header line on part 1
      expect(parent.headerPath).toEqual(['Report']);
    }
    // Every original paragraph appears exactly once, whole.
    const combined = refined.parents.map((parent) => parent.content).join('\n\n');
    for (const paragraph of paragraphs) {
      expect(combined).toContain(paragraph);
      expect(combined.split(paragraph)).toHaveLength(2);
    }
    // The section header is preserved inside the first part only.
    expect(refined.parents[0]?.content.startsWith('# Report')).toBe(true);
    expect(refined.parents[1]?.content.startsWith('# Report')).toBe(false);
  });

  it('keeps markdown tables atomic', () => {
    const table = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    const md = `# Data\n\nIntro text\n\n${table}`;

    const refined = refineMarkdown(md, {
      maxParentTokens: 10,
      maxChildTokens: Number.POSITIVE_INFINITY,
    });

    const tableParent = refined.parents.find((parent) => parent.content.includes('| a | b |'));
    expect(tableParent).toBeDefined();
    expect(tableParent?.content).toContain(table); // never split row-wise
    expect(refined.parents.some((parent) => parent.content.includes('| 1 | 2 |') && !parent.content.includes('| a | b |'))).toBe(false);
  });

  it('keeps fenced code blocks atomic, including blank lines inside them', () => {
    const md = '# Guide\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n';

    const refined = refineMarkdown(md, {
      maxParentTokens: 5,
      maxChildTokens: Number.POSITIVE_INFINITY,
    });

    expect(refined.parents).toHaveLength(1);
    expect(refined.parents[0]?.content).toContain('```ts\nconst a = 1;\n\nconst b = 2;\n```');
  });
});

describe('refineMarkdown: parent-child hierarchy', () => {
  const md = `# Chapter\n\n${[para(300), para(300), para(300), para(300)].join('\n\n')}`;

  it('emits children for parents larger than maxChildTokens', () => {
    const refined = refineMarkdown(md, { maxParentTokens: 2000, maxChildTokens: 350 });

    expect(refined.parents).toHaveLength(1);
    expect(refined.children).toHaveLength(4);
    for (const child of refined.children) {
      expect(child.parentIndex).toBe(0);
      expect(child.headerPath).toEqual(['Chapter']);
      expect(child.tokenCount).toBeLessThanOrEqual(350);
    }
    const combined = refined.children.map((child) => child.content).join('\n\n');
    expect(combined).toContain(para(300));
  });

  it('lets a small parent double as its own search unit (no duplicated children)', () => {
    const refined = refineMarkdown('# A\n\nshort text');
    expect(refined.parents).toHaveLength(1);
    expect(refined.children).toHaveLength(0);
  });

  it('assigns child.parentIndex per parent part when a section is split', () => {
    const refined = refineMarkdown(md, { maxParentTokens: 700, maxChildTokens: 350 });
    // 4x300-token paragraphs -> parents [300,300] [300,300]
    expect(refined.parents).toHaveLength(2);
    const indexes = new Set(refined.children.map((child) => child.parentIndex));
    expect(indexes).toEqual(new Set([0, 1]));
    for (const child of refined.children) {
      expect(child.parentIndex).toBeLessThan(refined.parents.length);
    }
  });
});

describe('chunkByStructure (TRD flat API)', () => {
  it('returns structure-aware chunks capped at maxTokens with no child layer', () => {
    const md = `# Chapter\n\n${[para(300), para(300), para(300), para(300)].join('\n\n')}`;

    const flat = chunkByStructure(md);
    expect(flat.length).toBeGreaterThan(0);
    for (const chunk of flat) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_MAX_PARENT_TOKENS + 16);
      expect(chunk.headerPath).toEqual(['Chapter']);
    }
    expect(chunkByStructure('')).toEqual([]);
  });
});
