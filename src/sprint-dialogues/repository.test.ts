import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SprintDialoguesRepository } from "./repository.js";
import type { Projection } from "./domain.js";
const projection: Projection = { version: 1, dialogueKey: 'actio:team:sprint', teamId: 'team', sprintId: 'sprint', sprintName: '目標', phase: 'acceptance', revision: 1,
  sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '全件実装完了', summary: 'タスクの確認', taskIds: ['task'], actioPath: '/tasks/planning?team=team&sprint=sprint' };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(':memory:'); databases.push(db); return { db, repo: new SprintDialoguesRepository(db) }; }
function ticket(repo: SprintDialoguesRepository, id: string, user = 'human') {
  repo.issueChoice({ id, dialogueId: repo.find(projection.dialogueKey)!.id, userId: user, guildId: 'guild', threadId: 'thread', revision: 1, action: 'reject', expiresAt: 20000 });
}
const answer = { eventId: 'discord:guild:interaction', userId: 'human', guildId: 'guild', threadId: 'thread', reason: '未達', taskIds: ['task'], now: 10000 };
describe('durable sprint dialogue ownership', () => {
  it('deduplicates equivalent projection retries and rejects changed or older revisions', () => {
    const { repo } = setup(); const first = repo.publish(projection);
    expect(repo.publish({ ...projection, taskIds: ['task', 'task'] }).id).toBe(first.id);
    expect(() => repo.publish({ ...projection, summary: '別資料' })).toThrow();
    repo.publish({ ...projection, revision: 2 });
    expect(() => repo.publish(projection)).toThrow();
  });
  it('persists unknown forum and thread intents across repository re-creation', () => {
    const { repo, db } = setup(); const d = repo.publish(projection);
    expect(repo.claimForum('guild')).toBe(true); expect(repo.claimThread(d.id)).toBe(true);
    const recovered = new SprintDialoguesRepository(db);
    expect(recovered.claimForum('guild')).toBe(false); expect(recovered.claimThread(d.id)).toBe(false);
    expect(recovered.byId(d.id)?.deliveryStatus).toBe('unknown');
  });
  it('rejects other humans, expired tickets, stale cards and unknown task IDs', () => {
    const { repo } = setup(); repo.publish(projection); ticket(repo, 'a');
    expect(() => repo.consumeChoice('a', { ...answer, userId: 'other' })).toThrow();
    expect(() => repo.consumeChoice('a', { ...answer, now: 21000 })).toThrow();
    expect(() => repo.consumeChoice('a', { ...answer, taskIds: ['unrelated'] })).toThrow();
    expect(() => repo.consumeChoice('a', { ...answer, taskIds: [] })).toThrow();
    repo.publish({ ...projection, revision: 2 });
    expect(() => repo.consumeChoice('a', answer)).toThrow();
    expect(repo.pendingEvents()).toEqual([]);
  });
  it('stores genuine choice once, keeps pending until ack and rejects conflicting ack', () => {
    const { repo } = setup(); repo.publish(projection); ticket(repo, 'a');
    const result = repo.consumeChoice('a', answer);
    expect(repo.consumeChoice('a', answer)).toEqual(result);
    expect(() => repo.consumeChoice('a', { ...answer, eventId: 'second' })).toThrow();
    expect(repo.pendingEvents()).toHaveLength(1);
    expect(repo.pendingEvents()[0]?.actor).toEqual({ discordUserId: 'human', discordGuildId: 'guild' });
    const outcome = { outcome: 'rejected' as const, reason: 'Actioの本人を確認できません。Actio画面で回答してください。' };
    repo.acknowledge(answer.eventId, outcome); repo.acknowledge(answer.eventId, outcome);
    expect(repo.pendingEvents()).toHaveLength(0); expect(repo.resultDeliveries()).toHaveLength(1);
    expect(() => repo.acknowledge(answer.eventId, { outcome: 'applied', reason: '矛盾' })).toThrow();
  });
  it('does not claim an active conversation twice and makes expired executions visibly unknown', () => {
    const { repo } = setup(); const d = repo.publish(projection);
    repo.enqueueConversation('msg', d.id, '相談', 1); repo.enqueueConversation('msg', d.id, '相談', 1);
    expect(repo.claimConversation(2)?.id).toBe('msg'); expect(repo.claimConversation(3)).toBeNull();
    expect(repo.claimConversation(180003)).toBeNull();
    expect(repo.conversationDeliveries()[0]).toMatchObject({ id: 'msg', status: 'unknown' });
  });
});
