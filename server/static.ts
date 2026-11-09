import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isFile } from './fs-utils.ts';
import { sendText } from './http.ts';

const INDEX_FILE = 'index.html';
const STATUS_UNAVAILABLE = 503;
const NOT_BUILT_MESSAGE = 'Фронт не собран: npm run build';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export async function serveStatic(staticDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const root = path.resolve(staticDir);
  const index = path.join(root, INDEX_FILE);
  if (!(await isFile(index))) {
    sendText(res, STATUS_UNAVAILABLE, NOT_BUILT_MESSAGE);
    return;
  }
  const requested = resolveInside(root, pathname);
  const file = requested !== null && (await isFile(requested)) ? requested : index;
  const body = await readFile(file);
  const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType }).end(body);
}

function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = path.resolve(root, `.${decoded}`);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

