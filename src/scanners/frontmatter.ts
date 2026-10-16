import { Buffer } from 'node:buffer';
import { parseDocument } from 'yaml';
import { MAX_MARKDOWN_FILE_BYTES } from './io.js';

/** Parse YAML frontmatter without evaluating embedded Markdown or code. */
export function parseFrontmatter(markdown: string): Record<string, unknown> {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_FILE_BYTES) {
    throw new Error('Markdown file exceeds the size limit.');
  }
  const match = markdown.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return {};

  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error('Invalid YAML frontmatter');
  }

  const data: unknown = document.toJS();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

export function metadataString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
