import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Direction } from '../shared/model.ts';
import { ticketFromKey } from '../shared/model.ts';
import { resolveDirection } from './resolve.ts';
import { NotFoundError, ValidationError } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

function direction(id: string, title: string, keys: string[] = []): Direction {
  return {
    id,
    title,
    status: 'in_progress',
    tickets: keys.map(key => ticketFromKey(key, TEST_PROFILE)),
    links: [],
    events: [],
    order: 0,
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
  };
}

const directions = [
  direction('abc123', 'Браузерные сторы'),
  direction('def456', 'Сео-текст на матчах', ['APP-9355']),
  direction('ghi789', 'Сео-ссылки'),
];

test('resolves by exact id', () => {
  assert.equal(resolveDirection(directions, 'def456').id, 'def456');
});

test('resolves by ticket key, case-insensitively', () => {
  assert.equal(resolveDirection(directions, 'app-9355').id, 'def456');
});

test('resolves a single title substring ignoring case', () => {
  assert.equal(resolveDirection(directions, 'сторы').id, 'abc123');
  assert.equal(resolveDirection(directions, 'БРАУЗЕРНЫЕ').id, 'abc123');
});

test('ambiguous title substring lists every candidate', () => {
  assert.throws(
    () => resolveDirection(directions, 'сео'),
    error =>
      error instanceof ValidationError &&
      error.message === 'Неоднозначно: сео — Сео-текст на матчах (def456); Сео-ссылки (ghi789)',
  );
});

test('finished directions drop out of an ambiguous match unless only they match', () => {
  const list = [
    { ...direction('a1', 'Сео старое', ['APP-1']), status: 'done' as const },
    direction('a2', 'Сео новое', ['APP-1']),
    { ...direction('a3', 'Пуши раз'), status: 'done' as const },
    { ...direction('a4', 'Пуши два'), status: 'done' as const },
  ];
  assert.equal(resolveDirection(list, 'сео').id, 'a2');
  assert.equal(resolveDirection(list, 'APP-1').id, 'a2');
  assert.throws(() => resolveDirection(list, 'пуши'), /Неоднозначно: пуши — Пуши раз \(a3\); Пуши два \(a4\)/);
  assert.equal(resolveDirection(list, 'a1').id, 'a1');
});

test('unknown ref throws NotFoundError with the ref', () => {
  assert.throws(
    () => resolveDirection(directions, 'нет такого'),
    error => error instanceof NotFoundError && error.message === 'Направление не найдено: нет такого',
  );
});

test('a ticket-shaped ref without a matching ticket falls back to titles then not found', () => {
  assert.throws(() => resolveDirection(directions, 'APP-1'), NotFoundError);
});

test('trims spaces around an id and a ticket key', () => {
  assert.equal(resolveDirection(directions, '  def456 ').id, 'def456');
  assert.equal(resolveDirection(directions, ' app-9355  ').id, 'def456');
});

test('an empty ref is not found', () => {
  assert.throws(() => resolveDirection(directions, '  '), NotFoundError);
});

test('resolveDirection finds the example only by id', () => {
  const own = direction('own', 'Капча', ['APP-1']);
  const example: Direction = { ...direction('example', 'Пример: капча на входе', ['APP-1001']), example: true };
  assert.equal(resolveDirection([example, own], 'капч').id, 'own');
  assert.throws(() => resolveDirection([example, own], 'APP-1001'), NotFoundError);
  assert.throws(() => resolveDirection([example, own], 'пример'), NotFoundError);
  assert.equal(resolveDirection([example, own], 'example').id, 'example');
});
