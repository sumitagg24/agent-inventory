import fs from 'node:fs';

export const MAX_CONFIG_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MARKDOWN_FILE_BYTES = 1024 * 1024;

/** Read and parse a small local JSON config without executing or modifying it. */
export function readJsonFile(filePath: string): unknown {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error('Config path is not a regular file.');
  if (stats.size > MAX_CONFIG_FILE_BYTES) throw new Error('Config file exceeds the size limit.');
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

/** Read local Markdown with a size limit before parsing frontmatter. */
export function readMarkdownFile(filePath: string): string {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error('Markdown path is not a regular file.');
  if (stats.size > MAX_MARKDOWN_FILE_BYTES) throw new Error('Markdown file exceeds the size limit.');
  return fs.readFileSync(filePath, 'utf8');
}
