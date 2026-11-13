import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { Agent, AgentContext, AgentContextPart, AgentSheetTemplate, BranchPlace } from '@worklog/model';
import { AGENT_CONTEXT_PARTS, AGENT_LABELS, AGENT_TEMPLATE_LABELS, AGENTS, AGENT_SHEET_TEMPLATES, AGENT_TEMPLATES_NEEDING_EXTRA, agentContext, baseBranch, isBranchName, isExample, suggestBranch, TERMINAL_OPEN_LABELS } from '@worklog/model';
import { firstValueFrom } from 'rxjs';
import type { AgentTarget } from '../core/agent-sheet';
import { AgentSheet } from '../core/agent-sheet';
import type { AgentLauncher } from '../core/api';
import { ApiClient } from '../core/api';
import { messageOf } from '../core/error-message';
import { plural } from '../core/plural';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';

const PART_LABELS: Record<AgentContextPart, string> = {
  tickets: 'Тикеты',
  links: 'Ссылки',
  events: 'Лента',
  todos: 'Дела',
  notes: 'Знания',
};

const EXTRA_PLACEHOLDERS: Record<AgentSheetTemplate, string> = {
  execute: 'Что важно учесть: с чего начать, чего не трогать…',
  decompose: 'Как делить: по сервисам, по платформам, без кода…',
  docs: 'Что именно искать…',
  question: 'Вопрос',
  custom: 'Что сделать',
};

const BRANCH_HINTS: Record<BranchPlace, (base: string) => string> = {
  local: () => 'есть локально',
  remote: () => 'есть в origin',
  none: base => `будет создана от ${base}`,
};

// the branch field is checked once typing pauses
const BRANCH_CHECK_MS = 250;
const SHOWN_ITEMS = 2;

interface PartRow {
  part: AgentContextPart;
  label: string;
  summary: string;
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, SHOWN_ITEMS).join(', ');
  return items.length > SHOWN_ITEMS ? `${shown} и ещё ${items.length - SHOWN_ITEMS}` : shown;
}

function partSummary(part: AgentContextPart, context: AgentContext): string {
  switch (part) {
    case 'tickets':
      return `${context.tickets.map(t => (t.platform === 'other' ? t.key : `${t.key} (${t.platform})`)).join(', ')} — агент откроет их сам`;
    case 'links':
      return listed(context.links.map(l => l.title));
    case 'events':
      return context.events.length === 1 ? 'последнее событие' : `последние ${context.events.length} ${plural(context.events.length, { one: 'событие', few: 'события', many: 'событий' })}`;
    case 'todos':
      return listed(context.todos.map(t => `«${t.text}»`));
    case 'notes':
      return listed(context.notes.map(n => n.title));
  }
}

function partCount(part: AgentContextPart, context: AgentContext): number {
  return context[part].length;
}

