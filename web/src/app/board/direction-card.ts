import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { AgentRun, Direction } from '@worklog/model';
import { directionStage, isExample, markOf, STATUS_LABELS } from '@worklog/model';
import { runSince } from '../agent/run-since';
import { Clock } from '../core/clock';
import { DropHint } from '../core/drop-hint';
import { LINK_ICONS } from '../core/link-icons';
import { plural } from '../core/plural';
import type { TodoStats } from '../core/worklog-store';
import { Favicon } from '../favicon/favicon';
import { Tooltip } from '../tooltip/tooltip';

@Component({
  selector: 'wl-direction-card',
  imports: [Favicon, Tooltip],
  templateUrl: './direction-card.html',
  styleUrl: './direction-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'wl-direction-card',
    '[attr.data-direction-id]': 'direction().id',
    '[class.wl-direction-card_target]': 'targeted()',
    tabindex: '0',
    role: 'button',
    '(click)': 'opened.emit()',
    '(keydown.enter)': 'opened.emit()',
  },
})
export class DirectionCard {
  private readonly clock = inject(Clock);
  private readonly dropHint = inject(DropHint);

  readonly direction = input.required<Direction>();
  readonly stats = input<TodoStats>();
  /** the agent working on it */
  readonly run = input<AgentRun>();
  readonly opened = output();

  /** a dragged todo would be linked to it */
  protected readonly targeted = computed(() => {
    const target = this.dropHint.target();
    return target?.kind === 'direction' && target.directionId === this.direction().id;
  });
  protected readonly example = computed(() => isExample(this.direction()));
  protected readonly links = computed(() => this.direction().links.map(link => ({ ...link, icon: LINK_ICONS[link.kind].icon })));
  protected readonly waitingFor = computed(() => {
    const direction = this.direction();
    return direction.status === 'waiting' ? (direction.waitingFor ?? '') : '';
  });
  /** under a mark the column does not tell the stage */
  protected readonly stage = computed(() => {
    const direction = this.direction();
    return markOf(direction.status) === null ? '' : STATUS_LABELS[directionStage(direction)];
  });
  protected readonly agent = computed(() => {
    const run = this.run();
    return run === undefined ? '' : `✦ агент работает · ${runSince(run, this.clock.today())}`;
  });
  protected readonly badge = computed(() => {
    const stats = this.stats();
    if (stats === undefined || stats.count === 0) return '';
    const count = `${stats.count} ${plural(stats.count, { one: 'дело', few: 'дела', many: 'дел' })}`;
    return stats.requesters.length === 0 ? count : `${count} · от ${stats.requesters.join(', ')}`;
  });
}
