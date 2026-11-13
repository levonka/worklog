import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Direction, Note, RepeatRule } from './model.ts';
import {
  EMPTY_STATE,
  clampIndex,
  detectLinkKind,
  dueRepeats,
  parseRepeatDays,
  parseTime,
  repeatDayOf,
  repeatLabel,
  moveInList,
  normalizeTicketKey,
  noteLinkLines,
  noteMatches,
  parseNoteLink,
  placeDirection,
  statusFromAlias,
  ticketFromKey,
  ticketKeysIn,
  withScheme,
} from './model.ts';

function direction(id: string, status: Direction['status'], order: number): Direction {
  return { id, title: id, status, tickets: [], links: [], events: [], order, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}

test('normalizeTicketKey trims and upper-cases valid keys', () => {
  assert.equal(normalizeTicketKey(' app-9355 '), 'APP-9355');
  assert.equal(normalizeTicketKey('WEB-5586'), 'WEB-5586');
});

test('normalizeTicketKey rejects non-keys', () => {
  assert.equal(normalizeTicketKey('SEO'), null);
});

test('detectLinkKind recognises hosts and paths', () => {
  assert.equal(detectLinkKind('https://www.figma.com/design/x', TEST_PROFILE), 'figma');
  assert.equal(detectLinkKind('https://wiki.example.com/pages/viewpage.action?pageId=1', TEST_PROFILE), 'confluence');
  assert.equal(detectLinkKind('https://git.example.com/team/app/-/merge_requests/3852', TEST_PROFILE), 'mr');
  assert.equal(detectLinkKind('https://ci.example.com/job/x', TEST_PROFILE), 'jenkins');
  assert.equal(detectLinkKind('https://git.example.com/team/app/-/tree/feature-x', TEST_PROFILE), 'branch');
  assert.equal(detectLinkKind('https://example.com', TEST_PROFILE), 'other');
});

test('placeDirection moves between statuses and renumbers both', () => {
  const list = [direction('a', 'in_progress', 0), direction('b', 'in_progress', 1), direction('c', 'waiting', 0)];
  const result = placeDirection(list, 'a', 'waiting', 0);
  const byId = (id: string) => result.find(d => d.id === id);
  assert.deepEqual([byId('a')?.status, byId('a')?.order], ['waiting', 0]);
  assert.deepEqual([byId('c')?.status, byId('c')?.order], ['waiting', 1]);
  assert.deepEqual([byId('b')?.status, byId('b')?.order], ['in_progress', 0]);
  assert.equal(list[0].status, 'in_progress');
});

test('moveInList returns a new reordered array', () => {
  const source = ['x', 'y', 'z'];
  assert.deepEqual(moveInList(source, 0, 2), ['y', 'z', 'x']);
  assert.deepEqual(source, ['x', 'y', 'z']);
});

test('statusFromAlias knows aliases and ignores Object.prototype names', () => {
  assert.equal(statusFromAlias('wait'), 'waiting');
  assert.equal(statusFromAlias('awaiting_release'), 'awaiting_release');
  assert.equal(statusFromAlias('mr'), 'in_review');
  assert.equal(statusFromAlias('review'), 'in_review');
  assert.equal(statusFromAlias('constructor'), undefined);
  assert.equal(statusFromAlias('toString'), undefined);
  assert.equal(statusFromAlias('__proto__'), undefined);
});

test('EMPTY_STATE cannot be changed by a consumer', () => {
  assert.throws(() => EMPTY_STATE.directions.push(direction('a', 'in_progress', 0)), TypeError);
  assert.throws(() => {
    EMPTY_STATE.todos = [];
  }, TypeError);
  assert.deepEqual(EMPTY_STATE, { directions: [], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });
});

test('moveInList with an index outside the list returns an unchanged copy', () => {
  const source = ['x', 'y'];
  for (const from of [-1, 2, 5]) {
    const result = moveInList(source, from, 0);
    assert.deepEqual(result, ['x', 'y']);
    assert.notEqual(result, source);
  }
});

test('clampIndex keeps an index inside a list of the given length', () => {
  assert.equal(clampIndex(-3, 4), 0);
  assert.equal(clampIndex(2, 4), 2);
  assert.equal(clampIndex(9, 4), 3);
  assert.equal(clampIndex(5, 0), 0);
});

test('detectLinkKind looks at the host and path, not at the query', () => {
  assert.equal(detectLinkKind('https://example.com/?from=figma.com', TEST_PROFILE), 'other');
  assert.equal(detectLinkKind('https://example.com/search?q=ci.example', TEST_PROFILE), 'other');
  assert.equal(detectLinkKind('https://example.com/?next=/-/merge_requests/1', TEST_PROFILE), 'other');
  assert.equal(detectLinkKind('https://figma.com.evil.test/x', TEST_PROFILE), 'other');
  assert.equal(detectLinkKind('https://figma.com/file/1', TEST_PROFILE), 'figma');
  assert.equal(detectLinkKind('не адрес', TEST_PROFILE), 'other');
});

test('placeDirection clamps the index and renumbers both columns from zero', () => {
  const list = [direction('a', 'in_progress', 0), direction('b', 'in_progress', 1), direction('c', 'waiting', 0)];
  const result = placeDirection(list, 'a', 'waiting', 99);
  const byId = (id: string) => result.find(d => d.id === id);
  assert.deepEqual([byId('c')?.status, byId('c')?.order], ['waiting', 0]);
  assert.deepEqual([byId('a')?.status, byId('a')?.order], ['waiting', 1]);
  assert.deepEqual([byId('b')?.status, byId('b')?.order], ['in_progress', 0]);
});

test('placeDirection reorders within the same status', () => {
  const list = [direction('a', 'testing', 0), direction('b', 'testing', 1), direction('c', 'testing', 2)];
  const result = placeDirection(list, 'c', 'testing', 0);
  const order = [...result].sort((x, y) => x.order - y.order).map(d => d.id);
  assert.deepEqual(order, ['c', 'a', 'b']);
  assert.ok(result.every(d => d.status === 'testing'));
});

test('placeDirection with an unknown id returns the list itself', () => {
  const list = [direction('a', 'testing', 0)];
  assert.equal(placeDirection(list, 'nope', 'waiting', 0), list);
});

test('withScheme adds https to a bare host and keeps other schemes', () => {
  assert.equal(withScheme('jira.example.com/browse/APP-1'), 'https://jira.example.com/browse/APP-1');
  assert.equal(withScheme('localhost:4200'), 'https://localhost:4200');
  assert.equal(withScheme('http://localhost:4200'), 'http://localhost:4200');
  assert.equal(withScheme('HTTPS://x.test'), 'HTTPS://x.test');
  assert.equal(withScheme('mailto:me@x.test'), 'mailto:me@x.test');
  assert.equal(withScheme('tel:+79990000000'), 'tel:+79990000000');
});

// --- daily ---

import type { Daily, DailyDraft, SessionSummary, Todo, WorkEvent, WorklogState } from './model.ts';
import {
  activeDraft,
  countEventsAfter,
  doneDateOf,
  currentPeriodStart,
  dailyItems,
  defaultPeriodStart,
  periodDigest,
  statusOfEvent,
  summaryRunState,
  upcomingDailyAt,
} from './model.ts';

// 5 November 2026 is a Thursday
const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 10, day, hour, minute);
const iso = (day: number, hour: number, minute = 0): string => at(day, hour, minute).toISOString();

