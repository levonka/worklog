import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { isErrorCode } from './fs-utils.ts';
import { isRecord, isString } from './guards.ts';
import type { ProfileJira } from '../shared/model.ts';
import type { JiraIssue } from './store.ts';

const run = promisify(execFile);
const SECURITY_BIN = '/usr/bin/security';
const BATCH = 50;
const TIMEOUT_MS = 15_000;
const NETWORK_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'];
const SERVER_CERT_CODES = ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED'];

export interface JiraConfig {
  url: string;
  /** whether Jira lets in only with the client certificate */
  clientCert: boolean;
  p12Path: string;
  /** keychain item with the certificate's password */
  keychainService: string;
  /** keychain item with the personal token */
  tokenService: string;
  caPath: string;
  segmentField?: string;
}

/** where the secrets lie; the rest comes from the profile */
export type JiraFiles = Omit<JiraConfig, 'url' | 'segmentField' | 'clientCert'>;

export function jiraConfig(jira: ProfileJira, files: JiraFiles): JiraConfig {
  return { ...files, url: jira.url, clientCert: jira.clientCert, ...(jira.segmentField === undefined ? {} : { segmentField: jira.segmentField }) };
}

export interface JiraAuth {
  pfx?: Buffer;
  passphrase?: string;
  token: string;
  ca: string[] | undefined;
}

export type JiraFetch = (keys: readonly string[]) => Promise<JiraIssue[]>;
/** `user` is Jira's `X-AUSERNAME`: who it took the request for */
export type JiraRequest = (url: string, auth: JiraAuth) => Promise<JiraAnswer>;
export interface JiraAnswer {
  status: number;
  body: string;
  user?: string;
}
export type ReadPassword = (service: string) => Promise<string | null>;

export const JIRA_ERROR_KINDS = ['token', 'cert', 'server-cert', 'network', 'other'] as const;
export type JiraErrorKind = (typeof JIRA_ERROR_KINDS)[number];

/** a message ready for the user; never holds a secret */
export class JiraError extends Error {
  readonly kind: JiraErrorKind;

  constructor(message: string, kind: JiraErrorKind = 'other') {
    super(message);
    this.kind = kind;
  }
}

export function searchUrl(base: string, keys: readonly string[], segmentField: string | undefined): string {
  const fields = segmentField === undefined ? 'status' : `status,${segmentField}`;
  const query = new URLSearchParams({ jql: `key in (${keys.join(',')})`, fields, maxResults: String(keys.length), validateQuery: 'warn' });
  return `${base.replace(/\/+$/, '')}/rest/api/2/search?${query}`;
}

export function parseSearch(body: unknown, segmentField: string | undefined): JiraIssue[] {
  if (!isRecord(body) || !Array.isArray(body.issues)) throw new JiraError('непонятный ответ');
  return body.issues.flatMap((issue: unknown) => {
    if (!isRecord(issue) || !isString(issue.key) || !isRecord(issue.fields)) return [];
    const status = issue.fields.status;
    if (!isRecord(status) || !isString(status.name)) return [];
    const options = segmentField === undefined ? undefined : issue.fields[segmentField];
    const segments = Array.isArray(options) ? options.flatMap((option: unknown) => (isRecord(option) && isString(option.value) ? [option.value] : [])) : [];
    return [{ key: issue.key, status: status.name, segments }];
  });
}

export const keychainPassword: ReadPassword = async service => {
  try {
    const { stdout } = await run(SECURITY_BIN, ['find-generic-password', '-s', service, '-w']);
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
};

export const httpsRequest: JiraRequest = (url, auth) =>
  new Promise((resolve, reject) => {
    const options = {
      pfx: auth.pfx,
      passphrase: auth.passphrase,
      ca: auth.ca,
      headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' },
      timeout: TIMEOUT_MS,
    };
    try {
      const req = https.get(url, options, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        const user = res.headers['x-ausername'];
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), user: typeof user === 'string' ? user : undefined }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
    } catch (error) {
      // a .p12 that cannot be opened throws before any request
      reject(new JiraError(`не открывается сертификат (${error instanceof Error ? error.message : String(error)})`, 'cert'));
    }
  });

