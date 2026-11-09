import { TestBed } from '@angular/core/testing';
import { RichText, textParts } from './rich-text';

describe('textParts', () => {
  it('splits code in backquotes and addresses out of the text', () => {
    expect(textParts('Ключи `app.*` — см. https://wiki.test/p?id=1, и всё.')).toEqual([
      { kind: 'text', value: 'Ключи ' },
      { kind: 'code', value: 'app.*' },
      { kind: 'text', value: ' — см. ' },
      { kind: 'url', value: 'https://wiki.test/p?id=1' },
      { kind: 'text', value: ', и всё.' },
    ]);
    expect(textParts('')).toEqual([]);
    expect(textParts('`не закрыто')).toEqual([{ kind: 'text', value: '`не закрыто' }]);
  });
});

describe('RichText', () => {
  it('keeps line breaks and opens addresses in a new window', async () => {
    const fixture = TestBed.createComponent(RichText);
    fixture.componentRef.setInput('text', 'первая\nhttps://x.test/');
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.textContent).toBe('первая\nhttps://x.test/');
    const link = host.querySelector('a');
    expect([link?.getAttribute('href'), link?.target, link?.rel]).toEqual(['https://x.test/', '_blank', 'noopener']);
  });
});