function held(heldAt: string): Daily {
  return { id: heldAt, heldAt, periodStart: heldAt, text: 'x', items: [] };
}

function event(id: string, when: string, text: string, kind: WorkEvent['kind'] = 'note'): WorkEvent {
  return { id, at: when, text, source: kind === 'note' ? 'manual' : 'system', kind };
}

function dir(id: string, patch: Partial<Direction> = {}): Direction {
  return { ...direction(id, 'in_progress', 0), ...patch };
}

function todo(id: string, patch: Partial<Todo> = {}): Todo {
  return { id, text: id, done: false, createdAt: iso(1, 9), ...patch };
}

function state(patch: Partial<WorklogState> = {}): WorklogState {
  return { directions: [], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [], ...patch };
}

test('EMPTY_STATE has no dailies and no draft', () => {
  assert.deepEqual(EMPTY_STATE.dailies, []);
  assert.equal(EMPTY_STATE.draft, null);
});

test('defaultPeriodStart is 11:30 of the previous working day', () => {
  assert.equal(defaultPeriodStart(at(5, 10)).getTime(), at(4, 11, 30).getTime());
  assert.equal(defaultPeriodStart(at(5, 15)).getTime(), at(4, 11, 30).getTime());
  assert.equal(defaultPeriodStart(at(9, 9)).getTime(), at(6, 11, 30).getTime());
  assert.equal(defaultPeriodStart(at(7, 12)).getTime(), at(6, 11, 30).getTime());
  assert.equal(defaultPeriodStart(at(8, 12)).getTime(), at(6, 11, 30).getTime());
});

test('currentPeriodStart takes the later of the default start and the last held daily', () => {
  const dailies = [held(iso(5, 11, 50))];
  assert.equal(currentPeriodStart(at(6, 10), dailies), iso(5, 11, 50));
  assert.equal(currentPeriodStart(at(9, 10), dailies), iso(6, 11, 30));
  assert.equal(currentPeriodStart(at(5, 11, 40), dailies), iso(4, 11, 30));
});

test('upcomingDailyAt is today on a working day, else the next working day', () => {
  assert.equal(upcomingDailyAt(at(5, 10)).getTime(), at(5, 11, 30).getTime());
  assert.equal(upcomingDailyAt(at(5, 15)).getTime(), at(5, 11, 30).getTime());
  assert.equal(upcomingDailyAt(at(7, 10)).getTime(), at(9, 11, 30).getTime());
});

test('activeDraft ignores a draft of another period', () => {
  const draft: DailyDraft = { periodStart: iso(4, 11, 30), text: 'старый', textAt: iso(4, 12), summary: null, run: null };
  assert.equal(activeDraft(state({ draft }), iso(5, 11, 30)), null);
  assert.equal(activeDraft(state({ draft }), iso(4, 11, 30)), draft);
});

test('summaryRunState treats a long running run as failed', () => {
  const now = at(5, 12);
  assert.equal(summaryRunState({ status: 'running', startedAt: iso(5, 11, 59), baseTextAt: null }, now), 'running');
  assert.equal(summaryRunState({ status: 'running', startedAt: iso(5, 11, 53), baseTextAt: null }, now), 'failed');
  assert.equal(summaryRunState({ status: 'failed', at: iso(5, 11), error: 'x' }, now), 'failed');
  assert.equal(summaryRunState(null, now), 'idle');
});

test('statusOfEvent reads status events', () => {
  assert.equal(statusOfEvent(event('e', iso(5, 9), 'Статус: Жду · девопсы', 'status')), 'waiting');
  assert.equal(statusOfEvent(event('e', iso(5, 9), 'Статус: Жду', 'status')), 'waiting');
  assert.equal(statusOfEvent(event('e', iso(5, 9), 'Статус: Ждёт релиза', 'status')), 'awaiting_release');
  assert.equal(statusOfEvent(event('e', iso(5, 9), 'Статус: В мерж реквесте', 'status')), 'in_review');
  assert.equal(statusOfEvent(event('e', iso(5, 9), 'Статус: Жду', 'note')), null);
});

test('doneDateOf prefers doneAt', () => {
  const d = dir('d', { status: 'done', doneAt: '2026-10-30T09:00:00.000Z', events: [event('s', iso(6, 9), 'Статус: Готово', 'status')] });
  assert.equal(doneDateOf(d), '2026-10-30T09:00:00.000Z');
});

test('doneDateOf falls back to the last «Статус: Готово» event, then updatedAt', () => {
  const events = [
    event('a', iso(1, 9), 'Статус: Готово', 'status'),
    event('b', iso(5, 9), 'Статус: Готово', 'status'),
    event('c', iso(6, 9), 'Статус: В работе', 'status'),
    event('n', iso(7, 9), 'Статус: Готово'),
  ];
  assert.equal(doneDateOf(dir('d', { status: 'done', events })), iso(5, 9));
  assert.equal(doneDateOf(dir('d', { status: 'done', updatedAt: iso(3, 12) })), iso(3, 12));
});

test('periodDigest groups events of the period by direction in order of first activity', () => {
  const start = iso(4, 11, 30);
  const a = dir('a', { events: [event('a0', iso(4, 10), 'до периода'), event('a1', iso(5, 9), 'позже')] });
  const b = dir('b', { events: [event('b1', iso(4, 15), 'раньше')] });
  const digest = periodDigest(state({ directions: [a, b] }), start, null, '2026-11-05');
  assert.deepEqual(digest.groups.map(g => g.direction.id), ['b', 'a']);
  assert.deepEqual(digest.groups[1].events.map(e => e.id), ['a1']);
  assert.equal(digest.eventCount, 2);
});

test('periodDigest puts summary items of unknown directions into unbound', () => {
  const summary: SessionSummary = {
    ranAt: iso(5, 10),
    sessionCount: 2,
    items: [
      { id: 'i1', sessionId: 's1', at: iso(5, 9), directionId: 'a', text: 'разобрал сторы' },
      { id: 'i2', sessionId: 's2', at: iso(5, 9), directionId: 'gone', text: 'что-то' },
      { id: 'i3', sessionId: 's3', at: iso(5, 9), directionId: null, text: 'без направления' },
    ],
    candidates: [],
  };
  const digest = periodDigest(state({ directions: [dir('a')] }), iso(4, 11, 30), summary, '2026-11-05');
  assert.deepEqual(digest.groups.map(g => g.items.map(i => i.id)), [['i1']]);
  assert.deepEqual(digest.unbound.map(i => i.id), ['i2', 'i3']);
});

