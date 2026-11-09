import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEST_PROFILE } from '../shared/test-profile.ts';
import { fetchProfile, gitShowFile, gitlabSshUrl, parseGitlabFileUrl } from './profile-source.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const DOCS = { host: 'git.example.com', project: 'team/docs', ref: 'main', file: 'a/b/profile.json' };

test('parseGitlabFileUrl reads blob and raw links', () => {
  assert.deepEqual(parseGitlabFileUrl('https://git.example.com/team/docs/-/blob/main/a/b/profile.json?ref_type=heads'), DOCS);
  assert.deepEqual(parseGitlabFileUrl('https://git.example.com/team/docs/-/raw/main/a/b/profile.json#L1'), DOCS);
  assert.equal(parseGitlabFileUrl('https://git.example.com/team/docs'), null);
  assert.equal(parseGitlabFileUrl('/tmp/x.json'), null);
});

test('gitlabSshUrl prefers the profile, then the project origin, then port 22', () => {
  assert.equal(gitlabSshUrl(DOCS, { sshHost: 'git.example.com', sshPort: 2222 }, 'ssh://git@git.example.com:7000/team/app.git'), 'ssh://git@git.example.com:2222/team/docs.git');
  assert.equal(gitlabSshUrl(DOCS, undefined, 'ssh://git@git.example.com:7000/team/app.git'), 'ssh://git@git.example.com:7000/team/docs.git');
  assert.equal(gitlabSshUrl(DOCS, undefined, 'git@git.example.com:team/app.git'), 'ssh://git@git.example.com/team/docs.git');
  assert.equal(gitlabSshUrl(DOCS, undefined, 'ssh://git@other.example.com:7000/team/app.git'), 'ssh://git@git.example.com/team/docs.git');
  assert.equal(gitlabSshUrl(DOCS, undefined, null), 'ssh://git@git.example.com/team/docs.git');
});

test('gitShowFile reads one file of a branch', async t => {
  const repo = path.join(await tempDir(t), 'docs');
  await mkdir(path.join(repo, 'a'), { recursive: true });
  await writeFile(path.join(repo, 'a', 'profile.json'), '{"version":1}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  git('add', '-A');
  git('commit', '--quiet', '-m', 'x');

  assert.equal(await gitShowFile(`file://${repo}`, 'main', 'a/profile.json'), '{"version":1}\n');
  await assert.rejects(gitShowFile(`file://${repo}`, 'main', 'a/missing.json'), /a\/missing\.json/);
});

test('fetchProfile saves a valid profile and records its source', async t => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'company.json');
  const text = `${JSON.stringify(TEST_PROFILE, null, 2)}\n`;
  await writeFile(source, text);
  const opts = { profilePath: path.join(dir, 'config', 'profile.json'), envFile: path.join(dir, 'config', 'env') };
  const profile = await fetchProfile(source, opts);
  assert.equal(profile.version, 1);
  assert.equal(await readFile(opts.profilePath, 'utf8'), text);
  assert.equal(await readFile(opts.envFile, 'utf8'), `WORKLOG_PROFILE_SOURCE=${source}\n`);
});

test('gitShowFile names the cause of an SSH failure, not git advice', async () => {
  await assert.rejects(gitShowFile('ssh://git@127.0.0.1:1/team/docs.git', 'main', 'p.json'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /port 1/);
    assert.doesNotMatch(error.message, /repository exists|\.\./);
    return true;
  });
});
