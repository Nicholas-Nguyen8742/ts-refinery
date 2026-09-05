/**
 * Structure-aware Markdown chunking with parent-child hierarchy.
 *
 * Philosophy:
 *  - Documents are split on semantic boundaries (headers, paragraphs, tables,
 *    code fences), never on raw character counts.
 *  - Parents are context-rich chunks fed to the LLM at retrieval time.
 *  - Children are small, highly specific chunks used for vector search.
 *  - A parent small enough to stand alone doubles as its own search unit, so
 *    we never embed duplicated content.
 */

export interface ChunkOptions {
  /** Max tokens for a parent (context) chunk. @default 1000 */
  maxParentTokens?: number;
  /** Max tokens for a child (search) chunk. @default 250 */
  maxChildTokens?: number;
}

export interface ChunkResult {
  content: string;
  headerPath: string[];
  tokenCount: number;
}

export interface ParentChunk extends ChunkResult {}

export interface ChildChunk extends ChunkResult {
  /** Index into `RefinedDocument.parents` of the owning parent chunk. */
  parentIndex: number;
}

export interface RefinedDocument {
  parents: ParentChunk[];
  children: ChildChunk[];
}

export const DEFAULT_MAX_PARENT_TOKENS = 1000;
export const DEFAULT_MAX_CHILD_TOKENS = 250;

const HEADER_PATTERN = /^(#{1,6})\s+(.*)$/;
const FENCE_PATTERN = /^\s*(```|~~~)/;

/**
 * Cheap tokenizer-free estimate (~4 chars/token). Swap in tiktoken here if
 * exact counts matter; nothing else in the pipeline assumes the heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

type BlockKind = 'paragraph' | 'code' | 'table';

interface Block {
  kind: BlockKind;
  text: string;
  tokens: number;
}

type Item =
  | { type: 'header'; level: number; text: string }
  | { type: 'block'; block: Block };

interface Section {
  headerPath: string[];
  /** The markdown header line that opened this section, if any. */
  headerLine: string | null;
  blocks: Block[];
}

function makeBlock(kind: BlockKind, text: string): Block {
  return { kind, text, tokens: estimateTokens(text) };
}

/**
 * Flatten markdown into an ordered stream of headers and atomic blocks.
 * Code fences and tables are kept atomic so no split can cut through them.
 */
function parseItems(markdown: string): Item[] {
  const lines = markdown.split(/\r?\n/);
  const items: Item[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      items.push({ type: 'block', block: makeBlock('paragraph', paragraph.join('\n')) });
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const headerMatch = HEADER_PATTERN.exec(line);
    if (headerMatch) {
      flushParagraph();
      items.push({
        type: 'header',
        level: headerMatch[1].length,
        text: (headerMatch[2] ?? '').trim(),
      });
      i += 1;
      continue;
    }

    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      flushParagraph();
      const delimiter = fenceMatch[1] ?? '```';
      const fenceLines = [line];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(delimiter)) {
        fenceLines.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) {
        fenceLines.push(lines[i] ?? ''); // closing fence
        i += 1;
      }
      items.push({ type: 'block', block: makeBlock('code', fenceLines.join('\n')) });
      continue;
    }

    if (line.trim().startsWith('|')) {
      flushParagraph();
      const tableLines: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        tableLines.push(lines[i] ?? '');
        i += 1;
      }
      items.push({ type: 'block', block: makeBlock('table', tableLines.join('\n')) });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return items;
}

/** Group items into sections, one per header, with content before any header in a root section. */
function buildSections(items: Item[]): Section[] {
  const sections: Section[] = [];
  let headerStack: Array<{ level: number; text: string }> = [];
  let current: Section = { headerPath: [], headerLine: null, blocks: [] };
  sections.push(current);

  for (const item of items) {
    if (item.type === 'header') {
      headerStack = headerStack.slice(0, item.level - 1);
      headerStack.push({ level: item.level, text: item.text });
      current = {
        headerPath: headerStack.map((entry) => entry.text),
        headerLine: `${'#'.repeat(item.level)} ${item.text}`,
        blocks: [],
      };
      sections.push(current);
    } else {
      current.blocks.push(item.block);
    }
  }

  return sections;
}

/** Greedy grouping of blocks under a token budget. An oversized atomic block (big table/code fence) stays whole. */
function groupBlocks(blocks: Block[], maxTokens: number): Block[][] {
  const groups: Block[][] = [];
  let current: Block[] = [];
  let currentTokens = 0;

  for (const block of blocks) {
    if (current.length > 0 && currentTokens + block.tokens > maxTokens) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(block);
    currentTokens += block.tokens;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function joinBlocks(blocks: Block[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

/**
 * Compile markdown into parent/child chunks.
 *
 * - Each non-empty section yields one or more parents (capped at `maxParentTokens`).
 * - A parent part larger than `maxChildTokens` is further split into children.
 * - A parent part with a single child would duplicate content, so in that case
 *   the parent itself is the search unit and no child rows are emitted.
 */
export function refineMarkdown(markdown: string, options: ChunkOptions = {}): RefinedDocument {
  const maxParentTokens = options.maxParentTokens ?? DEFAULT_MAX_PARENT_TOKENS;
  const maxChildTokens = options.maxChildTokens ?? DEFAULT_MAX_CHILD_TOKENS;

  const parents: ParentChunk[] = [];
  const children: ChildChunk[] = [];

  for (const section of buildSections(parseItems(markdown))) {
    if (section.blocks.length === 0) continue; // header-only / empty sections carry nothing

    const parentParts = groupBlocks(section.blocks, maxParentTokens);

    parentParts.forEach((part, partIndex) => {
      const parentIndex = parents.length;
      const body = joinBlocks(part);
      // Keep the section header inside the first parent part so downstream
      // consumers see the heading as real content, not just metadata.
      const headerPrefix = partIndex === 0 && section.headerLine ? `${section.headerLine}\n\n` : '';
      const content = headerPrefix + body;

      parents.push({
        content,
        headerPath: [...section.headerPath],
        tokenCount: estimateTokens(content),
      });

      const childGroups = groupBlocks(part, maxChildTokens);
      if (childGroups.length > 1) {
        for (const group of childGroups) {
          const childContent = joinBlocks(group);
          children.push({
            content: childContent,
            headerPath: [...section.headerPath],
            tokenCount: estimateTokens(childContent),
            parentIndex,
          });
        }
      }
    });
  }

  return { parents, children };
}

/**
 * TRD-compatible flat API: structure-aware chunks capped at `maxTokens`,
 * without the child layer.
 */
export function chunkByStructure(
  markdown: string,
  maxTokens: number = DEFAULT_MAX_PARENT_TOKENS,
): ChunkResult[] {
  const refined = refineMarkdown(markdown, {
    maxParentTokens: maxTokens,
    maxChildTokens: Number.POSITIVE_INFINITY,
  });
  return refined.parents;
}