test('periodDigest waiting entries take since from the status event', () => {
  const w = dir('w', { status: 'waiting', waitingFor: 'девопсы', updatedAt: iso(5, 9), events: [event('s', iso(3, 14), 'Статус: Жду · девопсы', 'status')] });
  const digest = periodDigest(state({ directions: [w] }), iso(4, 11, 30), null, '2026-11-05');
  assert.equal(digest.waiting.length, 1);
  assert.equal(digest.waiting[0].since, iso(3, 14));
});

test('periodDigest today lists idle in-progress directions and todos due by today', () => {
  const busy = dir('busy', { events: [event('e', iso(5, 9), 'сделал')] });
  const idle = dir('idle');
  const todos = [
    todo('overdue', { due: '2026-11-04' }),
    todo('today', { due: '2026-11-05' }),
    todo('tomorrow', { due: '2026-11-06' }),
    todo('done', { due: '2026-11-05', done: true, doneAt: iso(5, 9) }),
    todo('nodue'),
    todo('repeat', { due: '2026-11-05', repeatId: 'r1' }),
  ];
  const digest = periodDigest(state({ directions: [busy, idle], todos }), iso(4, 11, 30), null, '2026-11-05');
  assert.deepEqual(digest.today.directions.map(d => d.id), ['idle']);
  assert.deepEqual(digest.today.todos.map(t => t.id), ['overdue', 'today']);
});

test('dailyItems lists events, summary items and unbound items', () => {
  const a = dir('a', { title: 'Сторы', events: [event('e', iso(5, 9), 'взял')] });
  const summary: SessionSummary = {
    ranAt: iso(5, 10),
    sessionCount: 1,
    items: [
      { id: 'i1', sessionId: 's1', at: iso(5, 9, 30), directionId: 'a', text: 'разобрал' },
      { id: 'i2', sessionId: 's1', at: iso(5, 9, 30), directionId: null, text: 'вне' },
    ],
    candidates: [],
  };
  const items = dailyItems(periodDigest(state({ directions: [a] }), iso(4, 11, 30), summary, '2026-11-05'));
  assert.deepEqual(items, [
    { directionId: 'a', directionTitle: 'Сторы', text: 'взял', origin: 'event', eventSource: 'manual' },
    { directionId: 'a', directionTitle: 'Сторы', text: 'разобрал', origin: 'summary' },
    { directionId: null, directionTitle: null, text: 'вне', origin: 'summary' },
  ]);
});

test('countEventsAfter counts events of the period after a moment', () => {
  const a = dir('a', { events: [event('1', iso(4, 9), 'до'), event('2', iso(5, 9), 'раньше'), event('3', iso(5, 11), 'после')] });
  assert.equal(countEventsAfter(state({ directions: [a] }), iso(4, 11, 30), iso(5, 10)), 1);
});

// --- daily text ---

import { findAiMentions, templateText } from './model.ts';

function withTickets(id: string, title: string, keys: string[], patch: Partial<Direction>): Direction {
  return dir(id, { title, tickets: keys.map(key => ticketFromKey(key, TEST_PROFILE)), ...patch });
}

test('templateText renders paragraphs, ticket lines and today', () => {
  const seo = withTickets('seo', 'SEO-текст на страницах матчей', ['APP-9355', 'WEB-5586'], {
    status: 'waiting',
    waitingFor: 'бэк (Олег Петров)',
    events: [event('s1', iso(4, 14), 'Олег Петров подтвердил: бэк не отдаёт данные'), event('s2', iso(4, 14, 5), 'Статус: Жду · бэк (Олег Петров)', 'status')],
  });
  const redirect = withTickets('red', 'Редирект по user-agent', ['SHOP-8221', 'INFRA-4601'], {
    status: 'waiting',
    waitingFor: 'девопсы',
    events: [event('r1', iso(4, 16), 'Создал задачу девопсам через их дашборд')],
  });
  const stores = withTickets('st', 'Браузерные сторы', ['APP-9618', 'WEB-5742'], { events: [event('b1', iso(5, 9), 'Статус: В работе', 'status')] });
  const captcha = dir('cap', { title: 'Капча-2', order: 1 });
  const todos = [todo('t', { text: 'Завести задачу бэку', requestedBy: 'Олега', due: '2026-11-05' })];
  const digest = periodDigest(state({ directions: [seo, redirect, stores, captcha], todos }), iso(4, 11, 30), null, '2026-11-05');
  assert.equal(
    templateText(digest),
    [
      'Касаемо задачи «SEO-текст на страницах матчей»: Олег Петров подтвердил: бэк не отдаёт данные. Жду: бэк (Олег Петров).',
      '1. APP-9355  2. WEB-5586',
      '',
      'Касаемо задачи «Редирект по user-agent»: Создал задачу девопсам через их дашборд.',
      '1. SHOP-8221  2. INFRA-4601',
      '',
      'Взял в работу задачу «Браузерные сторы».',
      '1. APP-9618  2. WEB-5742',
      '',
      'Сегодня: продолжаю задачу «Капча-2»; завести задачу бэку (от Олега).',
    ].join('\n'),
  );
});

test('templateText renders todo-done as "Сделал: …" and maps statuses', () => {
  const d = dir('d', {
    title: 'Тоглы',
    status: 'testing',
    events: [event('1', iso(5, 9), 'Удалить тогл (от Олега)', 'todo-done'), event('2', iso(5, 10), 'Статус: Тестирование', 'status')],
  });
  const digest = periodDigest(state({ directions: [d] }), iso(4, 11, 30), null, '2026-11-05');
  assert.equal(templateText(digest), 'Касаемо задачи «Тоглы»: Сделал: удалить тогл (от Олега). Передал в тестирование.');
});

test('templateText says the MR went to review for the in_review status', () => {
  const d = dir('d', { title: 'SEO', status: 'in_review', events: [event('1', iso(5, 9), 'Статус: В мерж реквесте', 'status')] });
  const digest = periodDigest(state({ directions: [d] }), iso(4, 11, 30), null, '2026-11-05');
  assert.equal(templateText(digest), 'Касаемо задачи «SEO»: Отправил мерж реквест на ревью.');
});

test('templateText keeps summary items of a direction and leaves unbound items out', () => {
  const d = dir('d', { title: 'Сторы', status: 'waiting' });
  const summary: SessionSummary = {
    ranAt: iso(5, 10),
    sessionCount: 2,
    items: [
      { id: 'i1', sessionId: 's1', at: iso(5, 9), directionId: 'd', text: 'разобрал, как приложение работает с localStorage' },
      { id: 'i2', sessionId: 's2', at: iso(5, 9), directionId: null, text: 'придумывал worklog' },
    ],
    candidates: [],
  };
  const digest = periodDigest(state({ directions: [d] }), iso(4, 11, 30), summary, '2026-11-05');
  assert.equal(templateText(digest), 'Касаемо задачи «Сторы»: Разобрал, как приложение работает с localStorage.');
});