/** The Jira client, or what is missing for one */
export async function createJiraFetch(config: JiraConfig, readPassword: ReadPassword = keychainPassword, request: JiraRequest = httpsRequest): Promise<JiraFetch | string> {
  const auth = await jiraAuth(config, readPassword);
  if (auth instanceof JiraError) return auth.message;

  return async keys => {
    const issues: JiraIssue[] = [];
    for (let start = 0; start < keys.length; start += BATCH) {
      const answer = await request(searchUrl(config.url, keys.slice(start, start + BATCH), config.segmentField), auth).catch((error: unknown) => {
        throw requestError(error);
      });
      issues.push(...parseSearch(parseAnswer(answer), config.segmentField));
    }
    return issues;
  };
}

/** the login Jira takes the token for */
export async function jiraUser(config: JiraConfig, readPassword: ReadPassword = keychainPassword, request: JiraRequest = httpsRequest): Promise<string> {
  const auth = await jiraAuth(config, readPassword);
  if (auth instanceof JiraError) throw auth;
  const answer = await request(`${config.url.replace(/\/+$/, '')}/rest/api/2/myself`, auth).catch((error: unknown) => {
    throw requestError(error);
  });
  const body = parseAnswer(answer);
  if (!isRecord(body) || !isString(body.name)) throw new JiraError('непонятный ответ');
  return body.name;
}

/** what a request needs, or what is missing */
async function jiraAuth(config: JiraConfig, readPassword: ReadPassword): Promise<JiraAuth | JiraError> {
  const certificate = config.clientCert ? await clientCertificate(config, readPassword) : {};
  if (typeof certificate === 'string') return new JiraError(certificate, 'cert');
  const token = (await readPassword(config.tokenService))?.trim() ?? '';
  if (token === '') return new JiraError(`нет токена в связке ключей (${config.tokenService})`, 'token');
  const caText = await readIfExists(config.caPath);
  return { ...certificate, token, ca: caText === null ? undefined : [...tls.rootCertificates, caText.toString('utf8')] };
}

/** the certificate and its password, or what is missing */
async function clientCertificate(config: JiraConfig, readPassword: ReadPassword): Promise<{ pfx: Buffer; passphrase: string } | string> {
  const pfx = await readIfExists(config.p12Path);
  if (pfx === null) return `нет сертификата ${config.p12Path}`;
  const passphrase = await readPassword(config.keychainService);
  if (passphrase === null) return `нет пароля от сертификата в связке ключей (${config.keychainService})`;
  return { pfx, passphrase };
}

function parseAnswer(answer: JiraAnswer): unknown {
  // a token Jira does not accept makes the request a guest's: 200 with no issues
  if (answer.status === 401 || answer.status === 403 || answer.user === 'anonymous') throw new JiraError('истёк или неверный токен', 'token');
  if (answer.status === 400 && answer.body.includes('No required SSL certificate')) throw new JiraError('не принят сертификат', 'cert');
  if (answer.status !== 200) throw new JiraError(`ответила ${answer.status}`);
  try {
    return JSON.parse(answer.body);
  } catch {
    throw new JiraError('непонятный ответ');
  }
}

function requestError(error: unknown): JiraError {
  if (error instanceof JiraError) return error;
  if (NETWORK_CODES.some(code => isErrorCode(error, code))) return new JiraError('нет связи', 'network');
  const code = SERVER_CERT_CODES.find(item => isErrorCode(error, item));
  if (code !== undefined) return new JiraError(`не доверяю сертификату сервера (${code})`, 'server-cert');
  return new JiraError(`ошибка запроса (${error instanceof Error ? error.message : String(error)})`);
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}
