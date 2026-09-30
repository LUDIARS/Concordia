/**
 * 論理会話・入力・交代の永続化 (adapter)。
 *
 * 会話 ID (platform / 組織 / guild / thread) は runtime session ID と分けて持ち、
 * 現在の担当と世代は version 付きの CAS で 1 つに決める。 入力は platform の
 * message ID で重複を抑える。 交代は状態ごとの CAS で進め、競合した側は何もしない。
 *
 * @implements spec/feature/astra-with-sidecar.md §会話と実行の寿命
 */

import type { Database } from "better-sqlite3";
import type { HandoffState } from "./handoff-machine.js";

export type ConversationState = "active" | "handing_off";
export type ConversationInputState = "received" | "delivering" | "delivered" | "held" | "uncertain" | "failed" | "rejected";

export interface ConversationRow {
  conversation_id: string;
  platform: string;
  scope: string;
  guild_id: string;
  thread_id: string;
  owner_session_id: string;
  generation: number;
  state: ConversationState;
  active_handoff_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationInputRow {
  id: number;
  conversation_id: string;
  platform_message_id: string;
  author_id: string;
  author_label: string | null;
  intent: string;
  text: string | null;
  received_generation: number;
  target_session_id: string | null;
  handoff_id: string | null;
  state: ConversationInputState;
  error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

export interface ConversationHandoffRow {
  id: string;
  conversation_id: string;
  from_session_id: string;
  from_generation: number;
  to_session_id: string | null;
  successor_run_id: string | null;
  state: HandoffState;
  trigger_input_id: number | null;
  next_instruction: string | null;
  package_json: string | null;
  correlation_id: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  package_saved_at: number | null;
  switched_at: number | null;
  drained_at: number | null;
}

export function buildConversationId(input: { platform: string; scope: string; guildId: string; threadId: string }): string {
  return `${input.platform}:${input.scope || "-"}:${input.guildId}:${input.threadId}`;
}

export class ConversationRepo {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  findConversation(conversationId: string): ConversationRow | null {
    return (this.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`)
      .get(conversationId) as ConversationRow | undefined) ?? null;
  }

  listConversationsByOwner(sessionId: string): ConversationRow[] {
    return this.db.prepare(`SELECT * FROM conversations WHERE owner_session_id = ? ORDER BY created_at`)
      .all(sessionId) as ConversationRow[];
  }

  /** 既にあれば既存を返す (競合して作られても 1 行に収束する)。 */
  ensureConversation(input: {
    platform: string;
    scope: string;
    guildId: string;
    threadId: string;
    ownerSessionId: string;
    now: number;
  }): ConversationRow {
    const conversationId = buildConversationId(input);
    this.db.prepare(
      `INSERT INTO conversations
        (conversation_id, platform, scope, guild_id, thread_id, owner_session_id, generation, state,
         active_handoff_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'active', NULL, 0, ?, ?)
       ON CONFLICT(conversation_id) DO NOTHING`,
    ).run(conversationId, input.platform, input.scope, input.guildId, input.threadId, input.ownerSessionId, input.now, input.now);
    return this.findConversation(conversationId)!;
  }

  /** version が一致した時だけ更新し、成功したら新しい行を返す。 */
  compareAndSetConversation(
    conversationId: string,
    expectedVersion: number,
    patch: Partial<Pick<ConversationRow, "owner_session_id" | "generation" | "state" | "active_handoff_id">>,
    now: number,
  ): ConversationRow | null {
    const current = this.findConversation(conversationId);
    if (!current || current.version !== expectedVersion) return null;
    const next = { ...current, ...patch };
    const result = this.db.prepare(
      `UPDATE conversations
          SET owner_session_id = ?, generation = ?, state = ?, active_handoff_id = ?,
              version = version + 1, updated_at = ?
        WHERE conversation_id = ? AND version = ?`,
    ).run(next.owner_session_id, next.generation, next.state, next.active_handoff_id, now, conversationId, expectedVersion);
    return result.changes === 1 ? this.findConversation(conversationId) : null;
  }

  /** message ID が既に記録済みなら duplicate を返し、新しい行は作らない。 */
  insertInput(input: {
    conversationId: string;
    platformMessageId: string;
    authorId: string;
    authorLabel: string | null;
    intent: string;
    text: string;
    generation: number;
    state: ConversationInputState;
    targetSessionId: string | null;
    handoffId: string | null;
    now: number;
  }): { row: ConversationInputRow; duplicate: boolean } {
    const result = this.db.prepare(
      `INSERT INTO conversation_inputs
        (conversation_id, platform_message_id, author_id, author_label, intent, text, received_generation,
         target_session_id, handoff_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, platform_message_id) DO NOTHING`,
    ).run(
      input.conversationId, input.platformMessageId, input.authorId, input.authorLabel, input.intent, input.text,
      input.generation, input.targetSessionId, input.handoffId, input.state, input.now, input.now,
    );
    const row = this.db.prepare(
      `SELECT * FROM conversation_inputs WHERE conversation_id = ? AND platform_message_id = ?`,
    ).get(input.conversationId, input.platformMessageId) as ConversationInputRow;
    return { row, duplicate: result.changes === 0 };
  }

  findInput(id: number): ConversationInputRow | null {
    return (this.db.prepare(`SELECT * FROM conversation_inputs WHERE id = ?`).get(id) as ConversationInputRow | undefined) ?? null;
  }

  /**
   * 状態を from のどれかから to へ移す。 配達済みになった入力は本文を消す
   * (セッション側の transcript が正本になり、ここに二重に残さない)。
   */
  transitionInput(
    id: number,
    from: readonly ConversationInputState[],
    to: ConversationInputState,
    patch: { targetSessionId?: string | null; handoffId?: string | null; error?: string | null },
    now: number,
  ): ConversationInputRow | null {
    const placeholders = from.map(() => "?").join(",");
    const current = this.findInput(id);
    if (!current || !from.includes(current.state)) return null;
    const result = this.db.prepare(
      `UPDATE conversation_inputs
          SET state = ?, target_session_id = ?, handoff_id = ?, error = ?, updated_at = ?,
              delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
              text = CASE WHEN ? = 'delivered' THEN NULL ELSE text END
        WHERE id = ? AND state IN (${placeholders})`,
    ).run(
      to,
      patch.targetSessionId === undefined ? current.target_session_id : patch.targetSessionId,
      patch.handoffId === undefined ? current.handoff_id : patch.handoffId,
      patch.error === undefined ? current.error : patch.error,
      now, to, now, to, id, ...from,
    );
    return result.changes === 1 ? this.findInput(id) : null;
  }

  listInputs(conversationId: string, states: readonly ConversationInputState[], limit = 200): ConversationInputRow[] {
    const placeholders = states.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM conversation_inputs WHERE conversation_id = ? AND state IN (${placeholders})
       ORDER BY id LIMIT ?`,
    ).all(conversationId, ...states, limit) as ConversationInputRow[];
  }

  countInputs(conversationId: string, states: readonly ConversationInputState[]): number {
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM conversation_inputs WHERE conversation_id = ? AND state IN (${placeholders})`,
    ).get(conversationId, ...states) as { n: number }).n;
  }

  createHandoff(input: {
    id: string;
    conversationId: string;
    fromSessionId: string;
    fromGeneration: number;
    triggerInputId: number | null;
    nextInstruction: string;
    correlationId: string;
    now: number;
  }): ConversationHandoffRow {
    this.db.prepare(
      `INSERT INTO conversation_handoffs
        (id, conversation_id, from_session_id, from_generation, state, trigger_input_id, next_instruction,
         correlation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'handoff_pending', ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.conversationId, input.fromSessionId, input.fromGeneration, input.triggerInputId,
      input.nextInstruction, input.correlationId, input.now, input.now,
    );
    return this.findHandoff(input.id)!;
  }

  findHandoff(id: string): ConversationHandoffRow | null {
    return (this.db.prepare(`SELECT * FROM conversation_handoffs WHERE id = ?`).get(id) as ConversationHandoffRow | undefined) ?? null;
  }

  /** 状態が from の時だけ to へ移す。 競合して既に動いていたら null。 */
  transitionHandoff(
    id: string,
    from: HandoffState,
    to: HandoffState,
    patch: Partial<Pick<ConversationHandoffRow,
      "to_session_id" | "successor_run_id" | "package_json" | "error" | "package_saved_at" | "switched_at" | "drained_at">>,
    now: number,
  ): ConversationHandoffRow | null {
    const current = this.findHandoff(id);
    if (!current || current.state !== from) return null;
    const next = { ...current, ...patch };
    const result = this.db.prepare(
      `UPDATE conversation_handoffs
          SET state = ?, to_session_id = ?, successor_run_id = ?, package_json = ?, error = ?,
              package_saved_at = ?, switched_at = ?, drained_at = ?, updated_at = ?
        WHERE id = ? AND state = ?`,
    ).run(
      to, next.to_session_id, next.successor_run_id, next.package_json, next.error,
      next.package_saved_at, next.switched_at, next.drained_at, now, id, from,
    );
    return result.changes === 1 ? this.findHandoff(id) : null;
  }

  listHandoffs(states: readonly HandoffState[], limit = 100): ConversationHandoffRow[] {
    const placeholders = states.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM conversation_handoffs WHERE state IN (${placeholders}) ORDER BY updated_at LIMIT ?`,
    ).all(...states, limit) as ConversationHandoffRow[];
  }

  listHandoffsByConversation(conversationId: string, limit = 20): ConversationHandoffRow[] {
    return this.db.prepare(
      `SELECT * FROM conversation_handoffs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(conversationId, limit) as ConversationHandoffRow[];
  }
}