test('templateText of an empty digest is empty', () => {
  assert.equal(templateText(periodDigest(state(), iso(4, 11, 30), null, '2026-11-05')), '');
});

test('findAiMentions finds AI words with Cyrillic word boundaries', () => {
  assert.deepEqual(findAiMentions('Спросил у Claude, агент ответил, Claude молодец'), ['claude', 'агент']);
  assert.deepEqual(findAiMentions('Пообщался с Олегом'), []);
  assert.deepEqual(findAiMentions('ИИ-помощник'), ['ии']);
  assert.deepEqual(findAiMentions('аидентификация и отдаём AI-ответ'), ['ai']);
  assert.deepEqual(findAiMentions('в прошлой сессии сгенерировал'), ['сессии', 'сгенерировал']);
});

test('a daily held before 11:30 starts the next period itself', () => {
  const early = [held(iso(5, 11, 20))];
  assert.equal(currentPeriodStart(at(6, 10), early), iso(5, 11, 20));
  assert.equal(currentPeriodStart(at(9, 10), [held(iso(6, 11, 20))]), iso(6, 11, 20));
  // held two working days ago: the default start of the previous working day wins
  assert.equal(currentPeriodStart(at(6, 10), [held(iso(4, 11, 20))]), iso(5, 11, 30));
});

test('upcomingDailyAt moves to the next working day once today is held', () => {
  assert.equal(upcomingDailyAt(at(5, 15), [held(iso(5, 11, 40))]).getTime(), at(6, 11, 30).getTime());
  assert.equal(upcomingDailyAt(at(6, 15), [held(iso(6, 11, 40))]).getTime(), at(9, 11, 30).getTime());
  assert.equal(upcomingDailyAt(at(5, 15), [held(iso(4, 11, 40))]).getTime(), at(5, 11, 30).getTime());
});

test('findAiMentions ignores a word after a hyphen', () => {
  assert.deepEqual(findAiMentions('редирект по юзер-агенту'), []);
  assert.deepEqual(findAiMentions('ИИ-помощник и «агент»'), ['ии', 'агент']);
});

test('ticketKeysIn finds keys in titles, query strings and branch names, each once', () => {
  assert.deepEqual(ticketKeysIn('[APP-8962] Унификация · APP-8962, WEB-5296'), ['APP-8962', 'WEB-5296']);
  assert.deepEqual(ticketKeysIn('https://jira.example.com/secure/RapidBoard.jspa?selectedIssue=WEB-5686'), ['WEB-5686']);
  assert.deepEqual(ticketKeysIn('https://git.example.com/app/-/tree/feature/APP-9355_WEB-5586'), ['APP-9355', 'WEB-5586']);
});

test('ticketKeysIn skips lower-case and glued keys', () => {
  assert.deepEqual(ticketKeysIn('app-1 XAPP-2a AAPP-3 pageId=7667855'), ['AAPP-3']);
  assert.deepEqual(ticketKeysIn('нет номеров'), []);
});

test('parseNoteLink reads files with lines, addresses with titles, and refuses paths outside the root', () => {
  assert.deepEqual(parseNoteLink('  libs/local-storage/README.md '), { file: { path: 'libs/local-storage/README.md' } });
  assert.deepEqual(parseNoteLink('./push-token.service.ts:42'), { file: { path: 'push-token.service.ts', line: 42 } });
  assert.deepEqual(parseNoteLink('https://wiki.test/x?a=1 BRD капчи'), { url: { url: 'https://wiki.test/x?a=1', title: 'BRD капчи' } });
  assert.deepEqual(parseNoteLink('https://wiki.test/x'), { url: { url: 'https://wiki.test/x' } });
  for (const bad of ['', '/etc/passwd', '../secret', 'a/../../b', '~/x', 'a b.ts', 'a.ts:0']) assert.equal(parseNoteLink(bad), null, bad);
});

test('noteLinkLines writes the lines parseNoteLink reads back', () => {
  const links = { files: [{ path: 'a.ts', line: 3 }, { path: 'README.md' }], urls: [{ url: 'https://x.test/', title: 'Икс' }, { url: 'https://y.test/' }] };
  const lines = noteLinkLines(links);
  assert.deepEqual(lines, ['a.ts:3', 'README.md', 'https://x.test/ Икс', 'https://y.test/']);
  assert.deepEqual(lines.map(parseNoteLink), [{ file: links.files[0] }, { file: links.files[1] }, { url: links.urls[0] }, { url: links.urls[1] }]);
});

test('noteMatches looks for every word in the note and its directions', () => {
  const by = { ...direction('by', 'in_progress', 0), title: 'US пуши', tickets: [ticketFromKey('APP-9508', TEST_PROFILE)] };
  const note: Note = {
    id: 'n',
    title: 'Общий origin',
    body: 'Ключи `app.*` в localStorage',
    directionIds: ['by'],
    files: [{ path: 'push-token.service.ts', line: 42 }],
    urls: [],
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
  };
  for (const query of ['', 'origin', 'LOCALSTORAGE ключи', 'push-token', 'app-9508', 'пуши']) assert.ok(noteMatches(note, query, [by]), query);
  assert.equal(noteMatches(note, 'origin капча', [by]), false);
  assert.equal(noteMatches(note, 'пуши', []), false);
});

// --- agent ---

import type { AgentRequest, AgentRun } from './model.ts';
import { activeRuns, agentContext, agentPrompt, agentRunTitle, directionBranch, isBranchName, suggestBranch } from './model.ts';

test('directionBranch joins one key per project in the profile order', () => {
  const keys = (...list: string[]) => list.map(key => ticketFromKey(key, TEST_PROFILE));
  assert.equal(directionBranch(keys('WEB-5586', 'APP-9355'), TEST_PROFILE), 'feature/APP-9355_WEB-5586');
  assert.equal(directionBranch(keys('CORE-580', 'APP-9618', 'WEB-5742'), TEST_PROFILE), 'feature/APP-9618_WEB-5742');
  assert.equal(directionBranch(keys('WEB-5489'), TEST_PROFILE), 'feature/WEB-5489');
  assert.equal(directionBranch(keys('APP-8260', 'APP-8259'), TEST_PROFILE), 'feature/APP-8260');
  assert.equal(directionBranch(keys('CRM-4082'), TEST_PROFILE), null);
  assert.equal(directionBranch([], TEST_PROFILE), null);
});

test('suggestBranch takes the profile order, one key alone, other tickets never make a branch', () => {
  const keys = (...list: string[]) => list.map(key => ticketFromKey(key, TEST_PROFILE));
  assert.equal(suggestBranch(keys('WEB-5586', 'APP-9355'), 'execute', TEST_PROFILE), 'feature/APP-9355_WEB-5586');
  assert.equal(suggestBranch(keys('CORE-580', 'APP-9618', 'WEB-5742'), 'decompose', TEST_PROFILE), 'feature/APP-9618_WEB-5742');
  assert.equal(suggestBranch(keys('WEB-5489'), 'execute', TEST_PROFILE), 'feature/WEB-5489');
  assert.equal(suggestBranch(keys('CORE-580', 'CORE-581'), 'custom', TEST_PROFILE), 'dev');
  assert.equal(suggestBranch([], 'execute', TEST_PROFILE), 'dev');
});

