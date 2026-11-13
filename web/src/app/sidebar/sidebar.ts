import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { BOARD_STATUSES, DAILY_HOUR, DAILY_MINUTE, FIRST_STEPS, firstStepsDone, withScheme } from '@worklog/model';
import type { TabId } from '../core/tabs-layout';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Favicon } from '../favicon/favicon';
import { LinkDescription } from '../link-description/link-description';
import { Tour } from '../onboarding/tour';
import { inBackground } from '../core/background';

export const ICON_COLORS = ['#3b82f6', '#7c3aed', '#e24329', '#0f766e', '#d97706', '#db2777', '#64748b', '#0ea5e9'] as const;

const NAV_TABS = ['todos', 'board', 'daily', 'history', 'done', 'knowledge'] as const;
type NavTab = (typeof NAV_TABS)[number];
const DAILY_LABEL = `${DAILY_HOUR}:${String(DAILY_MINUTE).padStart(2, '0')}`;

interface NavItem {
  id: TabId;
  title: string;
  icon: string | null;
  count: number;
  open: boolean;
}

function iconLetter(title: string): string {
  return (Array.from(title.trim())[0] ?? '?').toUpperCase();
}

function iconColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) | 0;
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

@Component({
  selector: 'wl-sidebar',
  imports: [Favicon, LinkDescription],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-sidebar' },
})
export class Sidebar {
  private readonly worklog = inject(WorklogStore);
  protected readonly tabs = inject(TabsStore);
  private readonly tour = inject(Tour);

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('linkTitle');
  protected readonly addingTo = signal<string | null>(null);
  /** the link whose description is unfolded under it, as `groupId url` */
  protected readonly infoKey = signal<string | null>(null);
  protected readonly editingInfo = signal(false);
  // a second Enter while the link is being saved would add it twice
  private readonly saving = signal(false);

  protected readonly nav = computed<NavItem[]>(() => {
    const open = this.tabs.layout().tabs;
    const columns = this.worklog.columns();
    const counts: Record<NavTab, number> = {
      todos: this.worklog.openTodos().length,
      board: BOARD_STATUSES.reduce((sum, status) => sum + columns[status].length, 0),
      daily: 0,
      history: 0,
      done: 0,
      knowledge: 0,
    };
    return NAV_TABS.map(id => {
      const view = this.tabs.view(id);
      const title = id === 'daily' ? `${view.title} · ${DAILY_LABEL}` : view.title;
      return { id, ...view, title, count: counts[id], open: open.includes(id) };
    });
  });

  protected readonly groups = computed(() =>
    this.worklog.state().linkGroups.map(group => ({
      ...group,
      links: group.links.map(link => ({ ...link, key: `${group.id} ${link.url}`, letter: iconLetter(link.title), color: iconColor(link.title) })),
    })),
  );

  constructor() {
    afterRenderEffect(() => this.titleInput()?.nativeElement.focus());
  }

  /** the tour again, and the first steps back while something in them is left */
  protected startTour(): void {
    const done = firstStepsDone(this.worklog.state());
    if (this.worklog.onboarding().stepsHidden === true && FIRST_STEPS.some(step => !done[step])) {
      inBackground(this.worklog.setOnboarding({ stepsHidden: false }));
    }
    this.tour.start();
  }

  protected startAdding(groupId: string): void {
    this.addingTo.set(this.addingTo() === groupId ? null : groupId);
  }

  protected cancelAdding(): void {
    this.addingTo.set(null);
  }

  protected add(groupId: string, groupTitle: string, title: string, url: string): void {
    const name = title.trim();
    const address = url.trim();
    if (name === '' || address === '' || this.saving()) return;
    this.saving.set(true);
    const saved = this.worklog.addQuickLink(groupTitle, name, withScheme(address)).then(() => {
      if (this.addingTo() === groupId) this.addingTo.set(null);
    });
    inBackground(saved.finally(() => this.saving.set(false)));
  }

  /** a link with no description opens straight into its field */
  protected toggleInfo(key: string, empty: boolean): void {
    const closing = this.infoKey() === key;
    this.infoKey.set(closing ? null : key);
    this.editingInfo.set(!closing && empty);
  }

  protected closeEditing(empty: boolean): void {
    this.editingInfo.set(false);
    if (empty) this.infoKey.set(null);
  }

  protected saveDescription(groupId: string, url: string, text: string): void {
    this.editingInfo.set(false);
    if (text === '') this.infoKey.set(null);
    inBackground(this.worklog.setQuickLinkDescription(groupId, url, text === '' ? null : text));
  }

  protected remove(groupId: string, url: string): void {
    inBackground(this.worklog.removeQuickLink(groupId, url));
  }
}
