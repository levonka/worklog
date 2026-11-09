import { readFile } from 'node:fs/promises';
import { parseProfile, ProfileError } from '../shared/model.ts';
import type { Profile } from '../shared/model.ts';
import { errorMessage, isErrorCode } from './fs-utils.ts';

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
    return { profile: null, error: `Профиль ${file}: не читается (${errorMessage(error)})` };
  }
  try {
    return { profile: profileFromText(text, file), error: null };
  } catch (error) {
    if (error instanceof ProfileError) return { profile: null, error: error.message };
    throw error;
  }
}

/** the profile in the text; the error names where the text came from */
export function profileFromText(text: string, where: string): Profile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProfileError(`Профиль ${where}: не JSON (${errorMessage(error)})`);
  }
  try {
    return parseProfile(raw);
  } catch (error) {
    if (error instanceof ProfileError) throw new ProfileError(`Профиль ${where}: ${error.message}`);
    throw error;
  }
}
