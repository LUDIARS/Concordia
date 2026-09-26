import Database from 'better-sqlite3';
import { type Interaction, type Message } from 'discord.js';
import { expect, it, vi } from 'vitest';
import { SprintDialoguesRepository } from '../sprint-dialogues/repository.js';
import { sprintDialogueInput } from './sprint-dialogues-input.js';
import { sprintCard } from './sprint-dialogues-card.js';

it('ignores bot and webhook commentary and only issues an identity-bound ticket from the current bot card', async () => {
  const db = new Database(':memory:');
  try {
    const repo = new SprintDialoguesRepository(db); const d = repo.publish({ version: 1, dialogueKey: 'actio:t:s', teamId: 't', sprintId: 's', sprintName: 'Sprint', phase: 'acceptance', revision: 1,
      sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '実装完了', summary: '確認', taskIds: ['task'], actioPath: '/tasks/planning' });
    repo.saveThread(d.id, 'guild', 'thread'); repo.saveCard(d.id, 1, 'card');
    const handler = sprintDialogueInput({ repo, guildId: 'guild', botId: 'bot', allowed: () => true, stopped: () => false });
    const base = { guildId: 'guild', channelId: 'thread', id: 'message', content: '承認', reply: vi.fn(), react: vi.fn() };
    await handler.message({ ...base, author: { id: 'bot', bot: true } } as unknown as Message);
    await handler.message({ ...base, author: { id: 'human', bot: false }, webhookId: 'hook' } as unknown as Message);
    expect(repo.claimConversation(Date.now())).toBeNull(); expect(repo.pendingEvents()).toHaveLength(0);
    const showModal = vi.fn(); const reply = vi.fn();
    const button = { isButton: () => true, isModalSubmit: () => false, guildId: 'guild', channelId: 'thread', user: { id: 'human', bot: false },
      customId: `sd:${d.id}:1:approve`, message: { id: 'card', author: { id: 'bot' }, webhookId: null }, showModal, reply };
    await handler.interaction(button as unknown as Interaction);
    expect(showModal).toHaveBeenCalledTimes(1); expect(repo.pendingEvents()).toHaveLength(0);
    const ticketId = showModal.mock.calls[0]![0].data.custom_id.slice(4);
    const input = { eventId: 'event', userId: 'wrong-human', guildId: 'guild', threadId: 'thread', taskIds: [], reason: '確認', now: Date.now() };
    expect(() => repo.consumeChoice(ticketId, input)).toThrow();
    repo.publish({ ...d.projection, revision: 2, closed: true });
    expect(() => repo.consumeChoice(ticketId, { ...input, userId: 'human' })).toThrow();
    await handler.interaction(button as unknown as Interaction);
    expect(showModal).toHaveBeenCalledTimes(1); expect(reply).toHaveBeenCalledTimes(1);
    const card = sprintCard(repo.byId(d.id)!, 'https://actio.example');
    expect(card.content).toContain('完了'); expect(card.components[0]?.components).toHaveLength(1);
  } finally { db.close(); }
});
