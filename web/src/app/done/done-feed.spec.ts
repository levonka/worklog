import type { Direction } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { doneMonths, doneYears, monthBars, platformLabel, shortDate } from './done-feed';
import { TEST_PROFILE } from '@worklog/test-profile';

const on = (year: number, month: number, day: number, hour = 12, minute = 0): string => new Date(year, month, day, hour, minute).toISOString();

function direction(id: string, fields: Partial<Direction> = {}): Direction {
  return { id, title: id, status: 'done', tickets: [], links: [], events: [], order: 0, createdAt: on(2026, 0, 1), updatedAt: on(2026, 0, 1), ...fields };
}

const tickets = (...keys: string[]) => keys.map(key => ticketFromKey(key, TEST_PROFILE));

const DIRECTIONS: Direction[] = [
  direction('reg', { title: 'Экран успешной регистрации', doneAt: on(2025, 11, 26), tickets: tickets('APP-6339', 'WEB-3683') }),
  direction('promo', { title: 'Промокоды в боттомшите', doneAt: on(2026, 3, 9), tickets: tickets('APP-5563', 'APP-6923', 'APP-6924') }),
  direction('traffic', { title: 'Источник трафика', doneAt: on(2026, 9, 30), tickets: tickets('APP-9352', 'WEB-5581') }),
  direction('twofa', { title: 'Развитие 2FA', doneAt: on(2026, 9, 22), tickets: tickets('APP-7098', 'WEB-4332', 'APP-9438') }),
  direction('stores', { title: 'Браузерные сторы', status: 'in_progress', tickets: tickets('APP-6120') }),
];

describe('done-feed', () => {
  it('platformLabel joins labels in the profile order and skips other platforms', () => {
    expect(platformLabel(tickets('WEB-1', 'APP-1'), TEST_PROFILE)).toBe('App · Web');
    expect(platformLabel(tickets('WEB-1'), TEST_PROFILE)).toBe('Web');
    expect(platformLabel(tickets('CRM-15486'), TEST_PROFILE)).toBeNull();
    expect(platformLabel([], TEST_PROFILE)).toBeNull();
    expect(platformLabel(tickets('APP-1', 'APP-2', 'CRM-1'), TEST_PROFILE)).toBe('App');
    expect(platformLabel(tickets('APP-1'), null)).toBeNull();
  });

  it('doneYears lists years of done directions, newest first', () => {
    expect(doneYears(DIRECTIONS)).toEqual([2026, 2025]);
  });

  it('doneMonths by year: newest month first, rows newest first, tickets summed', () => {
    const months = doneMonths(DIRECTIONS, { year: 2026 }, TEST_PROFILE);
    expect(months.map(m => m.month)).toEqual([9, 3]);
    expect(months[0].year).toBe(2026);
    expect(months[0].rows.map(r => r.direction.id)).toEqual(['traffic', 'twofa']);
    expect(months[0].tickets).toBe(5);
    expect(months[0].rows[0]).toEqual({ direction: DIRECTIONS[2], doneAt: on(2026, 9, 30), platforms: 'App · Web', tickets: 2 });
    expect(months.flatMap(m => m.rows.map(r => r.direction.id))).not.toContain('stores');
  });

  it('doneMonths groups by local month', () => {
    const early = direction('early', { doneAt: on(2026, 9, 1, 0, 30) });
    expect(doneMonths([early], { year: 2026 }, TEST_PROFILE).map(m => m.month)).toEqual([9]);
  });

  it('doneMonths falls back to doneDateOf for old directions without doneAt', () => {
    const old = direction('old', { updatedAt: on(2026, 4, 3) });
    expect(doneMonths([old], { year: 2026 }, TEST_PROFILE)[0].rows[0].doneAt).toBe(on(2026, 4, 3));
  });

  it('doneMonths by query looks through every year by title and ticket key', () => {
    expect(doneMonths(DIRECTIONS, { query: 'app-5563' }, TEST_PROFILE).flatMap(m => m.rows.map(r => r.direction.id))).toEqual(['promo']);
    expect(doneMonths(DIRECTIONS, { query: 'РЕГИСТРАЦ' }, TEST_PROFILE).map(m => [m.year, m.month])).toEqual([[2025, 11]]);
    expect(doneMonths(DIRECTIONS, { query: '  ' }, TEST_PROFILE).map(m => [m.year, m.month])).toEqual([
      [2026, 9],
      [2026, 3],
      [2025, 11],
    ]);
    expect(doneMonths(DIRECTIONS, { query: 'нет такого' }, TEST_PROFILE)).toEqual([]);
  });

  it('monthBars counts directions of each month of the year', () => {
    const bars = monthBars(doneMonths(DIRECTIONS, { year: 2026 }, TEST_PROFILE), 2026);
    expect(bars).toHaveLength(12);
    expect(bars[3]).toBe(1);
    expect(bars[9]).toBe(2);
    expect(bars.filter((_, i) => i !== 3 && i !== 9).every(n => n === 0)).toBe(true);
  });

  it('shortDate gives day and short month in the genitive', () => {
    expect(shortDate(on(2026, 9, 30))).toBe('30 окт');
    expect(shortDate(on(2026, 4, 1))).toBe('1 мая');
  });
});
