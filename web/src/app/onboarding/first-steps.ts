import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, signal } from '@angular/core';
import type { FirstStep, OnboardingPrompts, WorklogState } from '@worklog/model';
import { EMPTY_STATE, FIRST_STEPS, firstStepsDone, onboardingPrompts } from '@worklog/model';
import { inBackground } from '../core/background';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { Prompt } from './prompt';
import { Tour } from './tour';
import type { TourStepId } from './tour-steps';

interface Item {
  step: FirstStep;
  label: string;
  done: boolean;
  prompts: string[];
}

const ITEMS: Record<FirstStep, { label: string; prompts: readonly (keyof OnboardingPrompts)[]; tourStep: TourStepId }> = {
  direction: { label: 'Заведите своё направление', prompts: ['direction'], tourStep: 'add' },
  tabs: { label: 'Разложите вкладки Chrome по направлениям', prompts: ['tabs'], tourStep: 'chrome-tabs' },
  event: { label: 'Запишите, что произошло', prompts: ['event'], tourStep: 'events' },
  todo: { label: 'Добавьте дело', prompts: ['todo', 'repeat'], tourStep: 'todos' },
};

function allDone(state: WorklogState): boolean {
  const done = firstStepsDone(state);
  return FIRST_STEPS.every(step => done[step]);
}

/** while something is left to do, the user has not hidden the steps and has never done them all */
export function firstStepsShown(state: WorklogState): boolean {
  if (state === EMPTY_STATE || state.onboarding?.stepsHidden === true || state.onboarding?.stepsDoneAt !== undefined) return false;
  return !allDone(state);
}

/** «Первые шаги» in the corner: a button with the progress that unfolds the steps, each with phrases for the agent */
@Component({
  selector: 'wl-first-steps',
  imports: [Prompt],
  templateUrl: './first-steps.html',
  styleUrl: './first-steps.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'wl-first-steps',
    '(document:keydown.escape)': 'fold()',
    '(document:pointerdown)': 'foldOutside($event)',
  },
})
export class FirstSteps {
  private readonly worklog = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  private readonly tour = inject(Tour);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly shown = computed(() => firstStepsShown(this.worklog.state()));
  protected readonly open = signal(false);
  protected readonly items = computed<Item[]>(() => {
    const state = this.worklog.state();
    const done = firstStepsDone(state);
    const prompts = onboardingPrompts(this.profiles.profile(), state.directions);
    return FIRST_STEPS.map(step => ({ step, label: ITEMS[step].label, done: done[step], prompts: ITEMS[step].prompts.map(key => prompts[key]) }));
  });
  protected readonly doneCount = computed(() => this.items().filter(item => item.done).length);
  protected readonly total = FIRST_STEPS.length;
  protected readonly progress = computed(() => this.doneCount() / this.total);
  private doneSent = false;

  constructor() {
    // remembered once: the steps stay gone even when the data later undoes one of them
    effect(() => {
      const state = this.worklog.state();
      if (this.doneSent || state === EMPTY_STATE || state.onboarding?.stepsDoneAt !== undefined || !allDone(state)) return;
      this.doneSent = true;
      inBackground(this.worklog.setOnboarding({ stepsDone: true }));
    });
  }

  protected toggle(): void {
    this.open.update(open => !open);
  }

  protected fold(): void {
    this.open.set(false);
  }

  protected foldOutside(event: Event): void {
    if (this.open() && event.target instanceof Node && !this.host.nativeElement.contains(event.target)) this.fold();
  }

  protected show(step: FirstStep): void {
    this.fold();
    this.tour.show(ITEMS[step].tourStep);
  }

  protected hide(): void {
    this.fold();
    inBackground(this.worklog.setOnboarding({ stepsHidden: true }));
  }
}
