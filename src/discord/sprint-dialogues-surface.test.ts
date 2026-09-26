import Database from 'better-sqlite3';
import { ChannelType, Collection, type ForumChannel, type Guild, type ThreadChannel } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SprintDialoguesRepository } from '../sprint-dialogues/repository.js';
import { sprintForum, sprintThread, findPosted } from './sprint-dialogues-surface.js';
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
function setup() {
  const db = new Database(':memory:'); databases.push(db); const repo = new SprintDialoguesRepository(db);
  const dialogue = repo.publish({ version: 1, dialogueKey: 'actio:t:s', teamId: 't', sprintId: 's', sprintName: 'Sprint', phase: 'planning', revision: 1,
    sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '計画', summary: '確認', taskIds: ['task'], actioPath: '/tasks/planning' });
  return { repo, dialogue, db };
}
describe('Discord surface recovery', () => {
  it('does not issue another forum creation after a transport timeout and process recovery', async () => {
    const { repo, db } = setup();
    const create = vi.fn().mockRejectedValue(new Error('response lost'));
    const guild = { id: 'guild', channels: { fetch: vi.fn(async () => new Collection()), create } } as unknown as Guild;
    await expect(sprintForum(guild, 'parent', repo, () => false)).rejects.toThrow('response lost');
    await expect(sprintForum(guild, 'parent', new SprintDialoguesRepository(db), () => false)).rejects.toThrow('不明');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('retries a proven permission rejection only after backoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const { repo } = setup();
    const create = vi.fn().mockRejectedValueOnce({ status: 403 }).mockResolvedValue({ id: 'forum' });
    const guild = { id: 'guild', channels: { fetch: vi.fn(async () => new Collection()), create } } as unknown as Guild;
    await expect(sprintForum(guild, 'parent', repo, () => false)).rejects.toEqual({ status: 403 });
    expect(repo.surface('guild').intent).toBe(false);
    await expect(sprintForum(guild, 'parent', repo, () => false)).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    vi.setSystemTime(160001); await sprintForum(guild, 'parent', repo, () => false);
    expect(create).toHaveBeenCalledTimes(2); expect(repo.surface('guild').forumId).toBe('forum');
  });
  it('reconciles a created thread by deterministic marker instead of repeating unknown create', async () => {
    const { repo, dialogue } = setup(); repo.claimThread(dialogue.id);
    const thread = { id: 'thread', name: `Sprint [${dialogue.id}]`, archived: false,
      fetchStarterMessage: vi.fn(async () => ({ author: { id: 'bot' }, webhookId: null, content: `sprint-dialogue:${dialogue.id}` })) };
    const create = vi.fn();
    const forum = { id: 'forum', guild: { id: 'guild' }, client: { user: { id: 'bot' } },
      threads: { fetchActive: vi.fn(async () => ({ threads: new Collection([['thread', thread]]) })),
        fetchArchived: vi.fn(async () => ({ threads: new Collection(), hasMore: false })), create } } as unknown as ForumChannel;
    await sprintThread(forum, repo.byId(dialogue.id)!, repo, 'https://actio.example', () => false);
    expect(create).not.toHaveBeenCalled(); expect(repo.byId(dialogue.id)?.threadId).toBe('thread');
  });
  it('does not use a webhook message to prove delivery', async () => {
    const messages = new Collection([['fake', { author: { id: 'bot' }, webhookId: 'webhook', content: 'sprint-result:key' }]]);
    const thread = { client: { user: { id: 'bot' } }, messages: { fetch: vi.fn(async () => messages) } } as unknown as ThreadChannel;
    expect(await findPosted(thread, 'sprint-result:key')).toBeNull();
  });
});