/** The task window: template, context from the card, extra text, branch; «Запустить» opens a Warp tab */
@Component({
  selector: 'wl-agent-sheet',
  templateUrl: './agent-sheet.html',
  styleUrl: './agent-sheet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-agent-sheet' },
})
export class AgentSheetView {
  private readonly store = inject(WorklogStore);
  private readonly api = inject(ApiClient);
  private readonly sheet = inject(AgentSheet);
  private readonly profiles = inject(ProfileStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly extraField = viewChild.required<ElementRef<HTMLTextAreaElement>>('extraField');

  readonly target = input.required<AgentTarget>();

  protected readonly templates = AGENT_SHEET_TEMPLATES.map(template => ({ template, label: AGENT_TEMPLATE_LABELS[template] }));
  protected readonly template = signal<AgentSheetTemplate>('execute');
  protected readonly off = signal<ReadonlySet<AgentContextPart>>(new Set());
  protected readonly extra = signal('');
  // null: the field follows the template and the tickets
  private readonly typedBranch = signal<string | null>(null);
  protected readonly branchPlace = signal<BranchPlace | null>(null);
  protected readonly sending = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly context = computed(() => agentContext(this.store.state(), this.target()));
  protected readonly subject = computed(() => this.context().todo?.text ?? this.context().direction?.title ?? '');
  protected readonly gone = computed(() => this.context().todo === undefined && this.context().direction === undefined);
  protected readonly parts = computed<PartRow[]>(() => {
    const context = this.context();
    return AGENT_CONTEXT_PARTS.filter(part => partCount(part, context) > 0).map(part => ({ part, label: PART_LABELS[part], summary: partSummary(part, context) }));
  });
  private readonly base = computed(() => baseBranch(this.profiles.profile()));
  private readonly launcher = signal<AgentLauncher | null>(null);
  private readonly pickedAgent = signal<Agent | null>(rememberedAgent());
  protected readonly agentLabels = AGENT_LABELS;
  /** the switch shows only when there is a choice */
  protected readonly agents = computed(() => this.launcher()?.agents ?? []);
  protected readonly agent = computed(() => {
    const launcher = this.launcher();
    if (launcher === null) return null;
    const picked = this.pickedAgent();
    return picked !== null && launcher.agents.includes(picked) ? picked : launcher.defaultAgent;
  });
  /** the onboarding example shows the window but runs nothing */
  protected readonly forExample = computed(() => {
    const direction = this.context().direction;
    return direction !== undefined && isExample(direction);
  });
  protected readonly launchHint = computed(() => {
    if (this.forExample()) return 'в примере агент не запускается';
    const launcher = this.launcher();
    return launcher === null ? null : `Откроется ${TERMINAL_OPEN_LABELS[launcher.terminal]}, ${launcher.codeRoot}`;
  });
  protected readonly branch = computed(() => this.typedBranch() ?? suggestBranch(this.context().tickets, this.template(), this.profiles.profile()));
  protected readonly branchValid = computed(() => isBranchName(this.branch().trim()));
  protected readonly branchHint = computed(() => {
    if (!this.branchValid()) return 'некорректное имя ветки';
    if (this.branch().trim() === this.base()) return 'без ветки задачи';
    const place = this.branchPlace();
    return place === null ? '' : BRANCH_HINTS[place](this.base());
  });
  protected readonly needsExtra = computed(() => AGENT_TEMPLATES_NEEDING_EXTRA.includes(this.template()));
  protected readonly placeholder = computed(() => EXTRA_PLACEHOLDERS[this.template()]);
  protected readonly canLaunch = computed(
    () => !this.forExample() && !this.sending() && !this.gone() && this.branchValid() && (!this.needsExtra() || this.extra().trim() !== ''),
  );

  constructor() {
    firstValueFrom(this.api.agentLauncher()).then(
      launcher => this.launcher.set(launcher),
      () => undefined,
    );
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.extraField().nativeElement.focus();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asked = 0;
    effect(() => {
      const name = this.branch().trim();
      const valid = this.branchValid();
      clearTimeout(timer);
      this.branchPlace.set(null);
      if (!valid || name === this.base()) return;
      const request = ++asked;
      timer = setTimeout(() => {
        firstValueFrom(this.api.branchPlace(name)).then(
          answer => {
            if (request === asked) this.branchPlace.set(answer.place);
          },
          () => undefined,
        );
      }, BRANCH_CHECK_MS);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }

  protected isOn(part: AgentContextPart): boolean {
    return !this.off().has(part);
  }

  protected togglePart(part: AgentContextPart): void {
    const off = new Set(this.off());
    if (off.has(part)) off.delete(part);
    else off.add(part);
    this.off.set(off);
  }

  protected setBranch(raw: string): void {
    this.typedBranch.set(raw);
  }

  protected close(): void {
    this.sheet.close();
  }

  /** the dialog's own Escape: the sheet goes away with the component */
  protected cancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  protected launchByKey(event: KeyboardEvent): void {
    if (!event.metaKey || event.key !== 'Enter') return;
    event.preventDefault();
    this.launch();
  }

  protected pickAgent(agent: Agent): void {
    this.pickedAgent.set(agent);
  }

  protected launch(): void {
    if (!this.canLaunch()) return;
    const { directionId, todoId } = this.target();
    const agent = this.agents().length > 1 ? this.agent() : null;
    if (agent !== null) rememberAgent(agent);
    this.sending.set(true);
    this.failure.set(null);
    this.store
      .startAgent({
        template: this.template(),
        ...(directionId === undefined ? {} : { directionId }),
        ...(todoId === undefined ? {} : { todoId }),
        include: this.parts()
          .map(row => row.part)
          .filter(part => this.isOn(part)),
        extra: this.extra(),
        branch: this.branch().trim(),
        ...(agent === null ? {} : { agent }),
      })
      .then(
        () => this.close(),
        error => {
          this.sending.set(false);
          this.failure.set(messageOf(error, 'Не удалось запустить агента'));
        },
      );
  }
}

const AGENT_KEY = 'worklog.agent';

function rememberedAgent(): Agent | null {
  try {
    const saved = localStorage.getItem(AGENT_KEY);
    return AGENTS.find(agent => agent === saved) ?? null;
  } catch {
    return null;
  }
}

function rememberAgent(agent: Agent): void {
  try {
    localStorage.setItem(AGENT_KEY, agent);
  } catch {
    // a closed storage only loses the remembered choice
  }
}
