import type { AgentRun } from '@worklog/model';

const TIME = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });

/** «с 14:20», with the date when the run started before `today` */
export function runSince(run: AgentRun, today: Date): string {
  const started = new Date(run.startedAt);
  const time = TIME.format(started);
  return started.getTime() >= today.getTime() ? `с ${time}` : `с ${DAY.format(started).replace(/\.$/, '')} ${time}`;
}
