import Database from 'better-sqlite3';
import { ChannelType, Collection, type Guild } from 'discord.js';
import { expect, it, vi } from 'vitest';
import { SprintDialoguesRepository } from '../sprint-dialogues/repository.js';
import { sprintDelivery } from './sprint-dialogues-delivery.js';

it('posts a new phase notice exactly once, reconciles a lost send receipt, and ignores fingerprint-only revisions', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const db = new Database(':memory:');
  try {
    const repo = new SprintDialoguesRepository(db);
    const d = repo.publish({ version: 1, dialogueKey: 'actio:t:s', teamId: 't', sprintId: 's', sprintName: 'Sprint', phase: 'implementation', revision: 1,
      sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '開始', summary: '確認', taskIds: ['task'], actioPath: '/tasks/planning' });
    repo.saveForum('guild', 'forum'); repo.saveThread(d.id, 'guild', 'thread'); repo.saveCard(d.id, 1, 'card');
    const history = new Collection<string, { id: string; author: { id: string }; webhookId: null; content: string }>();
    const card = { id: 'card', author: { id: 'bot' }, webhookId: null, edit: vi.fn(async () => card) };
    let loseResponse = false;
    const send = vi.fn(async (data: { content: string }) => {
      const message = { id: `notice-${history.size}`, author: { id: 'bot' }, webhookId: null, content: data.content };
      history.set(message.id, message);
      if (loseResponse) { loseResponse = false; throw new Error('response lost after acceptance'); }
      return message;
    });
    const thread = { id: 'thread', parentId: 'forum', archived: false, isThread: () => true, client: { user: { id: 'bot' } }, send,
      messages: { fetch: vi.fn(async (arg: unknown) => typeof arg === 'string' ? card : history) } };
    const forum = { id: 'forum', type: ChannelType.GuildForum, topic: 'Concordia sprint dialogues v1', guild: null as unknown };
    const guild = { id: 'guild', client: { user: { id: 'bot' } }, channels: { fetch: vi.fn(async (id?: string) => id ? thread : new Collection([['forum', forum]])) } };
    forum.guild = guild;
    const makeTick = (repository: SprintDialoguesRepository) => sprintDelivery({ guild: guild as unknown as Guild, parentId: 'parent', repo: repository,
      origin: async () => 'https://actio.example', stopped: () => false, log: { warn: vi.fn() } });
    await makeTick(repo)(); await makeTick(repo)(); expect(send).toHaveBeenCalledTimes(1);
    repo.publish({ ...d.projection, revision: 2, phase: 'acceptance', reason: '全件実装完了' }); loseResponse = true;
    await makeTick(repo)(); expect(send).toHaveBeenCalledTimes(2); expect(repo.find(d.projection.dialogueKey)?.deliveryStatus).toBe('unknown');
    vi.setSystemTime(160001);
    const recovered = new SprintDialoguesRepository(db); await makeTick(recovered)();
    expect(send).toHaveBeenCalledTimes(2); expect(recovered.noticeDeliveries()).toHaveLength(0);
    recovered.publish({ ...d.projection, revision: 3, phase: 'acceptance', reason: '資料更新', sourceFingerprint: 'b'.repeat(64) });
    await makeTick(recovered)(); expect(send).toHaveBeenCalledTimes(2);
    recovered.publish({ ...d.projection, revision: 4, phase: 'acceptance', held: true });
    await makeTick(recovered)(); expect(send).toHaveBeenCalledTimes(3);
    expect([...history.values()].map(m => m.content).join('\n')).toContain('受入確認');
  } finally { db.close(); vi.useRealTimers(); }
});
