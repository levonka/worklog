import { DatabaseSync } from 'node:sqlite';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function png(marker: number): Uint8Array {
  return Uint8Array.from([...PNG_SIGNATURE, marker]);
}

export interface FixtureIcon {
  pages: string[];
  bitmaps: { width: number; data: Uint8Array }[];
}

// the tables and columns of Chrome's Favicons database that Worklog reads
export function writeFaviconsDb(file: string, icons: FixtureIcon[]): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE favicons (id INTEGER PRIMARY KEY, url LONGVARCHAR NOT NULL, icon_type INTEGER DEFAULT 1);
    CREATE TABLE icon_mapping (id INTEGER PRIMARY KEY, page_url LONGVARCHAR NOT NULL, icon_id INTEGER, page_url_type INTEGER DEFAULT 0);
    CREATE INDEX icon_mapping_page_url_idx ON icon_mapping(page_url);
    CREATE TABLE favicon_bitmaps (id INTEGER PRIMARY KEY, icon_id INTEGER NOT NULL, last_updated INTEGER DEFAULT 0, image_data BLOB, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, last_requested INTEGER DEFAULT 0);
  `);
  icons.forEach((icon, index) => {
    const id = index + 1;
    db.prepare('INSERT INTO favicons (id, url) VALUES (?, ?)').run(id, `https://icons.test/${id}.ico`);
    for (const page of icon.pages) db.prepare('INSERT INTO icon_mapping (page_url, icon_id) VALUES (?, ?)').run(page, id);
    for (const bitmap of icon.bitmaps) {
      // Chrome's timestamps do not fit a JS number
      db.prepare('INSERT INTO favicon_bitmaps (icon_id, last_updated, image_data, width, height) VALUES (?, ?, ?, ?, ?)').run(id, 13432808124369686n, bitmap.data, bitmap.width, bitmap.width);
    }
  });
  db.close();
}
