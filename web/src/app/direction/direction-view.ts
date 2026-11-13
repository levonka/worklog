import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import type { JiraHealth, Mark, Stage, Status } from '@worklog/model';
import { directionBranch, directionStage, isJiraLed, MARKS, mergeRequestNumber, mergeRequestsOf, normalizeTicketKey, STAGES, STATUS_LABELS, ticketKeyExamples } from '@worklog/model';
import { runSince } from '../agent/run-since';
import { AgentSheet } from '../core/agent-sheet';
import { Clock } from '../core/clock';
import { JiraHealthStore } from '../core/jira-health';
import { ProfileStore } from '../core/profile-store';
import { statusDot } from '../core/status-dot';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Favicon } from '../favicon/favicon';
import { TodoList } from '../todos/todo-list';
import { clearUntilFailed } from '../core/clear-until-failed';
import { DirectionNotes } from '../knowledge/direction-notes';
import { DirectionLinks } from './direction-links';
import { DirectionMenu } from './direction-menu';
import { BranchLine } from './branch-line';
import { EnvLinks } from './env-links';
import { EventFeed } from './event-feed';
import { JiraStatus } from './jira-status';
import { inBackground } from '../core/background';

/** Projected content goes to the end of the header: the pane puts its own controls there */
@Component({
  selector: 'wl-direction-view',
  imports: [BranchLine, DirectionLinks, DirectionMenu, DirectionNotes, EnvLinks, EventFeed, Favicon, JiraStatus, NgTemplateOutlet, TodoList],
  templateUrl: './direction-view.html',
  styleUrl: './direction-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-direction-view', '[attr.data-direction-view]': 'directionId()' },
})
export class DirectionView {
  private readonly store = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);
  private readonly clock = inject(Clock);
  private readonly agentSheet = inject(AgentSheet);
  private readonly jira = inject(JiraHealthStore);
  private readonly profiles = inject(ProfileStore);
  private readonly document = inject(DOCUMENT);
  private readonly titleEditor = viewChild<ElementRef<HTMLInputElement>>('titleEditor');

  readonly directionId = input.required<string>();

  protected readonly direction = computed(() => this.store.directionById(this.directionId()));
  protected readonly branch = computed(() => {
    const direction = this.direction();
    return direction === undefined ? null : directionBranch(direction.tickets, this.profiles.profile());
  });
  protected readonly keyExample = computed(() => ticketKeyExamples(this.profiles.profile())[0]);
  protected readonly mergeRequests = computed(() => mergeRequestsOf(this.direction()?.links ?? []));
  protected readonly dot = computed(() => {
    const status = this.tabs.view(`direction:${this.directionId()}`).status;
    return status === null ? null : statusDot(status);
  });
  protected readonly run = computed(() => this.store.runOfDirection(this.directionId()));
  protected readonly runSince = computed(() => {
    const run = this.run();
    return run === undefined ? '' : runSince(run, this.clock.today());
  });
  protected readonly stages = STAGES.map(stage => ({ stage, label: STATUS_LABELS[stage] }));
  protected readonly marks = MARKS.map(mark => ({ mark, label: STATUS_LABELS[mark] }));
  protected readonly stage = computed(() => {
    const direction = this.direction();
    return direction === undefined ? null : directionStage(direction);
  });
  protected readonly jiraLed = computed(() => {
    const direction = this.direction();
    return direction !== undefined && isJiraLed(direction);
  });
  // only this window's own request: a background poll sends no word when it ends without changes
  protected readonly jiraBusy = this.jira.refreshing;
  protected readonly jiraProblem = computed(() => {
    const state = this.jira.health()?.state;
    return state === 'error' || state === 'off';
  });
  protected readonly jiraTitle = computed(() => jiraTitle(this.jira.health()));

  protected readonly renaming = signal(false);
  protected readonly ticketInvalid = signal(false);

  constructor() {
    afterRenderEffect(() => {
      const editor = this.titleEditor()?.nativeElement;
      editor?.focus();
      editor?.select();
    });
  }

  protected removeExample(id: string): void {
    inBackground(this.store.deleteDirection(id));
  }

  // a click that ends selecting part of the title is for copying it
  protected startRenaming(): void {
    if (this.document.getSelection()?.toString()) return;
    this.renaming.set(true);
  }

  /** Enter and leaving the field save, Escape only closes it */
  protected rename(raw: string): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    const title = raw.trim();
    if (title === '' || title === this.direction()?.title) return;
    inBackground(this.store.renameDirection(this.directionId(), title));
  }

  protected refreshJira(): void {
    inBackground(this.jira.refresh());
  }

  protected openAgentSheet(): void {
    this.agentSheet.open({ directionId: this.directionId() });
  }

  protected finishAgent(id: string): void {
    inBackground(this.store.finishAgent(id));
  }

  protected setStage(stage: Stage): void {
    if (this.jiraLed()) return;
    this.moveTo(stage);
  }

  protected toggleMark(mark: Mark): void {
    if (this.direction()?.status === mark) inBackground(this.store.clearMark(this.directionId()));
    else this.moveTo(mark);
  }

  private moveTo(status: Status): void {
    if (this.direction()?.status === status) return;
    // as on the server when no index is given: the direction goes to the end of its new column
    const end = this.store.state().directions.filter(direction => direction.status === status).length;
    inBackground(this.store.moveDirection(this.directionId(), status, end));
  }

  /** Leaving the field saves it (Enter leaves it too); an empty field clears it */
  protected saveWaitingFor(raw: string): void {
    const trimmed = raw.trim();
    const waitingFor = trimmed === '' ? null : trimmed;
    if (waitingFor === (this.direction()?.waitingFor ?? null)) return;
    inBackground(this.store.setWaitingFor(this.directionId(), waitingFor));
  }

  protected cancelWaitingFor(field: HTMLInputElement): void {
    field.value = this.direction()?.waitingFor ?? '';
    field.blur();
  }

  protected addTicket(field: HTMLInputElement): void {
    const raw = field.value.trim();
    if (raw === '') return;
    const key = normalizeTicketKey(raw);
    this.ticketInvalid.set(key === null);
    if (key !== null) clearUntilFailed([field], this.store.addTicket(this.directionId(), key));
  }

  protected removeTicket(key: string): void {
    inBackground(this.store.removeTicket(this.directionId(), key));
  }

  /** the MR's own page and its diffs or commits pages alike */
  protected removeMergeRequest(id: number): void {
    const urls = (this.direction()?.links ?? []).filter(link => mergeRequestNumber(link.url) === id).map(link => link.url);
    inBackground(this.removeLinks(urls));
  }

  private async removeLinks(urls: readonly string[]): Promise<void> {
    for (const url of urls) await this.store.removeLink(this.directionId(), url);
  }
}

const TIME_FORMAT = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });

/** «Jira: истёк или неверный токен · статусы на 10:42» */
function jiraTitle(health: JiraHealth | null): string {
  if (health === null || health.state === 'ok') return 'Обновить статусы Jira';
  const since = health.checkedAt === null ? '' : ` · статусы на ${TIME_FORMAT.format(new Date(health.checkedAt))}`;
  return `Jira: ${health.message ?? 'нет ответа'}${since}`;
}
