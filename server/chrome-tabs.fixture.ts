// builds Chrome's SNSS session files: a header, then records of [uint16 size][uint8 command id][payload]

export const COMMANDS = {
  setTabWindow: 0,
  setTabIndexInWindow: 2,
  updateTabNavigation: 6,
  setSelectedNavigationIndex: 7,
  tabClosed: 16,
  windowClosed: 17,
  tabNavigationPathPruned: 24,
} as const;

export const SNSS_HEADER = Buffer.concat([Buffer.from('SNSS', 'latin1'), int32(3)]);

export function int32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeInt32LE(value, i * 4));
  return buffer;
}

function padded(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
}

function string8(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([int32(bytes.length), padded(bytes)]);
}

function string16(text: string): Buffer {
  return Buffer.concat([int32(text.length), padded(Buffer.from(text, 'utf16le'))]);
}

export function record(command: number, payload: Buffer): Buffer {
  const size = Buffer.alloc(2);
  size.writeUInt16LE(payload.length + 1);
  return Buffer.concat([size, Buffer.from([command]), payload]);
}

export function navigation(tab: number, index: number, url: string, title: string): Buffer {
  const body = Buffer.concat([int32(tab, index), string8(url), string16(title)]);
  return record(COMMANDS.updateTabNavigation, Buffer.concat([int32(body.length), body]));
}

export interface FixtureTab {
  id: number;
  window: number;
  index: number;
  url: string;
  title: string;
}

export function snss(tabs: FixtureTab[], extra: Buffer[] = []): Buffer {
  const records = tabs.flatMap(tab => [
    record(COMMANDS.setTabWindow, int32(tab.window, tab.id)),
    record(COMMANDS.setTabIndexInWindow, int32(tab.id, tab.index)),
    navigation(tab.id, 0, tab.url, tab.title),
    record(COMMANDS.setSelectedNavigationIndex, int32(tab.id, 0)),
  ]);
  return Buffer.concat([SNSS_HEADER, ...records, ...extra]);
}
