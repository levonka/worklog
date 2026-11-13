import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
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
  event: { label: 'Запишите, что произошло', prompts: ['event'], tourStep: 'events' },
  todo: { label: 'Добавьте дело', prompts: ['todo', 'repeat'], tourStep: 'todos' },
};

/** while something is left to do and the user has not hidden the block */
export function firstStepsShown(state: WorklogState): boolean {
  if (state === EMPTY_STATE || state.onboarding?.stepsHidden === true) return false;
  const done = firstStepsDone(state);
  return FIRST_STEPS.some(step => !done[step]);
}

/** «Первые шаги» on the board: three things to do, each with phrases for the agent */
@Component({
  selector: 'wl-first-steps',
  imports: [Prompt],
  templateUrl: './first-steps.html',
  styleUrl: './first-steps.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-first-steps' },
})
export class FirstSteps {
  private readonly worklog = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  private readonly tour = inject(Tour);

  protected readonly shown = computed(() => firstStepsShown(this.worklog.state()));
  protected readonly items = computed<Item[]>(() => {
    const state = this.worklog.state();
    const done = firstStepsDone(state);
    const prompts = onboardingPrompts(this.profiles.profile(), state.directions);
    return FIRST_STEPS.map(step => ({ step, label: ITEMS[step].label, done: done[step], prompts: ITEMS[step].prompts.map(key => prompts[key]) }));
  });
  protected readonly doneCount = computed(() => this.items().filter(item => item.done).length);
  protected readonly total = FIRST_STEPS.length;

  protected show(step: FirstStep): void {
    this.tour.show(ITEMS[step].tourStep);
  }

  protected hide(): void {
    inBackground(this.worklog.setOnboarding({ stepsHidden: true }));
  }
}
