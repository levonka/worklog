import type { Direction, Profile, Ticket } from '@worklog/model';
import { compareText, doneDateOf } from '@worklog/model';

export const MONTH_NAMES: readonly string[] = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTH_SHORT: readonly string[] = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** after a day number: «1 мая» */
const DATE_MONTHS: readonly string[] = MONTH_SHORT.map(name => (name === 'май' ? 'мая' : name));

export interface DoneRow {
  direction: Direction;
  doneAt: string;
  platforms: string | null;
  tickets: number;
}

export interface DoneMonth {
  year: number;
  /** 0–11 */
  month: number;
  rows: DoneRow[];
  tickets: number;
}

/** the profile's project labels the tickets have, in the profile's order */
export function platformLabel(tickets: readonly Ticket[], profile: Profile | null): string | null {
  const names = (profile?.projects ?? []).map(project => project.label).filter(label => tickets.some(t => t.platform === label));
  return names.length === 0 ? null : names.join(' · ');
}

function doneRows(directions: readonly Direction[], profile: Profile | null): DoneRow[] {
  return directions
    .filter(d => d.status === 'done')
    .map(direction => ({ direction, doneAt: doneDateOf(direction), platforms: platformLabel(direction.tickets, profile), tickets: direction.tickets.length }))
    .sort((a, b) => compareText(b.doneAt, a.doneAt));
}

export function doneYears(directions: readonly Direction[]): number[] {
  return [...new Set(doneRows(directions, null).map(row => new Date(row.doneAt).getFullYear()))];
}

function matches(row: DoneRow, needle: string): boolean {
  return [row.direction.title, ...row.direction.tickets.map(t => t.key)].some(text => text.toLowerCase().includes(needle));
}

export function doneMonths(directions: readonly Direction[], scope: { year: number } | { query: string }, profile: Profile | null): DoneMonth[] {
  const needle = 'query' in scope ? scope.query.trim().toLowerCase() : '';
  const months: DoneMonth[] = [];
  for (const row of doneRows(directions, profile)) {
    const date = new Date(row.doneAt);
    if ('year' in scope ? date.getFullYear() !== scope.year : !matches(row, needle)) continue;
    let month = months.at(-1);
    if (month === undefined || month.year !== date.getFullYear() || month.month !== date.getMonth()) {
      month = { year: date.getFullYear(), month: date.getMonth(), rows: [], tickets: 0 };
      months.push(month);
    }
    month.rows.push(row);
    month.tickets += row.tickets;
  }
  return months;
}

export function monthBars(months: readonly DoneMonth[], year: number): number[] {
  const bars = MONTH_NAMES.map(() => 0);
  for (const month of months) if (month.year === year) bars[month.month] += month.rows.length;
  return bars;
}

export function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${DATE_MONTHS[date.getMonth()]}`;
}
