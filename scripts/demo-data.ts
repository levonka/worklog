// fills a data folder with invented directions, todos, links and a note for screenshots and manual checks: node scripts/demo-data.ts <data dir> <profile file>
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from '../shared/model.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

export async function seedDemo(dataDir: string, profilePath: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(profilePath, JSON.stringify(TEST_PROFILE, null, 2));
  const env = { ...process.env, WORKLOG_DATA_DIR: dataDir, WORKLOG_PROFILE: profilePath, WORKLOG_ENV_FILE: '/nonexistent', WORKLOG_JIRA: 'off' };
  const worklog = (...args: string[]): string => execFileSync(path.join(ROOT, 'bin', 'worklog'), args, { env, encoding: 'utf8' }).trim();

  const map = worklog('dir', 'add', 'Карта пунктов выдачи', '--ticket', 'APP-101', '--ticket', 'WEB-102');
  worklog('link', 'add', map, 'https://www.figma.com/design/demo/Map', '--title', 'макет');
  worklog('link', 'add', map, 'https://wiki.example.com/pages/viewpage.action?pageId=101', '--title', 'BRD', '--desc', 'Пункты выдачи на карте рядом с адресом; тексты ошибок согласует дизайнер');
  worklog('event', map, 'Разобрал BRD, задал аналитику вопросы по радиусу поиска');
  worklog('event', map, 'Сверстал виджет карты, осталось состояние ошибки');
  worklog('todo', 'add', 'Уточнить текст ошибки карты', '--dir', map, '--from', 'Ани');

  const certificate = worklog('dir', 'add', 'Сертификат для стенда', '--ticket', 'WEB-110', '--status', 'wait', '--waiting', 'девопсы');
  worklog('event', certificate, 'Создал задачу девопсам на выпуск сертификата, жду реакции');

  const theme = worklog('dir', 'add', 'Тёмная тема настроек', '--ticket', 'APP-120', '--status', 'mr');
  worklog('link', 'add', theme, 'https://git.example.com/team/app/-/merge_requests/42', '--title', 'MR !42');
  worklog('event', theme, 'Поправил замечания ревью по контрасту');

  worklog('dir', 'add', 'Push-уведомления', '--ticket', 'APP-130', '--ticket', 'WEB-131', '--status', 'test');
  worklog('dir', 'add', 'Удаление старых тоглов', '--ticket', 'WEB-140', '--status', 'release');
  worklog('dir', 'add', 'Платёжный виджет', '--ticket', 'APP-150', '--status', 'parked');
  worklog('dir', 'add', 'SEO-тексты', '--ticket', 'WEB-160', '--status', 'done');

  worklog('todo', 'add', 'Ответить в треде про релиз', '--due', localDate(new Date()));
  worklog('todo', 'add', 'Посмотреть MR коллеги', '--from', 'Олега', '--link', 'https://git.example.com/team/app/-/merge_requests/41');
  worklog('repeat', 'add', 'Дейлик', '--every', 'weekdays', '--time', '11:30', '--link', 'https://meet.example.com/daily');
  worklog('repeat', 'add', 'Проверить почту', '--every', 'day', '--link', 'https://mail.example.com');

  worklog('quicklink', 'add', 'Каждый день', 'Почта', 'https://mail.example.com');
  worklog('quicklink', 'add', 'Каждый день', 'Календарь', 'https://calendar.example.com');
  worklog('quicklink', 'add', 'Разработка', 'Jira', 'https://jira.example.com', '--desc', 'Вход по сертификату');
  worklog('quicklink', 'add', 'Разработка', 'GitLab', 'https://git.example.com');

  worklog('note', 'add', 'Ключ карты на стендах', '--dir', map, '--body', 'На стендах ключ API карты берётся из конфига стенда, на проде — из переменной окружения.', '--link', 'https://wiki.example.com/pages/viewpage.action?pageId=102 Настройки карты');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dataDir, profilePath] = process.argv.slice(2);
  if (dataDir === undefined || profilePath === undefined) {
    console.error('Использование: node scripts/demo-data.ts <папка данных> <файл профиля>');
    process.exit(2);
  }
  await seedDemo(path.resolve(dataDir), path.resolve(profilePath));
}
