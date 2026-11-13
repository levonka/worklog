import type { Direction } from '../shared/model.ts';
import { normalizeTicketKey, ownDirections } from '../shared/model.ts';
import { NotFoundError, ValidationError } from './store.ts';

export function resolveDirection(directions: Direction[], ref: string): Direction {
  const query = ref.trim();
  const byId = directions.find(d => d.id === query);
  if (byId) return byId;

  // the onboarding example answers only to its id: «по капче» means the user's own captcha
  const own = ownDirections(directions);
  const key = normalizeTicketKey(query);
  if (key) {
    const byTicket = own.filter(d => d.tickets.some(t => t.key === key));
    if (byTicket.length > 0) return single(byTicket, ref);
  }

  const needle = query.toLowerCase();
  const byTitle = needle === '' ? [] : own.filter(d => d.title.toLowerCase().includes(needle));
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
