import type { Direction } from '../shared/model.ts';
import { normalizeTicketKey } from '../shared/model.ts';
import { NotFoundError, ValidationError } from './store.ts';

export function resolveDirection(directions: Direction[], ref: string): Direction {
  const query = ref.trim();
  const byId = directions.find(d => d.id === query);
  if (byId) return byId;

  const key = normalizeTicketKey(query);
  if (key) {
    const byTicket = directions.filter(d => d.tickets.some(t => t.key === key));
    if (byTicket.length > 0) return single(byTicket, ref);
  }

  const needle = query.toLowerCase();
  const byTitle = needle === '' ? [] : directions.filter(d => d.title.toLowerCase().includes(needle));
  if (byTitle.length === 0) throw new NotFoundError(`Направление не найдено: ${ref}`);
  return single(byTitle, ref);
}

// finished directions only compete when nothing else matches
function single(candidates: Direction[], ref: string): Direction {
  const active = candidates.filter(d => d.status !== 'done');
  const pool = active.length > 0 ? active : candidates;
  const [first] = pool;
  if (pool.length === 1) return first;
  throw new ValidationError(`Неоднозначно: ${ref} — ${pool.map(d => `${d.title} (${d.id})`).join('; ')}`);
}
