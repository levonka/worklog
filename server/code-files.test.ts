import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorArgs } from './code-files.ts';

test('editorArgs opens JetBrains IDEs on the line', () => {
  assert.deepEqual(editorArgs('jetbrains', '/a/b.ts', 42), ['--line', '42', '/a/b.ts']);
  assert.deepEqual(editorArgs('jetbrains', '/a/b.ts', undefined), ['/a/b.ts']);
});

test('editorArgs opens VS Code and Cursor with --goto', () => {
  assert.deepEqual(editorArgs('vscode', '/a/b.ts', 42), ['--goto', '/a/b.ts:42']);
  assert.deepEqual(editorArgs('cursor', '/a/b.ts', 42), ['--goto', '/a/b.ts:42']);
  assert.deepEqual(editorArgs('cursor', '/a/b.ts', undefined), ['/a/b.ts']);
});