test('suggestBranch keeps questions and reading docs on dev', () => {
  const tickets = [ticketFromKey('APP-9355', TEST_PROFILE)];
  assert.equal(suggestBranch(tickets, 'question', TEST_PROFILE), 'dev');
  assert.equal(suggestBranch(tickets, 'docs', TEST_PROFILE), 'dev');
});

test('directionBranch is null without a branch in the profile', () => {
  const { branch: _branch, ...withoutBranch } = TEST_PROFILE;
  assert.equal(directionBranch([ticketFromKey('APP-1', TEST_PROFILE)], withoutBranch), null);
  assert.equal(directionBranch([ticketFromKey('APP-1', TEST_PROFILE)], null), null);
});

test('suggestBranch falls back to main without a profile', () => {
  assert.equal(suggestBranch([ticketFromKey('APP-1', TEST_PROFILE)], 'execute', null), 'main');
  assert.equal(suggestBranch([], 'question', null), 'main');
});

test('isBranchName accepts feature branches and refuses what a shell or git would choke on', () => {
  for (const name of ['dev', 'feature/APP-9355_WEB-5586', 'release/1.2']) assert.equal(isBranchName(name), true, name);
  for (const name of ['', '-x', 'a b', 'a;rm', 'a..b', 'a//b', 'a/', 'a.', 'a.lock', '$(x)', "a'b"]) assert.equal(isBranchName(name), false, name);
});

test('activeRuns are the unfinished ones, oldest first', () => {
  const run = (id: string, startedAt: string, finishedAt?: string): AgentRun => ({
    id,
    template: 'execute',
    branch: 'dev',
    title: id,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
  });
  const runs = [run('b', iso(5, 12)), run('a', iso(5, 10)), run('c', iso(5, 9), iso(5, 11))];
  assert.deepEqual(
    activeRuns(runs).map(r => r.id),
    ['a', 'b'],
  );
});

function agentState(): WorklogState {
  const events = Array.from({ length: 7 }, (_, i) => event(`e${i}`, iso(5, 9 + i), `событие ${i}`));
  const storage = dir('d1', {
    title: 'Браузерные сторы',
    status: 'waiting',
    waitingFor: 'аналитика',
    tickets: [ticketFromKey('APP-9618', TEST_PROFILE), ticketFromKey('WEB-5742', TEST_PROFILE)],
    links: [{ title: 'Теханализ', url: 'https://wiki.example.com/x', kind: 'confluence', description: 'что решили\nи почему' }],
    events: [events[3], events[0], events[6], events[1], events[5], events[2], events[4]],
  });
  return state({
    directions: [storage, dir('d2', { title: 'Другое' })],
    todos: [
      todo('t1', { text: 'Разобрать обёртки', directionId: 'd1', requestedBy: 'Олега' }),
      todo('t2', { text: 'Закрытое', directionId: 'd1', done: true }),
      todo('t3', { text: 'Чужое', directionId: 'd2' }),
      todo('t4', { text: 'Без направления' }),
    ],
    notes: [
      {
        id: 'n1',
        title: 'Ключи app.*',
        body: 'общий origin у US',
        directionIds: ['d1'],
        files: [{ path: 'libs/x.ts', line: 4 }],
        urls: [],
        createdAt: iso(1, 9),
        updatedAt: iso(1, 9),
      },
    ],
  });
}

test('agentContext of a direction: its tickets, links, the last five events in order, open todos and notes', () => {
  const context = agentContext(agentState(), { directionId: 'd1' });
  assert.equal(context.direction?.id, 'd1');
  assert.equal(context.todo, undefined);
  assert.deepEqual(
    context.events.map(e => e.id),
    ['e2', 'e3', 'e4', 'e5', 'e6'],
  );
  assert.deepEqual(
    context.todos.map(t => t.id),
    ['t1'],
  );
  assert.deepEqual(
    context.notes.map(n => n.id),
    ['n1'],
  );
});

test('agentContext of a todo brings its direction without the todo itself; a lone todo brings nothing', () => {
  const ofTodo = agentContext(agentState(), { todoId: 't1' });
  assert.equal(ofTodo.todo?.id, 't1');
  assert.equal(ofTodo.direction?.id, 'd1');
  assert.deepEqual(ofTodo.todos, []);
  const lone = agentContext(agentState(), { todoId: 't4' });
  assert.equal(lone.direction, undefined);
  assert.deepEqual([lone.tickets, lone.links, lone.events, lone.todos, lone.notes], [[], [], [], [], []]);
});

test('agentRunTitle names the todo or the direction and the template', () => {
  const s = agentState();
  assert.equal(agentRunTitle(agentContext(s, { directionId: 'd1' }), 'decompose'), 'Браузерные сторы · декомпозировать');
  assert.equal(agentRunTitle(agentContext(s, { todoId: 't1' }), 'execute'), 'Разобрать обёртки · выполнить задачу');
});

const ALL_PARTS: AgentRequest['include'] = ['tickets', 'links', 'events', 'todos', 'notes'];

