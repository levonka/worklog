export interface PluralForms {
  one: string;
  few: string;
  many: string;
}

const RULES = new Intl.PluralRules('ru');

/** `forms` for 1, 2 and 5: `{ one: 'дело', few: 'дела', many: 'дел' }` */
export function plural(count: number, forms: PluralForms): string {
  const rule = RULES.select(count);
  return rule === 'one' ? forms.one : rule === 'few' ? forms.few : forms.many;
}
