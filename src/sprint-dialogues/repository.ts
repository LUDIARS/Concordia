import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { assertProjectionVersion, canonicalProjection, DialogueConflict, type Dialogue, type Projection,
  type HumanEvent, type EventRecord, type Acknowledgement, type Conversation, type DeliveryStatus, type PhaseNotice } from "./domain.js";

/** Cc-owned ledger. Intent is committed before every non-idempotent external effect. */
export class SprintDialoguesRepository {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS sprint_dialogues (
      id TEXT PRIMARY KEY, dialogue_key TEXT NOT NULL UNIQUE, projection TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
      thread_id TEXT, guild_id TEXT, thread_intent INTEGER NOT NULL DEFAULT 0,
      card_id TEXT, card_intent INTEGER NOT NULL DEFAULT 0, delivered_revision INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS sprint_dialogue_events (
      id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL, event TEXT NOT NULL, acknowledgement TEXT,
      delivered INTEGER NOT NULL DEFAULT 0, intent INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS sprint_dialogue_surfaces (
      guild_id TEXT PRIMARY KEY, forum_id TEXT, intent INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS sprint_dialogue_conversations (
      id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      output TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, started_at INTEGER,
      delivered INTEGER NOT NULL DEFAULT 0, intent INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS sprint_dialogue_notices (
      id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL, projection TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, intent INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS sprint_dialogue_choices (
      id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, expires_at INTEGER NOT NULL,
      event_id TEXT
    );`);
  }
  private decode(raw: unknown): Dialogue | null {
    if (!raw) return null;
    const r = raw as { id: string; projection: string; delivery_status: DeliveryStatus; last_error: string | null;
      thread_id: string | null; guild_id: string | null; thread_intent: number; card_id: string | null; card_intent: number; delivered_revision: number };
    return { id: r.id, projection: JSON.parse(r.projection) as Projection, deliveryStatus: r.delivery_status,
      lastError: r.last_error, threadId: r.thread_id, guildId: r.guild_id, threadIntent: !!r.thread_intent,
      cardId: r.card_id, cardIntent: !!r.card_intent, deliveredRevision: r.delivered_revision };
  }
  find(key: string): Dialogue | null { return this.decode(this.db.prepare("SELECT * FROM sprint_dialogues WHERE dialogue_key=?").get(key)); }
  byId(id: string): Dialogue | null { return this.decode(this.db.prepare("SELECT * FROM sprint_dialogues WHERE id=?").get(id)); }
  byThread(id: string): Dialogue | null { return this.decode(this.db.prepare("SELECT * FROM sprint_dialogues WHERE thread_id=?").get(id)); }
  list(): Dialogue[] { return this.db.prepare("SELECT * FROM sprint_dialogues ORDER BY rowid").all().map(r => this.decode(r)!); }
  pending(): Dialogue[] { return this.db.prepare("SELECT * FROM sprint_dialogues WHERE delivery_status!='delivered' AND next_attempt_at<=? ORDER BY rowid LIMIT 50").all(Date.now()).map(r => this.decode(r)!); }
  publish(input: Projection): Dialogue {
    return this.db.transaction(() => {
      const existing = this.find(input.dialogueKey);
      assertProjectionVersion(existing?.projection ?? null, input);
      if (existing?.projection.revision === input.revision) return existing;
      const value = canonicalProjection(input);
      const id = createHash("sha256").update(input.dialogueKey).digest("hex").slice(0, 24);
      this.db.prepare(`INSERT INTO sprint_dialogues (id, dialogue_key, projection) VALUES (?,?,?)
        ON CONFLICT(dialogue_key) DO UPDATE SET projection=excluded.projection, delivery_status='pending', last_error=NULL`).run(id, input.dialogueKey, value);
      if (!existing || existing.projection.phase !== input.phase || existing.projection.held !== input.held || existing.projection.closed !== input.closed) {
        this.db.prepare("INSERT INTO sprint_dialogue_notices (id,dialogue_id,projection) VALUES (?,?,?)").run(`${id}:${input.revision}`, id, value);
      }
      return this.find(input.dialogueKey)!;
    })();
  }
  surface(guildId: string): { forumId: string | null; intent: boolean } {
    const r = this.db.prepare("SELECT forum_id, intent FROM sprint_dialogue_surfaces WHERE guild_id=?").get(guildId) as { forum_id: string | null; intent: number } | undefined;
    return { forumId: r?.forum_id ?? null, intent: !!r?.intent };
  }
  claimForum(guildId: string): boolean {
    return this.db.prepare("INSERT INTO sprint_dialogue_surfaces (guild_id,intent) VALUES (?,1) ON CONFLICT(guild_id) DO UPDATE SET intent=1 WHERE intent=0 AND forum_id IS NULL AND next_attempt_at<=?").run(guildId, Date.now()).changes === 1;
  }
  forumRejected(guildId: string): void { this.db.prepare("UPDATE sprint_dialogue_surfaces SET intent=0,next_attempt_at=? WHERE guild_id=? AND forum_id IS NULL").run(Date.now() + 60000, guildId); }
  threadRejected(id: string): void { this.db.prepare("UPDATE sprint_dialogues SET thread_intent=0 WHERE id=? AND thread_id IS NULL").run(id); }
  saveForum(guildId: string, forumId: string): void {
    this.db.prepare("INSERT INTO sprint_dialogue_surfaces (guild_id,forum_id,intent) VALUES (?,?,1) ON CONFLICT(guild_id) DO UPDATE SET forum_id=excluded.forum_id").run(guildId, forumId);
  }
  claimThread(id: string): boolean { return this.db.prepare("UPDATE sprint_dialogues SET thread_intent=1,delivery_status='unknown' WHERE id=? AND thread_intent=0 AND thread_id IS NULL").run(id).changes === 1; }
  saveThread(id: string, guildId: string, threadId: string): void { this.db.prepare("UPDATE sprint_dialogues SET guild_id=?,thread_id=? WHERE id=?").run(guildId, threadId, id); }
  claimCard(id: string): boolean { return this.db.prepare("UPDATE sprint_dialogues SET card_intent=1 WHERE id=? AND card_intent=0 AND card_id IS NULL").run(id).changes === 1; }
  saveCard(id: string, revision: number, messageId: string): void {
    this.db.prepare("UPDATE sprint_dialogues SET card_id=?, delivered_revision=?, delivery_status=CASE WHEN json_extract(projection,'$.revision')=? THEN 'delivered' ELSE 'pending' END, last_error=NULL WHERE id=?").run(messageId, revision, revision, id);
  }
  deliveryError(id: string, status: DeliveryStatus, error: string): void { this.db.prepare("UPDATE sprint_dialogues SET delivery_status=?,last_error=?,next_attempt_at=? WHERE id=?").run(status, error.slice(0, 2000), Date.now() + 60000, id); }
  deliveryReady(id: string): boolean { const r = this.db.prepare("SELECT next_attempt_at FROM sprint_dialogues WHERE id=?").get(id) as { next_attempt_at: number } | undefined; return !!r && r.next_attempt_at <= Date.now(); }
  noticeDeliveries(): PhaseNotice[] { return this.db.prepare("SELECT * FROM sprint_dialogue_notices WHERE delivered=0 ORDER BY rowid LIMIT 50").all().map(raw => {
    const r = raw as { id: string; dialogue_id: string; projection: string; delivered: number; intent: number };
    return { id: r.id, dialogueId: r.dialogue_id, projection: JSON.parse(r.projection), delivered: !!r.delivered, intent: !!r.intent };
  }); }
  claimNotice(id: string): boolean { return this.db.prepare("UPDATE sprint_dialogue_notices SET intent=1 WHERE id=? AND intent=0").run(id).changes === 1; }
  noticeDelivered(id: string): void { this.db.prepare("UPDATE sprint_dialogue_notices SET delivered=1 WHERE id=?").run(id); }
  noticeRejected(id: string): void { this.db.prepare("UPDATE sprint_dialogue_notices SET intent=0 WHERE id=? AND delivered=0").run(id); }
  addEvent(dialogue: Dialogue, event: HumanEvent): EventRecord {
    return this.db.transaction(() => {
      const old = this.event(event.eventId);
      if (old) { if (JSON.stringify(old.event) !== JSON.stringify(event)) throw new DialogueConflict("応答IDの内容が一致しません。"); return old; }
      const current = this.byId(dialogue.id);
      if (!current || current.projection.revision !== event.revision || current.projection.sourceFingerprint !== event.sourceFingerprint) throw new DialogueConflict("提示が更新されています。最新カードから回答してください。");
      this.db.prepare("INSERT INTO sprint_dialogue_events (id,dialogue_id,event) VALUES (?,?,?)").run(event.eventId, dialogue.id, JSON.stringify(event));
      return this.event(event.eventId)!;
    })();
  }
  issueChoice(ticket: { id: string; dialogueId: string; userId: string; guildId: string; threadId: string; revision: number; action: string; expiresAt: number }): void {
    const dialogue = this.byId(ticket.dialogueId);
    if (!dialogue || dialogue.projection.closed || dialogue.projection.revision !== ticket.revision) throw new DialogueConflict("終了済みまたは更新済みのスプリントには回答できません。");
    this.db.prepare("INSERT INTO sprint_dialogue_choices (id,dialogue_id,user_id,guild_id,thread_id,revision,action,expires_at) VALUES (@id,@dialogueId,@userId,@guildId,@threadId,@revision,@action,@expiresAt)").run(ticket);
  }
  consumeChoice(ticketId: string, input: { eventId: string; userId: string; guildId: string; threadId: string; reason: string; taskIds: string[]; now: number }): EventRecord {
    return this.db.transaction(() => {
      const t = this.db.prepare("SELECT * FROM sprint_dialogue_choices WHERE id=?").get(ticketId) as { dialogue_id: string; user_id: string; guild_id: string; thread_id: string; revision: number; action: HumanEvent['action']; expires_at: number; event_id: string | null } | undefined;
      if (!t || t.user_id !== input.userId || t.guild_id !== input.guildId || t.thread_id !== input.threadId || t.expires_at < input.now) throw new DialogueConflict("回答の本人・対象または有効期限を確認できません。最新カードから回答してください。");
      if (t.event_id) { if (t.event_id !== input.eventId) throw new DialogueConflict("この回答は既に受け付けました。"); return this.event(t.event_id)!; }
      const d = this.byId(t.dialogue_id);
      if (!d || d.projection.closed || d.projection.revision !== t.revision) throw new DialogueConflict("終了済みまたは提示内容が更新されています。最新カードから回答してください。");
      if (input.taskIds.some(id => !d.projection.taskIds.includes(id))) throw new DialogueConflict("対象タスクが現在のスプリントにありません。");
      if (t.action === 'reject' && d.projection.phase !== 'planning' && !input.taskIds.length) throw new DialogueConflict("差し戻し対象のタスクIDが必要です。");
      const event: HumanEvent = { eventId: input.eventId, dialogueKey: d.projection.dialogueKey, teamId: d.projection.teamId, sprintId: d.projection.sprintId,
        revision: t.revision, sourceFingerprint: d.projection.sourceFingerprint, action: t.action, reason: input.reason, taskIds: input.taskIds,
        actor: { discordUserId: input.userId, discordGuildId: input.guildId }, occurredAt: new Date(input.now).toISOString() };
      const result = this.addEvent(d, event);
      this.db.prepare("UPDATE sprint_dialogue_choices SET event_id=? WHERE id=?").run(event.eventId, ticketId);
      return result;
    })();
  }
  private decodeEvent(raw: unknown): EventRecord {
    const r = raw as { event: string; acknowledgement: string | null; delivered: number; intent: number };
    return { event: JSON.parse(r.event), acknowledgement: r.acknowledgement ? JSON.parse(r.acknowledgement) : null, delivered: !!r.delivered, intent: !!r.intent };
  }
  event(id: string): EventRecord | null { const r = this.db.prepare("SELECT * FROM sprint_dialogue_events WHERE id=?").get(id); return r ? this.decodeEvent(r) : null; }
  pendingEvents(limit = 100): HumanEvent[] { return this.db.prepare("SELECT * FROM sprint_dialogue_events WHERE acknowledgement IS NULL ORDER BY rowid LIMIT ?").all(limit).map(r => this.decodeEvent(r).event); }
  resultDeliveries(): EventRecord[] { return this.db.prepare("SELECT * FROM sprint_dialogue_events WHERE acknowledgement IS NOT NULL AND delivered=0 ORDER BY rowid LIMIT 50").all().map(r => this.decodeEvent(r)); }
  acknowledge(id: string, value: Acknowledgement): EventRecord {
    return this.db.transaction(() => {
      const existing = this.event(id);
      if (!existing) throw new DialogueConflict("応答が見つかりません。");
      if (existing.acknowledgement && JSON.stringify(existing.acknowledgement) !== JSON.stringify(value)) throw new DialogueConflict("反映結果が既存記録と一致しません。");
      this.db.prepare("UPDATE sprint_dialogue_events SET acknowledgement=? WHERE id=? AND acknowledgement IS NULL").run(JSON.stringify(value), id);
      return this.event(id)!;
    })();
  }
  claimResult(id: string): boolean { return this.db.prepare("UPDATE sprint_dialogue_events SET intent=1 WHERE id=? AND intent=0").run(id).changes === 1; }
  resultRejected(id: string): void { this.db.prepare("UPDATE sprint_dialogue_events SET intent=0 WHERE id=? AND delivered=0").run(id); }
  resultDelivered(id: string): void { this.db.prepare("UPDATE sprint_dialogue_events SET delivered=1 WHERE id=?").run(id); }
  enqueueConversation(id: string, dialogueId: string, prompt: string, now: number): void {
    this.db.transaction(() => {
      if (this.db.prepare("SELECT id FROM sprint_dialogue_conversations WHERE id=?").get(id)) return;
      const count = this.db.prepare("SELECT count(*) AS n FROM sprint_dialogue_conversations WHERE status IN ('queued','running')").get() as { n: number };
      if (count.n >= 20) throw new DialogueConflict("相談の待ち行列が満杯です。時間を置いて投稿してください。");
      this.db.prepare("INSERT INTO sprint_dialogue_conversations (id,dialogue_id,prompt,created_at) VALUES (?,?,?,?)").run(id, dialogueId, prompt, now);
    })();
  }
  private decodeConversation(raw: unknown): Conversation {
    const r = raw as { id: string; dialogue_id: string; prompt: string; status: Conversation['status']; output: string; created_at: number; started_at: number | null; delivered: number; intent: number };
    return { id: r.id, dialogueId: r.dialogue_id, prompt: r.prompt, status: r.status, output: r.output, createdAt: r.created_at, startedAt: r.started_at, delivered: !!r.delivered, intent: !!r.intent };
  }
  claimConversation(now: number): Conversation | null {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE sprint_dialogue_conversations SET status='unknown',output='相談の生成が中断しました。結果不明のため自動再実行していません。改めて相談内容を投稿してください。' WHERE status='running' AND started_at<?").run(now - 180000);
      if (this.db.prepare("SELECT id FROM sprint_dialogue_conversations WHERE status='running'").get()) return null;
      const r = this.db.prepare("SELECT * FROM sprint_dialogue_conversations WHERE status='queued' ORDER BY rowid LIMIT 1").get();
      if (!r) return null;
      const row = this.decodeConversation(r);
      this.db.prepare("UPDATE sprint_dialogue_conversations SET status='running',started_at=? WHERE id=?").run(now, row.id);
      return { ...row, status: 'running' as const, startedAt: now };
    })();
  }
  finishConversation(id: string, output: string, unknown = false): void { this.db.prepare("UPDATE sprint_dialogue_conversations SET status=?,output=? WHERE id=? AND status='running'").run(unknown ? 'unknown' : 'completed', output.slice(0, 16000), id); }
  conversationDeliveries(): Conversation[] { return this.db.prepare("SELECT * FROM sprint_dialogue_conversations WHERE status IN ('completed','unknown') AND delivered=0 ORDER BY rowid LIMIT 50").all().map(r => this.decodeConversation(r)); }
  recentConversation(dialogueId: string): Conversation[] { return this.db.prepare("SELECT * FROM sprint_dialogue_conversations WHERE dialogue_id=? AND status='completed' ORDER BY rowid DESC LIMIT 6").all(dialogueId).map(r => this.decodeConversation(r)).reverse(); }
  claimConversationDelivery(id: string): boolean { return this.db.prepare("UPDATE sprint_dialogue_conversations SET intent=1 WHERE id=? AND intent=0").run(id).changes === 1; }
  conversationRejected(id: string): void { this.db.prepare("UPDATE sprint_dialogue_conversations SET intent=0 WHERE id=? AND delivered=0").run(id); }
  conversationDelivered(id: string): void { this.db.prepare("UPDATE sprint_dialogue_conversations SET delivered=1 WHERE id=?").run(id); }
}
