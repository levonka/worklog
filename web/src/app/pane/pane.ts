import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, inject, input, untracked, viewChild } from '@angular/core';
import type { AfterRenderRef, ElementRef } from '@angular/core';
import { EMPTY_STATE } from '@worklog/model';
import { Board } from '../board/board';
import { DailyView } from '../daily/daily-view';
import { DoneView } from '../done/done-view';
import { HistoryView } from '../history/history-view';
import { KnowledgeView } from '../knowledge/knowledge-view';
import type { TabId } from '../core/tabs-layout';
import { directionIdOf } from '../core/tabs-layout';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { DirectionView } from '../direction/direction-view';
import { TodoList } from '../todos/todo-list';
import { takeScroll } from '../update/scroll-keep';

@Component({
  selector: 'wl-pane',
  imports: [NgTemplateOutlet, Board, TodoList, DirectionView, DailyView, HistoryView, DoneView, KnowledgeView],
  templateUrl: './pane.html',
  styleUrl: './pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-pane', '[attr.data-tab-id]': 'tabId()', '(pointerdown)': 'tabs.focus(tabId())', '(focusin)': 'tabs.focus(tabId())' },
})
export class Pane {
  protected readonly tabs = inject(TabsStore);
  private readonly store = inject(WorklogStore);
  private readonly document = inject(DOCUMENT);

  readonly tabId = input.required<TabId>();

  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');

  protected readonly view = computed(() => this.tabs.view(this.tabId()));
  protected readonly kind = computed(() => {
    const id = this.tabId();
    return id === 'board' || id === 'todos' || id === 'daily' || id === 'history' || id === 'done' || id === 'knowledge' ? id : 'direction';
  });
  /** the one direction of a direction tab, as a list to key its view by */
  protected readonly directionIds = computed(() => {
    const id = directionIdOf(this.tabId());
    return id === null ? [] : [id];
  });
  // a tab is shown in one pane at most, so being the split tab means being the right pane
  protected readonly isRight = computed(() => this.tabs.layout().split === this.tabId());

  constructor() {
    // after the reload into a new version: back to where the pane was, once its content is there
    const restore: AfterRenderRef = afterRenderEffect(() => {
      if (this.store.state() === EMPTY_STATE) return;
      restore.destroy();
      const body = this.body().nativeElement;
      try {
        const storage = this.document.defaultView?.sessionStorage;
        const top = storage === undefined ? null : takeScroll(storage, untracked(this.tabId));
        if (top !== null) body.scrollTop = top;
      } catch {
        // storage unavailable: the pane starts at the top
      }
    });
  }
}
