import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Editor, Note, NoteFile } from '../shared/model.ts';
import { isFile } from './fs-utils.ts';
import { NotFoundError, checkedNoteFile } from './store.ts';

export { EDITORS } from '../shared/model.ts';
export type { Editor } from '../shared/model.ts';

/** found through PATH unless WORKLOG_EDITOR_BIN names the binary */
export const EDITOR_BINS: Record<Editor, string> = { jetbrains: 'webstorm', vscode: 'code', cursor: 'cursor' };

export interface EditorCommand {
  name: Editor;
  bin: string;
}

export interface CodeConfig {
  /** the repository the note paths are relative to */
  root: string;
  /** null: the user has no editor of ours, file links do not open */
  editor: EditorCommand | null;
}

/** note paths with no file under the root, each once */
export async function missingFiles(root: string, notes: readonly Note[]): Promise<string[]> {
  const paths = [...new Set(notes.flatMap(note => note.files.map(file => file.path)))];
  const found = await Promise.all(paths.map(p => isFile(path.join(root, p))));
  return paths.filter((_, i) => !found[i]).sort();
}

export function editorArgs(editor: Editor, file: string, line: number | undefined): string[] {
  if (line === undefined) return [file];
  return editor === 'jetbrains' ? ['--line', String(line), file] : ['--goto', `${file}:${line}`];
}

/** opens the file in the editor on its line; the editor keeps running after the server stops */
export async function openInEditor(root: string, editor: EditorCommand, requested: NoteFile): Promise<void> {
  const file = checkedNoteFile(requested);
  const absolute = path.join(root, file.path);
  if (!(await isFile(absolute))) throw new NotFoundError(`Файла нет: ${file.path}`);
  const child = spawn(editor.bin, editorArgs(editor.name, absolute, file.line), { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => reject(new Error(`Не удалось запустить редактор (${editor.bin}): ${error.message}`)));
  });
  child.unref();
}
