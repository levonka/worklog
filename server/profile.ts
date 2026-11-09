import { readFile } from 'node:fs/promises';
import { parseProfile, ProfileError } from '../shared/model.ts';
import type { Profile } from '../shared/model.ts';
import { isErrorCode } from './fs-utils.ts';

export interface LoadedProfile {
  profile: Profile | null;
  error: string | null;
}

/** the company profile; no file is not an error, a broken one is reported and ignored */
export async function loadProfile(file: string): Promise<LoadedProfile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { profile: null, error: null };
    return { profile: null, error: `Профиль ${file}: не читается (${error instanceof Error ? error.message : String(error)})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { profile: null, error: `Профиль ${file}: не JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    return { profile: parseProfile(raw), error: null };
  } catch (error) {
    if (error instanceof ProfileError) return { profile: null, error: `Профиль ${file}: ${error.message}` };
    throw error;
  }
}
