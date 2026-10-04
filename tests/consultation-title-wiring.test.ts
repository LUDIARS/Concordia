import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { makeDiscordConfigRepo } from '../src/db/discord-repo.js';
import { createConsultationTitleUpdater } from '../src/discord/consultation-title.js';
import { buildForumThreadTitle } from '../src/discord/forum-title.js';
it('persists a scoped summary and reuses it after reconnect without another rename', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE discord_config(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const config = makeDiscordConfigRepo(db, 'sub:one');
  let name = '長い入力', nameBody = '長い入力';
  const rename = vi.fn(async (value: string) => { name = value; });
  const summarize = vi.fn(async () => ({ title: '予算の相談', changed: true }));
  const ports = { config, read: () => ({ channelId: 'thread', source: '長い公開相談です', nameBody }), summarize,
    surface: async () => ({ name, rename }), format: (_id: string, title: string) => buildForumThreadTitle('Cc', title, '☀️', 'implementation'),
    remember: (_id: string, title: string) => { nameBody = title; }, warn: vi.fn() };
  const first = createConsultationTitleUpdater(ports);
  let second: ReturnType<typeof createConsultationTitleUpdater> | null = null;
  try {
    first.request('s'); await vi.waitFor(() => expect(nameBody).toBe('予算の相談'));
    expect(name).toBe('☀️ [Cc] [実装] 予算の相談');
    first.stop();
    expect(makeDiscordConfigRepo(db).get('consultation_title:s')).toBeNull();
    expect(makeDiscordConfigRepo(db, 'sub:two').get('consultation_title:s')).toBeNull();
    second = createConsultationTitleUpdater(ports); second.request('s');
    await new Promise(done => setTimeout(done, 0));
    expect(rename).toHaveBeenCalledTimes(1); expect(summarize).toHaveBeenCalledTimes(1);
  } finally { first.stop(); second?.stop(); db.close(); }
});
