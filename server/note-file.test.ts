import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Note } from '../shared/model.ts';
import { parseNote, serializeNote } from './note-file.ts';

const NOTE: Note = {
  id: 'n1',
  title: 'US: общий origin App и Web — "app.*"',
  body: '`shop.example.com` и `/app` делят ключи.\n\n---\nПереименовывать нельзя.',
  directionIds: ['d1'],
  files: [{ path: 'libs/local-storage/README.md' }, { path: 'push-token.service.ts', line: 42 }],
  urls: [{ url: 'https://wiki.test/x', title: 'BRD' }],
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T11:00:00.000Z',
};

test('serializeNote writes readable metadata and the body, and parseNote reads it back', () => {
  const text = serializeNote(NOTE);
  assert.match(text, /^---\ntitle: "US: общий origin App и Web — \\"app\.\*\\""\ndirections: \["d1"\]\n/);
  assert.ok(text.endsWith('\n---\n\n`shop.example.com` и `/app` делят ключи.\n\n---\nПереименовывать нельзя.\n'));
  assert.deepEqual(parseNote('n1', text), NOTE);
  assert.deepEqual(parseNote('n1', serializeNote({ ...NOTE, body: '' })), { ...NOTE, body: '' });
});

test('parseNote accepts hand edits: CRLF, blank metadata lines, extra keys, trailing newlines', () => {
  const text = serializeNote(NOTE).replace('directions:', '\nextra: 1\ndirections:').replace(/\n/g, '\r\n') + '\r\n\r\n';
  assert.deepEqual(parseNote('n1', text), NOTE);
});

test('parseNote refuses text that is not a note file', () => {
  const good = serializeNote(NOTE);
  for (const bad of [
    'просто текст',
    good.replace(/\n---\n\n/, '\n'),
    good.replace('title: "', 'title: '),
    good.replace('directions: ["d1"]', 'directions: "d1"'),
    good.replace('"line":42', '"line":0'),
    good.replace(/createdAt: .*\n/, ''),
  ]) {
    assert.equal(parseNote('n1', bad), null, bad);
  }
});
