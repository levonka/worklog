import type { Profile } from './model.ts';

/** a neutral company profile for tests; Web has no build templates on purpose */
export const TEST_PROFILE: Profile = {
  version: 1,
  jira: {
    url: 'https://jira.example.com',
    clientCert: true,
    segmentField: 'customfield_10001',
    stages: { open: 'in_progress', 'in review': 'in_review', 'in qa': 'testing', 'ready to release': 'awaiting_release', closed: 'done' },
    stagePrefixes: { pause: 'in_progress' },
    tones: { 'in review': 'yellow', 'in qa': 'orange', closed: 'green' },
  },
  projects: [
    { prefix: 'APP-', label: 'App' },
    { prefix: 'WEB-', label: 'Web' },
  ],
  branch: { prefix: 'feature/', separator: '_', base: 'dev' },
  segments: ['EU', 'US'],
  env: {
    stand: {
      replacements: [['__', '-'], ['_', '-'], ['/', '-']],
      templates: {
        App: { EU: 'https://{b}.app.eu.example.com', US: 'https://{b}.app.us.example.com' },
        Web: { EU: 'https://{b}.web.eu.example.com', US: 'https://{b}.web.us.example.com' },
      },
    },
    build: {
      replacements: [[' ', '%20'], ['/', '%252F']],
      templates: { App: { EU: 'https://ci.example.com/job/App/job/{b}', US: 'https://ci.example.com/job/App-US/job/{b}' } },
    },
    storybook: { replacements: [[' ', '-'], ['_', '-'], ['/', '-']], links: [{ title: 'Storybook', template: 'https://{b}.storybook.example.com' }] },
  },
  gitlab: { sshHost: 'git.example.com', sshPort: 2222, mergeRequestsUrl: 'https://git.example.com/team/app/-/merge_requests/' },
  linkHosts: { confluence: ['wiki.example.com'], jenkinsPrefixes: ['ci.'] },
  links: [{ title: 'Каждый день', links: [{ title: 'Мои MR', url: 'https://git.example.com/{gitlabUser}', description: 'Мои мерж реквесты' }] }],
};
