import type { NoteFile, NoteUrl } from '../shared/model.ts';

export type Guard<T> = (v: unknown) => v is T;

export function oneOf<T>(values: readonly T[]): Guard<T> {
  return (v): v is T => values.some(value => value === v);
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (v): v is T[] => Array.isArray(v) && v.every(guard);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string';
}

export function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export const isStringArray = arrayOf(isString);

/** the shape only; the path and line rules are `checkedNoteFile` in the store */
export function isNoteFile(v: unknown): v is NoteFile {
  return isRecord(v) && isString(v.path) && (v.line === undefined || typeof v.line === 'number');
}

export function isNoteUrl(v: unknown): v is NoteUrl {
  return isRecord(v) && isString(v.url) && isOptionalString(v.title);
}

export function isLineNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** a note file as stored: the shape and a line that is a real line number */
export function isStoredNoteFile(v: unknown): v is NoteFile {
  return isNoteFile(v) && (v.line === undefined || isLineNumber(v.line));
}