test('agentPrompt holds the task, the chosen context, the extra text and the rules with the run id', () => {
  const prompt = agentPrompt(agentState(), { template: 'decompose', directionId: 'd1', include: ALL_PARTS, extra: '  без кода  ', branch: 'feature/APP-9618_WEB-5742' }, 'run1', TEST_PROFILE);
  assert.match(prompt, /^# Задание\nДекомпозируй задачу на дела/);
  assert.match(prompt, /Направление в Worklog: «Браузерные сторы» \(id d1\), статус «Жду», жду: аналитика, этап «В работе»\./);
  assert.match(prompt, /- APP-9618 \(App\): https:\/\/jira\.example\.com\/browse\/APP-9618/);
  assert.match(prompt, /- Теханализ: https:\/\/wiki\.example\.com\/x\n {2}что решили\n {2}и почему/);
  assert.match(prompt, /событие 6/);
  assert.doesNotMatch(prompt, /событие 1/);
  assert.match(prompt, /- «Разобрать обёртки» \(просил Олега\)/);
  assert.match(prompt, /### Ключи app\.\*\nобщий origin у US\nСсылки: libs\/x\.ts:4/);
  assert.match(prompt, /## Дополнительный контекст\nбез кода\n/);
  assert.match(prompt, /переключись на ветку `feature\/APP-9618_WEB-5742`; если её нет ни локально, ни в origin — `git fetch origin dev` и создай её от `origin\/dev`/);
  assert.match(prompt, /незакоммиченные изменения, остановись и спроси меня/);
  assert.match(prompt, /`~\/.local\/bin\/worklog note list --dir d1`/);
  assert.match(prompt, /`--dir d1`/);
  assert.match(prompt, /`~\/.local\/bin\/worklog agent done run1`\.\n$/);
});

test('agentPrompt leaves out unchecked and empty parts; on dev it only switches', () => {
  const prompt = agentPrompt(agentState(), { template: 'question', todoId: 't4', include: ALL_PARTS, extra: 'Как устроен X?', branch: 'dev' }, 'r', TEST_PROFILE);
  assert.match(prompt, /Дело: «Без направления»\./);
  for (const heading of ['Тикеты', 'Ссылки', 'Последние события', 'Открытые дела', 'Заметки', 'Направление в Worklog']) assert.doesNotMatch(prompt, new RegExp(heading));
  assert.match(prompt, /Затем переключись на `dev`\./);
  assert.doesNotMatch(prompt, /--dir/);
  const unchecked = agentPrompt(agentState(), { template: 'execute', directionId: 'd1', include: ['tickets'], extra: '', branch: 'dev' }, 'r', TEST_PROFILE);
  assert.match(unchecked, /## Тикеты/);
  assert.doesNotMatch(unchecked, /## Ссылки|## Дополнительный контекст|## Заметки/);
});

test('parseRepeatDays: day, weekdays, a list of days; anything else is null', () => {
  assert.deepEqual(parseRepeatDays('day'), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.deepEqual(parseRepeatDays('weekdays'), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(parseRepeatDays('thu, Mon'), ['mon', 'thu']);
  assert.equal(parseRepeatDays('mon,funday'), null);
  assert.equal(parseRepeatDays(''), null);
});

test('parseTime: H:MM, HH:MM and a dot instead of the colon give HH:MM; anything else is null', () => {
  assert.equal(parseTime('12:00'), '12:00');
  assert.equal(parseTime(' 9.05 '), '09:05');
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('12:60'), null);
  assert.equal(parseTime('12'), null);
  assert.equal(parseTime(''), null);
});

test('repeatLabel names the days the way they are said', () => {
  assert.equal(repeatLabel(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), 'каждый день');
  assert.equal(repeatLabel(['mon', 'tue', 'wed', 'thu', 'fri']), 'по будням');
  assert.equal(repeatLabel(['mon']), 'по понедельникам');
  assert.equal(repeatLabel(['thu', 'mon']), 'пн, чт');
});

test('repeatDayOf maps Sunday to sun and Monday to mon', () => {
  assert.equal(repeatDayOf(new Date(2026, 10, 8)), 'sun');
  assert.equal(repeatDayOf(new Date(2026, 10, 9)), 'mon');
});

test('dueRepeats: rules of the weekday not applied today, with their open todo', () => {
  const rule = (id: string, patch: Partial<RepeatRule> = {}): RepeatRule => ({ id, text: id, days: ['mon'], createdAt: iso(1, 9), ...patch });
  const rules = [rule('fresh'), rule('applied', { lastOn: '2026-11-09' }), rule('yesterday', { lastOn: '2026-11-02' }), rule('tuesday', { days: ['tue'] })];
  const todos = [todo('old', { repeatId: 'yesterday' }), todo('closed', { repeatId: 'fresh', done: true, doneAt: iso(2, 9) })];
  const steps = dueRepeats(rules, todos, '2026-11-09', 'mon');
  assert.deepEqual(
    steps.map(s => [s.rule.id, s.open?.id ?? null]),
    [
      ['fresh', null],
      ['yesterday', 'old'],
    ],
  );
});

// --- stands, builds and Jira ---

import type { Ticket } from './model.ts';
import { envPlatforms, envSegments, envUrl, jiraTicketKeys } from './model.ts';

function jiraTicket(key: string, segments?: string[]): Ticket {
  const ticket = ticketFromKey(key, TEST_PROFILE);
  return segments === undefined ? ticket : { ...ticket, jira: { status: 'Open', segments, at: '2026-11-06T09:00:00.000Z' } };
}

test('envUrl applies the replacements of its row in order', () => {
  assert.equal(envUrl('App', 'stand', 'EU', 'a__b c', TEST_PROFILE), 'https://a-b c.app.eu.example.com');
  assert.equal(envUrl('App', 'build', 'EU', 'a b/c', TEST_PROFILE), 'https://ci.example.com/job/App/job/a%20b%252Fc');
});

test('envSegments follows Segment of the platform tickets', () => {
  const segments = (tickets: Ticket[]) => envSegments(tickets, 'App', TEST_PROFILE);
  assert.deepEqual(segments([jiraTicket('APP-1')]), ['EU', 'US']);
  assert.deepEqual(segments([jiraTicket('APP-1', [])]), ['EU', 'US']);
  assert.deepEqual(segments([jiraTicket('APP-1', ['US', 'EU', 'IN'])]), ['EU', 'US']);
  assert.deepEqual(segments([jiraTicket('APP-1', ['ZZ'])]), []);
  assert.deepEqual(segments([jiraTicket('APP-1', ['EU']), jiraTicket('APP-2', ['US'])]), ['EU', 'US']);
  assert.deepEqual(segments([jiraTicket('APP-1', ['EU']), jiraTicket('WEB-1', ['US'])]), ['EU']);
});

test('envPlatforms lists platforms with tickets in the profile order', () => {
  assert.deepEqual(envPlatforms([jiraTicket('APP-1'), jiraTicket('CRM-2')], TEST_PROFILE), ['App']);
  assert.deepEqual(envPlatforms([jiraTicket('WEB-1'), jiraTicket('APP-1')], TEST_PROFILE), ['App', 'Web']);
  assert.deepEqual(envPlatforms([jiraTicket('CRM-2')], TEST_PROFILE), []);
});

test('jiraTicketKeys skips done directions and repeats', () => {
  const at = '2026-11-01T09:00:00.000Z';
  const dir = (id: string, status: Direction['status'], keys: string[]): Direction => ({
    id,
    title: id,
    status,
    tickets: keys.map(key => ticketFromKey(key, TEST_PROFILE)),
    links: [],
    events: [],
    order: 0,
    createdAt: at,
    updatedAt: at,
  });
  assert.deepEqual(jiraTicketKeys([dir('a', 'in_progress', ['APP-1', 'WEB-2']), dir('b', 'testing', ['APP-1']), dir('c', 'done', ['APP-3'])]), ['APP-1', 'WEB-2']);
});

// --- merge requests ---

import { mergeRequestNumber, mergeRequestsOf, mergeRequestUrl } from './model.ts';

test('mergeRequestsOf: MR links in the order they were added, each MR once', () => {
  const mr = (url: string) => ({ title: url, url, kind: detectLinkKind(url, TEST_PROFILE) });
  const links = [
    mr('https://wiki.example.com/pages/viewpage.action?pageId=1'),
    mr('https://git.example.com/team/app/-/merge_requests/4022/diffs'),
    mr('https://git.example.com/team/app/-/merge_requests/3983'),
    mr('https://git.example.com/team/app/-/merge_requests/4022'),
  ];
  assert.deepEqual(mergeRequestsOf(links), [
    { id: 4022, url: 'https://git.example.com/team/app/-/merge_requests/4022/diffs' },
    { id: 3983, url: 'https://git.example.com/team/app/-/merge_requests/3983' },
  ]);
  assert.deepEqual(mergeRequestsOf([]), []);
});

test('mergeRequestUrl and mergeRequestNumber go both ways', () => {
  assert.equal(mergeRequestUrl(4022, TEST_PROFILE), 'https://git.example.com/team/app/-/merge_requests/4022');
  assert.equal(mergeRequestNumber('https://git.example.com/team/app/-/merge_requests/4022'), 4022);
  assert.equal(mergeRequestNumber('https://git.example.com/team/app/-/merge_requests/4022/diffs?commit_id=1'), 4022);
  assert.equal(mergeRequestNumber('https://git.example.com/team/app/-/merge_requests/40221'), 40221);
  assert.equal(mergeRequestNumber('https://git.example.com/team/app/-/merge_requests'), null);
  assert.equal(mergeRequestNumber('https://jira.example.com/browse/APP-1'), null);
});

// --- stage of a direction and the stage from Jira ---

import type { Stage } from './model.ts';
import { directionStage, dropIntent, jiraStage, stageOfJiraStatus } from './model.ts';

function statusTicket(key: string, status?: string): Ticket {
  return { ...ticketFromKey(key, TEST_PROFILE), ...(status === undefined ? {} : { jira: { status, segments: [], at: iso(1, 9) } }) };
}

test('stageOfJiraStatus maps by name and by prefix', () => {
  const jira = TEST_PROFILE.jira;
  assert.ok(jira);
  const cases: [string, Stage | null][] = [
    ['In QA', 'testing'],
    [' closed ', 'done'],
    ['Open', 'in_progress'],
    ['Pause TA', 'in_progress'],
    ['Unknown', null],
    ['', null],
  ];
  for (const [status, stage] of cases) assert.equal(stageOfJiraStatus(status, jira), stage, status);
});

test('jiraStage takes the most behind ticket of the profile projects and skips others and unknown statuses', () => {
  const stage = (tickets: Ticket[], current: Stage) => jiraStage(tickets, current, TEST_PROFILE);
  assert.equal(stage([], 'testing'), null);
  assert.equal(stage([statusTicket('APP-1')], 'testing'), null);
  assert.equal(stage([statusTicket('CRM-1', 'In QA')], 'in_progress'), null);
  assert.equal(stage([statusTicket('APP-1', 'Reopened')], 'testing'), null);
  assert.equal(stage([statusTicket('APP-1', 'In Review'), statusTicket('WEB-2', 'In QA')], 'in_progress'), 'in_review');
  assert.equal(stage([statusTicket('APP-1', 'Blocked'), statusTicket('WEB-2', 'In QA')], 'in_progress'), 'testing');
  assert.equal(stage([statusTicket('APP-1', 'Closed'), statusTicket('WEB-2', 'Closed'), statusTicket('CRM-3', 'Open')], 'testing'), 'done');
});

test('jiraStage ignores tickets of projects outside the profile', () => {
  assert.equal(jiraStage([statusTicket('APP-1', 'Closed'), statusTicket('OPS-2')], 'testing', TEST_PROFILE), 'done');
});

test('jiraStage is null without Jira in the profile', () => {
  const { jira: _jira, ...withoutJira } = TEST_PROFILE;
  assert.equal(jiraStage([statusTicket('APP-1', 'Closed')], 'testing', withoutJira), null);
  assert.equal(jiraStage([statusTicket('APP-1', 'Closed')], 'testing', null), null);
});

test('jiraStage keeps the stage instead of done while a ticket is not known', () => {
  assert.equal(jiraStage([statusTicket('APP-1', 'Closed'), statusTicket('WEB-2', 'Reopened')], 'testing', TEST_PROFILE), 'testing');
  assert.equal(jiraStage([statusTicket('APP-1', 'Closed'), statusTicket('WEB-2')], 'awaiting_release', TEST_PROFILE), 'awaiting_release');
});

test('directionStage reads stage, falls back to the status and to В работе under a mark', () => {
  assert.equal(directionStage(dir('a', { status: 'testing' })), 'testing');
  assert.equal(directionStage(dir('a', { status: 'waiting' })), 'in_progress');
  assert.equal(directionStage(dir('a', { status: 'parked' })), 'in_progress');
  assert.equal(directionStage(dir('a', { status: 'waiting', stage: 'in_review' })), 'in_review');
});

test('dropIntent: a Jira-led direction keeps its stage column, takes marks and leaves a mark for its stage', () => {
  const manual = dir('m', { status: 'waiting', stage: 'testing' });
  const led = dir('j', { status: 'testing', stage: 'testing', stageFromJira: true });
  const ledWaiting = dir('w', { status: 'waiting', stage: 'testing', stageFromJira: true });
  assert.equal(dropIntent(manual, 'in_review'), 'move');
  assert.equal(dropIntent(led, 'testing'), 'move');
  assert.equal(dropIntent(led, 'in_review'), null);
  assert.equal(dropIntent(led, 'waiting'), 'move');
  assert.equal(dropIntent(led, 'parked'), 'move');
  assert.equal(dropIntent(ledWaiting, 'in_progress'), 'unmark');
  assert.equal(dropIntent(ledWaiting, 'testing'), 'unmark');
  assert.equal(dropIntent(ledWaiting, 'waiting'), 'move');
  assert.equal(dropIntent(ledWaiting, 'parked'), 'move');
});

// --- daily and prompt texts for the stage ---

import type { Status } from './model.ts';
import { markClearedText } from './model.ts';
import { TEST_PROFILE } from './test-profile.ts';

function jiraEvent(id: string, when: string, text: string, kind: WorkEvent['kind']): WorkEvent {
  return { id, at: when, text, source: 'jira', kind };
}

test('markClearedText', () => {
  assert.equal(markClearedText('waiting', 'девопсы'), 'Больше не жду: девопсы');
  assert.equal(markClearedText('waiting', undefined), 'Больше не жду');
  assert.equal(markClearedText('parked', undefined), 'Вернул из отложенных');
});

test('templateText puts the neutral stage phrase before ticket lines', () => {
  const d = withTickets('u', 'Унификация', ['APP-1'], {
    events: [jiraEvent('1', iso(5, 9), 'Статус: В работе', 'status'), jiraEvent('2', iso(5, 9), 'APP-1: In QA → Ready For Dev', 'jira-status')],
  });
  const digest = periodDigest(state({ directions: [d] }), iso(4, 11, 30), null, '2026-11-05');
  assert.equal(templateText(digest), 'Касаемо задачи «Унификация»: Вернулась в работу. APP-1: In QA → Ready For Dev.\n1. APP-1');
});

test('templateText: Jira stage phrases are neutral, a lone Jira «В работе» is not «Взял в работу задачу»', () => {
  const stages: [Status, string][] = [
    ['in_review', 'В мерж реквесте'],
    ['testing', 'Тестирование'],
    ['awaiting_release', 'Ждёт релиза'],
    ['done', 'Готово'],
    ['in_progress', 'В работе'],
  ];
  const directions = stages.map(([status, label], order) => dir(status, { title: label, status, order, events: [jiraEvent(status, iso(5, 9 + order), `Статус: ${label}`, 'status')] }));
  const digest = periodDigest(state({ directions }), iso(4, 11, 30), null, '2026-11-05');
  assert.equal(
    templateText(digest),
    [
      'Касаемо задачи «В мерж реквесте»: Ушла на код-ревью.',
      'Касаемо задачи «Тестирование»: Ушла в тестирование.',
      'Касаемо задачи «Ждёт релиза»: Ждёт релиза.',
      'Касаемо задачи «Готово»: Закрыта.',
      'Касаемо задачи «В работе»: Вернулась в работу.',
    ].join('\n\n'),
  );
});

test('agentPrompt names the stage under a mark', () => {
  const base = agentState();
  const marked = state({ directions: base.directions.map(d => (d.id === 'd1' ? { ...d, stage: 'testing' } : d)) });
  const prompt = agentPrompt(marked, { template: 'question', directionId: 'd1', include: [], extra: '', branch: 'dev' }, 'r', TEST_PROFILE);
  assert.match(prompt, /статус «Жду», жду: аналитика, этап «Тестирование»\./);
  const plain = state({ directions: [dir('d3', { title: 'Простое', status: 'testing' })] });
  assert.match(agentPrompt(plain, { template: 'question', directionId: 'd3', include: [], extra: '', branch: 'dev' }, 'r', TEST_PROFILE), /статус «Тестирование»\.\n/);
});

import { countEventsAfter as countAfter, exampleData, firstStepsDone, jiraTicketKeys as jiraKeys, onboardingPrompts, periodDigest as digestOf } from './model.ts';

const AT = '2026-11-13T09:00:00.000Z';

function ownDirection(id: string, fields: Partial<Direction> = {}): Direction {
  return { id, title: id, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: AT, updatedAt: AT, ...fields };
}

function onboardingState(directions: Direction[], todos: WorklogState['todos'] = []): WorklogState {
  return { ...EMPTY_STATE, directions, todos };
}

test('exampleData builds a marked direction with fake tickets, links, events, a todo and a note', () => {
  let n = 0;
  const { direction, todo, note } = exampleData(TEST_PROFILE, AT, () => `id${n++}`);
  assert.equal(direction.example, true);
  assert.match(direction.title, /^Пример: /);
  assert.equal(direction.status, 'in_progress');
  assert.deepEqual(direction.tickets.map(t => [t.key, t.platform, t.url]), [['APP-1001', 'App', ''], ['WEB-1002', 'Web', '']]);
  assert.ok(direction.links.length >= 4);
  for (const link of direction.links) assert.match(new URL(link.url).host, /(^|\.)(example\.com|figma\.com)$/);
  assert.ok(direction.events.length >= 3 && direction.events.every(e => e.source === 'manual' && e.at <= AT));
  assert.equal(todo.directionId, direction.id);
  assert.ok(todo.requestedBy);
  assert.deepEqual(note.directionIds, [direction.id]);
  assert.equal(new Set([direction.id, todo.id, note.id, ...direction.events.map(e => e.id)]).size, 3 + direction.events.length);
});

test('exampleData without a profile uses neutral keys', () => {
  let n = 0;
  const { direction } = exampleData(null, AT, () => `x${n++}`);
  assert.deepEqual(direction.tickets.map(t => t.key), ['PROJ-1001', 'PROJ-1002']);
});

test('firstStepsDone ignores the example', () => {
  let n = 0;
  const example = exampleData(TEST_PROFILE, AT, () => `e${n++}`);
  const withExample = onboardingState([example.direction], [example.todo]);
  assert.deepEqual(firstStepsDone(withExample), { direction: false, event: false, todo: false });

  const quiet = ownDirection('own', { events: [{ id: 's', at: AT, text: 'Статус', source: 'system', kind: 'status' }, { id: 'j', at: AT, text: 'Jira', source: 'jira', kind: 'jira-status' }] });
  assert.deepEqual(firstStepsDone(onboardingState([example.direction, quiet], [example.todo])), { direction: true, event: false, todo: false });

  const told = ownDirection('own', { events: [{ id: 'c', at: AT, text: 'Сказал агенту', source: 'claude', kind: 'note' }] });
  const todo = { id: 't', text: 'Дело', done: false, createdAt: AT };
  assert.deepEqual(firstStepsDone(onboardingState([example.direction, told], [example.todo, todo])), { direction: true, event: true, todo: true });
});

test('onboardingPrompts take the prefixes from the profile and the name of the first own direction', () => {
  let n = 0;
  const example = exampleData(TEST_PROFILE, AT, () => `e${n++}`).direction;
  const fresh = onboardingPrompts(TEST_PROFILE, [example]);
  assert.equal(fresh.direction, 'заведи в worklog направление по задачам APP-1234 и WEB-567');
  assert.equal(fresh.event, 'запиши в worklog по капче: бэк поправил редирект, жду стенд');
  assert.equal(fresh.link, 'добавь в worklog к капче ссылку на макет: <ссылка>');
  assert.equal(fresh.todo, 'добавь в worklog дело: завести задачу на бэк, просил аналитик');
  assert.equal(fresh.repeat, 'добавь в worklog повторяющееся дело: дейлик каждый будний день в 11:30');

  const own = onboardingPrompts(TEST_PROFILE, [example, ownDirection('theme', { title: 'Тёмная тема' }), ownDirection('old', { title: 'Старое', status: 'done', order: -1 })]);
  assert.equal(own.event, 'запиши в worklog по направлению «Тёмная тема»: бэк поправил редирект, жду стенд');
  assert.equal(own.link, 'добавь в worklog к направлению «Тёмная тема» ссылку на макет: <ссылка>');

  assert.equal(onboardingPrompts(null, []).direction, 'заведи в worklog направление по задачам PROJ-1234 и PROJ-567');
});

test('periodDigest, countEventsAfter and jiraTicketKeys leave the example out', () => {
  let n = 0;
  const { direction, todo } = exampleData(TEST_PROFILE, AT, () => `e${n++}`);
  const waiting = { ...direction, id: 'waiting-example', status: 'waiting' as const, waitingFor: 'дизайнер' };
  const due = { ...todo, due: '2026-11-13' };
  const state = onboardingState([direction, waiting], [due]);
  const digest = digestOf(state, '2026-11-01T00:00:00.000Z', null, '2026-11-13');
  assert.deepEqual(digest.groups, []);
  assert.deepEqual(digest.waiting, []);
  assert.deepEqual(digest.today.directions, []);
  assert.deepEqual(digest.today.todos, []);
  assert.equal(digest.eventCount, 0);
  assert.equal(countAfter(state, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), 0);
  assert.deepEqual(jiraKeys(state.directions), []);
});
