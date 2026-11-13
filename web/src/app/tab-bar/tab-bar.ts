import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import type { CdkDragDrop, CdkDragMove } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { TabId } from '../core/tabs-layout';
import { statusDot } from '../core/status-dot';
import { TabsStore } from '../core/tabs-store';
import { UpdateButton } from '../update/update-button';

interface Point {
  x: number;
  y: number;
}

interface Zone {
  left: number;
  top: number;
  width: number;
  height: number;
}

function contains(zone: Zone, point: Point): boolean {
  return point.x >= zone.left && point.x <= zone.left + zone.width && point.y >= zone.top && point.y <= zone.top + zone.height;
}

@Component({
  selector: 'wl-tab-bar',
  imports: [CdkDropList, CdkDrag, UpdateButton],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-tab-bar' },
})
export class TabBar {
  protected readonly tabs = inject(TabsStore);

  /** The panes area: dropping a tab on its right third opens the tab in the right pane */
  readonly contentArea = input.required<HTMLElement>();

  protected readonly items = computed(() => {
    const layout = this.tabs.layout();
    return layout.tabs.map(id => {
      const view = this.tabs.view(id);
      return { id, ...view, dot: view.status === null ? null : statusDot(view.status), shown: id === layout.active || id === layout.split };
    });
  });

  // set only while a tab that can move to the right pane is being dragged
  protected readonly splitZone = signal<Zone | null>(null);
  protected readonly overSplitZone = signal(false);

  protected dragStarted(id: TabId): void {
    const layout = this.tabs.layout();
    // the left pane has to keep some other tab
    if (layout.tabs.length < 2 || layout.split === id) return;
    const area = this.contentArea().getBoundingClientRect();
    this.splitZone.set({ left: area.left + (area.width * 2) / 3, top: area.top, width: area.width / 3, height: area.height });
  }

  protected dragMoved(event: CdkDragMove): void {
    const zone = this.splitZone();
    this.overSplitZone.set(zone !== null && contains(zone, event.pointerPosition));
  }

  protected dropped(event: CdkDragDrop<unknown, unknown, TabId>): void {
    const zone = this.splitZone();
    this.splitZone.set(null);
    this.overSplitZone.set(false);
    if (zone !== null && contains(zone, event.dropPoint)) this.tabs.splitRight(event.item.data);
    else this.tabs.reorderTabs(event.previousIndex, event.currentIndex);
  }

  // Enter on the close button bubbles up here too: only the tab itself activates
  protected activate(event: Event, id: TabId): void {
    if (event.target === event.currentTarget) this.tabs.openTab(id);
  }

  protected closeByKey(event: Event, id: TabId): void {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    this.tabs.closeTab(id);
  }

  protected close(event: Event, id: TabId): void {
    event.stopPropagation();
    this.tabs.closeTab(id);
  }
}
