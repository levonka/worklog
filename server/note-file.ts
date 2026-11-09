import type { Note } from '../shared/model.ts';
import { isNoteUrl, isStoredNoteFile, isStringArray } from './guards.ts';

// a note file: metadata between `---` lines, one `key: <JSON>` per line, then the body as it is
const FENCE = '---';
const META_LINE = /^([A-Za-z]+):\s*(.*)$/;

export function serializeNote(note: Note): string {
  const meta = [
    `title: ${JSON.stringify(note.title)}`,
    `directions: ${JSON.stringify(note.directionIds)}`,
    `files: ${JSON.stringify(note.files)}`,
    `urls: ${JSON.stringify(note.urls)}`,
    `createdAt: ${JSON.stringify(note.createdAt)}`,
    `updatedAt: ${JSON.stringify(note.updatedAt)}`,
  ];
  return `${FENCE}\n${meta.join('\n')}\n${FENCE}\n\n${note.body}\n`;
}

/** null when the text is not a note file */
export function parseNote(id: string, text: string): Note | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== FENCE) return null;
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) return null;

  const meta: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const match = META_LINE.exec(line);
    if (!match) return null;
    try {
      meta[match[1]] = JSON.parse(match[2]);
    } catch {
      return null;
    }
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n/, '')
    .replace(/\n+$/, '');

  const { title, directions, files, urls, createdAt, updatedAt } = meta;
  if (typeof title !== 'string' || typeof createdAt !== 'string' || typeof updatedAt !== 'string') return null;
  if (!isStringArray(directions) || !Array.isArray(files) || !files.every(isStoredNoteFile) || !Array.isArray(urls) || !urls.every(isNoteUrl)) return null;
  return { id, title, body, directionIds: directions, files, urls, createdAt, updatedAt };
}

