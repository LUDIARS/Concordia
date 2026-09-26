import Database from 'better-sqlite3';
import type { Guild } from 'discord.js';
import { expect, it, vi } from 'vitest';
import { startSprintDialogues } from './sprint-dialogues.js';
import { SprintDialoguesRepository } from '../sprint-dialogues/repository.js';

it('creates no Discord resource at startup and stops acquisition before releasing its timer', async () => {
  vi.useFakeTimers(); const db = new Database(':memory:');
  const fetch = vi.fn(); const reply = vi.fn();
  const guild = { id: 'guild', client: { user: { id: 'bot' } }, channels: { fetch } } as unknown as Guild;
  const runtime = startSprintDialogues({ guild, db, parentId: 'parent', workspaceRoot: 'unused', allowed: () => true, reply, log: { warn: vi.fn() } });
  try {
    const repo = new SprintDialoguesRepository(db);
    const d = repo.publish({ version: 1, dialogueKey: 'actio:t:s', teamId: 't', sprintId: 's', sprintName: 'Sprint', phase: 'planning', revision: 1,
      sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '計画', summary: '確認', taskIds: ['task'], actioPath: '/tasks/planning' });
    repo.enqueueConversation('message', d.id, '相談', Date.now());
    expect(fetch).not.toHaveBeenCalled(); runtime.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetch).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
    expect(repo.claimConversation(Date.now())?.id).toBe('message');
  } finally { runtime.stop(); db.close(); vi.useRealTimers(); }
});
