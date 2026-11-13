import type { OnboardingPrompts } from '@worklog/model';

export const TOUR_STEP_IDS = ['welcome', 'board', 'add', 'card', 'todos', 'drag', 'direction', 'events', 'agent', 'menu', 'tabs', 'daily', 'safety'] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

export type TourScreen = 'board' | 'todos' | 'daily' | 'direction';
export const TOUR_DEMOS = ['todo-card', 'tab-split'] as const;
export type TourDemoKind = (typeof TOUR_DEMOS)[number];

/** the card of the tour's direction instead of a `data-tour` mark */
export const DIRECTION_CARD = 'direction-card';

export interface TourStep {
  id: TourStepId;
  screen: TourScreen | null;
  /** the `data-tour` value of the element the bubble points at; null: the bubble stands in the middle */
  target: string | null;
  title: string;
  text: string;
  prompts?: readonly (keyof OnboardingPrompts)[];
  demo?: TourDemoKind;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    screen: null,
    target: null,
    title: 'Это Worklog',
    text: 'Здесь живёт ваша работа: направления с тикетами, ссылками и лентой событий, дела и текст к дейлику. Главный путь — короткие фразы агенту в любой сессии, он сам раскладывает их сюда; кнопки окна — запасной путь.',
  },
  {
    id: 'board',
    screen: 'board',
    target: 'board-columns',
    title: 'Доска',
    text: 'Колонки — этапы направлений. Если у направления есть тикеты Jira, этап приходит оттуда сам. «Жду» и «Отложено» — пометки поверх этапа, их ставите вы, перетащив карточку.',
  },
  {
    id: 'add',
    screen: 'board',
    target: 'board-add',
    title: 'Новое направление',
    text: 'Направление — задача или тема, которую вы ведёте. Заведите его кнопкой «＋» или фразой агенту:',
    prompts: ['direction'],
  },
  {
    id: 'card',
    screen: 'board',
    target: DIRECTION_CARD,
    title: 'Карточка',
    text: 'На карточке — тикеты, иконки ссылок и число дел. Наведите на иконку — появится название, нажмите — откроется ссылка. Нажмите на карточку, чтобы открыть направление во вкладке.',
  },
  {
    id: 'todos',
    screen: 'todos',
    target: 'todo-input',
    title: 'Дела',
    text: 'Один список дел на всё. Впишите дело в строку или скажите агенту — он запишет и от кого оно, и повторяющееся дело по расписанию:',
    prompts: ['todo', 'repeat'],
  },
  {
    id: 'drag',
    screen: 'board',
    target: DIRECTION_CARD,
    title: 'Дело ↔ направление',
    text: 'Перетащите дело на карточку — оно привяжется к направлению. Карточку можно бросить и на дело. Попробуйте сами.',
    demo: 'todo-card',
  },
  {
    id: 'direction',
    screen: 'direction',
    target: 'direction-links',
    title: 'Направление',
    text: 'Внутри — тикеты, ветка и стенды, ссылки, заметки и дела направления. Ссылку проще всего добавить фразой агенту:',
    prompts: ['link'],
  },
  {
    id: 'events',
    screen: 'direction',
    target: 'event-input',
    title: 'Лента',
    text: 'Лента — что произошло по направлению. Запишите событие в поле «Что произошло?» или скажите агенту; события попадают в дейлик.',
    prompts: ['event'],
  },
  {
    id: 'agent',
    screen: 'direction',
    target: 'agent-button',
    title: 'Поручить агенту',
    text: 'Откроется окно поручения: шаблон, контекст из карточки и ветка. После «Запустить» откроется вкладка терминала, и агент сразу начнёт работу в папке проекта.',
  },
  {
    id: 'menu',
    screen: 'direction',
    target: 'direction-menu',
    title: 'Меню «…»',
    text: 'Здесь удаление направления. Worklog переспросит, а сразу после удаления ⌘Z вернёт направление.',
  },
  {
    id: 'tabs',
    screen: null,
    target: 'tab-bar',
    title: 'Два экрана рядом',
    text: 'Перетащите вкладку в правую треть окна — она откроется рядом с текущей. ⌘W закрывает вкладку, ⇧⌘T возвращает закрытую.',
    demo: 'tab-split',
  },
  {
    id: 'daily',
    screen: 'daily',
    target: 'daily-summary',
    title: 'Дейлик',
    text: 'Текст к дейлику собирается из событий в лентах. «✦ Собрать из сессий» — по желанию: агент найдёт сделанное в сессиях, это тратит его токены. «Дейлик прошёл» переносит текст в Историю.',
  },
  {
    id: 'safety',
    screen: null,
    target: null,
    title: 'Здесь ничего не сломать',
    text: 'Данные хранятся только на этой машине. В Jira Worklog ничего не пишет, только читает статусы. ⌘Z отменяет последние действия в окне, а раз в день сервер сохраняет снимок данных. Повторить экскурсию — «Как пользоваться» внизу боковой панели.',
  },
];

/** steps about one direction: without a direction to show they are left out */
export const DIRECTION_STEPS: readonly TourStepId[] = ['card', 'drag', 'direction', 'events', 'agent', 'menu'];

export function tourStep(id: TourStepId): TourStep {
  const step = TOUR_STEPS.find(item => item.id === id);
  if (step === undefined) throw new Error(`Нет шага экскурсии ${id}`);
  return step;
}

/** the selector of a step's target; null when the tour has no direction for the card */
export function targetSelector(target: string, directionId: string | null): string | null {
  if (target !== DIRECTION_CARD) return `[data-tour="${target}"]`;
  return directionId === null ? null : `[data-direction-id="${directionId.replace(/["\\]/g, '\\$&')}"]`;
}
