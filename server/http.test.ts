import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataError } from './fs-utils.ts';
import { HttpError, errorAnswer } from './http.ts';
import { NotFoundError, ValidationError } from './store.ts';

test('errorAnswer maps known errors to their status and text', () => {
  assert.deepEqual(errorAnswer(new HttpError(409, 'Конфликт')), { status: 409, message: 'Конфликт', logged: false });
  assert.deepEqual(errorAnswer(new ValidationError('Пусто')), { status: 400, message: 'Пусто', logged: false });
  assert.deepEqual(errorAnswer(new NotFoundError('Нет')), { status: 404, message: 'Нет', logged: false });
});

test('errorAnswer keeps a data error text and hides other faults', () => {
  assert.deepEqual(errorAnswer(new DataError('Повреждён файл данных: x.json')), {
    status: 500,
    message: 'Повреждён файл данных: x.json',
    logged: true,
  });
  assert.deepEqual(errorAnswer(new Error('EACCES: /Users/me/secret')), { status: 500, message: 'Внутренняя ошибка сервера', logged: true });
  assert.deepEqual(errorAnswer('строка'), { status: 500, message: 'Внутренняя ошибка сервера', logged: true });
});
