import type { IncomingMessage, ServerResponse } from 'node:http';
import { DataError } from './fs-utils.ts';
import { ConflictError, NotFoundError, ValidationError } from './store.ts';

const MAX_BODY_BYTES = 1024 * 1024;

const STATUS_BAD_REQUEST = 400;
const STATUS_FORBIDDEN = 403;
export const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
export const STATUS_INTERNAL_ERROR = 500;
const INTERNAL_ERROR_TEXT = 'Внутренняя ошибка сервера';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RouteContext {
  params: string[];
  query: URLSearchParams;
  readBody(): Promise<unknown>;
}

export interface RouteResult {
  status: number;
  body?: unknown;
}

export interface Route {
  method: string;
  pattern: RegExp;
  handler(ctx: RouteContext): Promise<RouteResult>;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: match.slice(1).map(decodeSegment) };
  }
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(STATUS_BAD_REQUEST, `Некорректный путь: ${segment}`);
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // keep draining after the limit so the client still receives the 413 instead of a reset
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(STATUS_PAYLOAD_TOO_LARGE, 'Тело запроса больше 1 МБ');
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  // application/json is not a CORS-simple type, so a cross-origin page needs a preflight, which is never granted
  if (mediaType(req.headers['content-type']) !== 'application/json') {
    throw new HttpError(STATUS_UNSUPPORTED_MEDIA_TYPE, 'Content-Type должен быть application/json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(STATUS_BAD_REQUEST, 'Тело запроса: некорректный JSON');
  }
}

function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

export function assertLocalHost(req: IncomingMessage, port: number): void {
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new HttpError(STATUS_FORBIDDEN, 'Недопустимый заголовок Host');
  }
}

const READ_METHODS = ['GET', 'HEAD'];

/** a browser sends Origin with every write, a no-cors one without a body included; clients outside a browser send none */
export function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (READ_METHODS.includes(req.method ?? 'GET')) return;
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const value = origin.toLowerCase();
  if (value !== `http://127.0.0.1:${port}` && value !== `http://localhost:${port}`) {
    throw new HttpError(STATUS_FORBIDDEN, 'Запрос с чужой страницы');
  }
}

export function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
}

export interface ErrorAnswer {
  status: number;
  message: string;
  /** a server fault: its details go to the log */
  logged: boolean;
}

export function errorAnswer(error: unknown): ErrorAnswer {
  if (error instanceof HttpError) return { status: error.status, message: error.message, logged: false };
  if (error instanceof ValidationError) return { status: STATUS_BAD_REQUEST, message: error.message, logged: false };
  if (error instanceof NotFoundError) return { status: STATUS_NOT_FOUND, message: error.message, logged: false };
  if (error instanceof ConflictError) return { status: STATUS_CONFLICT, message: error.message, logged: false };
  // the user needs this text to find the broken file
  if (error instanceof DataError) return { status: STATUS_INTERNAL_ERROR, message: error.message, logged: true };
  return { status: STATUS_INTERNAL_ERROR, message: INTERNAL_ERROR_TEXT, logged: true };
}

export function sendError(res: ServerResponse, error: unknown): void {
  const answer = errorAnswer(error);
  if (answer.logged) console.error(error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, answer.status, { error: answer.message });
}
