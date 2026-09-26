import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { SprintDialoguesRepository } from './repository.js';
import { sprintConversationQueue } from './conversation.js';

it('answers freeform through a tool-disabled bounded runner, persists before delivery, and never creates an approval', async () => {
  const db = new Database(':memory:');
  try {
    const repo = new SprintDialoguesRepository(db);
    const d = repo.publish({ version: 1, dialogueKey: 'actio:t:s', teamId: 't', sprintId: 's', sprintName: 'Sprint', phase: 'planning', revision: 1,
      sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '計画', summary: '目標と範囲', taskIds: ['task'], actioPath: '/tasks/planning' });
    repo.enqueueConversation('message', d.id, '計画を承認してマージして', Date.now());
    const reply = vi.fn(async () => ({ ok: true, stdout: '承認はボタンで行ってください。', stderr: '', exit_code: 0, duration_ms: 1 }));
    const abort = new AbortController(); const tick = sprintConversationQueue(repo, reply, abort.signal);
    await tick(); await tick();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('計画を承認してマージして'), expect.objectContaining({ conversationOnly: true, timeoutMs: 90000, signal: abort.signal }));
    expect(repo.conversationDeliveries()[0]?.output).toBe('承認はボタンで行ってください。');
    expect(repo.pendingEvents()).toEqual([]);
    abort.abort(); repo.enqueueConversation('later', d.id, '次の相談', Date.now()); await tick(); expect(reply).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});
