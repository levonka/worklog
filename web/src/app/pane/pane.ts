import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Board } from '../board/board';
import { DailyView } from '../daily/daily-view';
import { DoneView } from '../done/done-view';
import { HistoryView } from '../history/history-view';
import { KnowledgeView } from '../knowledge/knowledge-view';
import type { TabId } from '../core/tabs-layout';
import { directionIdOf } from '../core/tabs-layout';
import { TabsStore } from '../core/tabs-store';
import { DirectionView } from '../direction/direction-view';
import { TodoList } from '../todos/todo-list';

@Component({
  selector: 'wl-pane',
  imports: [NgTemplateOutlet, Board, TodoList, DirectionView, DailyView, HistoryView, DoneView, KnowledgeView],
  templateUrl: './pane.html',
  styleUrl: './pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-pane', '(pointerdown)': 'tabs.focus(tabId())', '(focusin)': 'tabs.focus(tabId())' },
})
export class Pane {
  protected readonly tabs = inject(TabsStore);

  readonly tabId = input.required<TabId>();

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
}
