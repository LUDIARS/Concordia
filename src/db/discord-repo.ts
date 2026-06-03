// Discord-UI 統合用の SQLite repo (spec/discord-ui.md)。
// 4 table: discord_config / discord_session_channels / discord_message_map /
// chat_message_reactions の最小 CRUD を提供する.

import type { Database } from "better-sqlite3";

const nowSec = (): number => Math.floor(Date.now() / 1000);

// ─── discord_config (key/value) ─────────────────────────────────────────

export interface DiscordConfigRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  all(): Record<string, string>;
}

export function makeDiscordConfigRepo(db: Database): DiscordConfigRepo {
  return {
    get(key) {
      const row = db.prepare("SELECT value FROM discord_config WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO discord_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },
    delete(key) {
      db.prepare("DELETE FROM discord_config WHERE key = ?").run(key);
    },
    all() {
      const rows = db.prepare("SELECT key, value FROM discord_config").all() as {
        key: string;
        value: string;
      }[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
  };
}

// ─── discord_session_channels ────────────────────────────────────────────

export type DiscordSessionStatus = "active" | "lost" | "ended";

export interface DiscordSessionChannelRow {
  session_id: string;
  channel_id: string;
  webhook_id: string | null;
  webhook_token: string | null;
  status: DiscordSessionStatus;
  last_rename_ts: number;
  ts: number;
}

export interface DiscordSessionChannelsRepo {
  findBySessionId(sessionId: string): DiscordSessionChannelRow | null;
  findByChannelId(channelId: string): DiscordSessionChannelRow | null;
  upsert(input: {
    session_id: string;
    channel_id: string;
    webhook_id?: string | null;
    webhook_token?: string | null;
    status?: DiscordSessionStatus;
  }): void;
  setWebhook(sessionId: string, webhookId: string, webhookToken: string): void;
  /** session 行の webhook_id / webhook_token を NULL に戻す (webhook 削除時)。 */
  clearWebhook(sessionId: string): void;
  setStatus(sessionId: string, status: DiscordSessionStatus): void;
  /**
   * channel rename 直前に呼び、 5 分以内に rename 済なら false を返す
   * (rate limit guard)。 真を返したら ts も更新する。
   */
  tryClaimRename(sessionId: string, cooldownSec: number, now?: number): boolean;
  listActive(): DiscordSessionChannelRow[];
  listAll(): DiscordSessionChannelRow[];
  deleteBySessionId(sessionId: string): void;
}

export function makeDiscordSessionChannelsRepo(db: Database): DiscordSessionChannelsRepo {
  return {
    findBySessionId(sessionId) {
      return (
        (db
          .prepare("SELECT * FROM discord_session_channels WHERE session_id = ?")
          .get(sessionId) as DiscordSessionChannelRow | undefined) ?? null
      );
    },
    findByChannelId(channelId) {
      return (
        (db
          .prepare("SELECT * FROM discord_session_channels WHERE channel_id = ?")
          .get(channelId) as DiscordSessionChannelRow | undefined) ?? null
      );
    },
    upsert(input) {
      db.prepare(
        `INSERT INTO discord_session_channels
           (session_id, channel_id, webhook_id, webhook_token, status, last_rename_ts, ts)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           channel_id     = excluded.channel_id,
           webhook_id     = COALESCE(excluded.webhook_id,     discord_session_channels.webhook_id),
           webhook_token  = COALESCE(excluded.webhook_token,  discord_session_channels.webhook_token),
           status         = excluded.status,
           ts             = excluded.ts`,
      ).run(
        input.session_id,
        input.channel_id,
        input.webhook_id ?? null,
        input.webhook_token ?? null,
        input.status ?? "active",
        nowSec(),
      );
    },
    setWebhook(sessionId, webhookId, webhookToken) {
      db.prepare(
        `UPDATE discord_session_channels SET webhook_id = ?, webhook_token = ? WHERE session_id = ?`,
      ).run(webhookId, webhookToken, sessionId);
    },
    clearWebhook(sessionId) {
      db.prepare(
        `UPDATE discord_session_channels SET webhook_id = NULL, webhook_token = NULL WHERE session_id = ?`,
      ).run(sessionId);
    },
    setStatus(sessionId, status) {
      db.prepare(
        `UPDATE discord_session_channels SET status = ? WHERE session_id = ?`,
      ).run(status, sessionId);
    },
    tryClaimRename(sessionId, cooldownSec, now = nowSec()) {
      const row = db
        .prepare("SELECT last_rename_ts FROM discord_session_channels WHERE session_id = ?")
        .get(sessionId) as { last_rename_ts: number } | undefined;
      if (!row) return false;
      if (now - row.last_rename_ts < cooldownSec) return false;
      db.prepare(
        `UPDATE discord_session_channels SET last_rename_ts = ? WHERE session_id = ?`,
      ).run(now, sessionId);
      return true;
    },
    listActive() {
      return db
        .prepare("SELECT * FROM discord_session_channels WHERE status = 'active'")
        .all() as DiscordSessionChannelRow[];
    },
    listAll() {
      return db
        .prepare("SELECT * FROM discord_session_channels")
        .all() as DiscordSessionChannelRow[];
    },
    deleteBySessionId(sessionId) {
      db.prepare("DELETE FROM discord_session_channels WHERE session_id = ?").run(sessionId);
    },
  };
}

// ─── discord_message_map (Discord message_id → chat_messages.id) ─────────

export interface DiscordMessageMapRepo {
  /** Discord に投稿成功後に呼ぶ. 既知の chat_messages.id を紐付ける. */
  put(discordMessageId: string, chatMessageId: number): void;
  /** Reaction 受信時に chat_messages.id を逆引きする. */
  findChatId(discordMessageId: string): number | null;
}

export function makeDiscordMessageMapRepo(db: Database): DiscordMessageMapRepo {
  return {
    put(discordMessageId, chatMessageId) {
      db.prepare(
        `INSERT INTO discord_message_map (discord_message_id, chat_message_id, ts) VALUES (?, ?, ?)
         ON CONFLICT(discord_message_id) DO UPDATE SET chat_message_id = excluded.chat_message_id`,
      ).run(discordMessageId, chatMessageId, nowSec());
    },
    findChatId(discordMessageId) {
      const row = db
        .prepare("SELECT chat_message_id FROM discord_message_map WHERE discord_message_id = ?")
        .get(discordMessageId) as { chat_message_id: number } | undefined;
      return row?.chat_message_id ?? null;
    },
  };
}

// ─── chat_message_reactions ──────────────────────────────────────────────

export type ReactionKind = "fine" | "bad" | `raw:${string}`;

/**
 * Discord emoji を Concordia の reaction kind に正規化する.
 *  - 👍 / ✅ / ❤️ (各種 hearts) → 'fine'
 *  - 👎 / ❌  → 'bad'
 *  - その他   → 'raw:<emoji>'
 */
export function classifyEmoji(emoji: string): ReactionKind {
  const fine = new Set(["👍", "✅", "❤️", "♥️", "💖", "🩷", "❤", "🟢"]);
  const bad = new Set(["👎", "❌", "🟥", "💢"]);
  if (fine.has(emoji)) return "fine";
  if (bad.has(emoji)) return "bad";
  return `raw:${emoji}`;
}

export interface ChatMessageReactionsRepo {
  add(input: { message_id: number; discord_user_id: string; kind: ReactionKind }): void;
  remove(input: { message_id: number; discord_user_id: string; kind: ReactionKind }): void;
  countByMessage(messageId: number): { fine: number; bad: number; other: number };
}

export function makeChatMessageReactionsRepo(db: Database): ChatMessageReactionsRepo {
  return {
    add(input) {
      db.prepare(
        `INSERT INTO chat_message_reactions (message_id, discord_user_id, kind, ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, discord_user_id, kind) DO NOTHING`,
      ).run(input.message_id, input.discord_user_id, input.kind, nowSec());
    },
    remove(input) {
      db.prepare(
        `DELETE FROM chat_message_reactions
         WHERE message_id = ? AND discord_user_id = ? AND kind = ?`,
      ).run(input.message_id, input.discord_user_id, input.kind);
    },
    countByMessage(messageId) {
      const rows = db
        .prepare(
          `SELECT kind, COUNT(*) as n FROM chat_message_reactions
           WHERE message_id = ? GROUP BY kind`,
        )
        .all(messageId) as { kind: string; n: number }[];
      let fine = 0;
      let bad = 0;
      let other = 0;
      for (const r of rows) {
        if (r.kind === "fine") fine = r.n;
        else if (r.kind === "bad") bad = r.n;
        else other += r.n;
      }
      return { fine, bad, other };
    },
  };
}

export interface DiscordPendingQuestionRow {
  id: number;
  session_id: string;
  question: string;
  options_json: string;
  discord_message_id: string | null;
  answered_at: number | null;
  answer_index: number | null;
  answer_text: string | null;
  ts: number;
}

/**
 * Pending question の option entry.
 *   - 旧形式: `string` (label のみ)
 *   - 新形式: `{ label, description? }` (Claude AskUserQuestion の option schema)
 * 内部では常に `{ label, description? }` に正規化して保存する.
 */
export interface PendingQuestionOption {
  label: string;
  description?: string;
}

export interface DiscordPendingQuestionsRepo {
  insert(input: {
    session_id: string;
    question: string;
    options: Array<PendingQuestionOption | string>;
  }): DiscordPendingQuestionRow;
  setDiscordMessageId(id: number, discordMessageId: string): void;
  markAnswered(id: number, answerIndex: number, answerText: string): void;
  /**
   * picker がローカル（端末キーボード）で回答され、リモート回答なしに解決した場合に
   * 呼ぶ。answered_at を立てて以後の answer-question / ボタン押下を弾く（stray 注入防止）。
   * answer_index は null（リモート選択ではないため）。
   */
  markResolvedLocally(id: number): void;
  findById(id: number): DiscordPendingQuestionRow | null;
  findLatestUnanswered(sessionId: string): DiscordPendingQuestionRow | null;
}

/** options_json を `PendingQuestionOption[]` にパースする (旧形式 string[] も対応). */
export function parsePendingQuestionOptions(optionsJson: string): PendingQuestionOption[] {
  let raw: unknown;
  try {
    raw = JSON.parse(optionsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PendingQuestionOption[] = [];
  for (const opt of raw) {
    if (typeof opt === "string") {
      if (opt.trim()) out.push({ label: opt.trim() });
      continue;
    }
    if (opt && typeof opt === "object") {
      const label = (opt as { label?: unknown }).label;
      const description = (opt as { description?: unknown }).description;
      if (typeof label === "string" && label.trim()) {
        const normalized: PendingQuestionOption = { label: label.trim() };
        if (typeof description === "string" && description.trim()) {
          normalized.description = description.trim();
        }
        out.push(normalized);
      }
    }
  }
  return out;
}

export function makeDiscordPendingQuestionsRepo(db: Database): DiscordPendingQuestionsRepo {
  return {
    insert(input) {
      const ts = nowSec();
      // 旧形式 string も新形式 {label, description?} も受け入れ、 保存時に正規化する.
      const normalized: PendingQuestionOption[] = input.options
        .map((o) => (typeof o === "string" ? ({ label: o } as PendingQuestionOption) : o))
        .filter((o) => typeof o.label === "string" && o.label.trim().length > 0);
      const info = db.prepare(
        `INSERT INTO discord_pending_questions (session_id, question, options_json, ts)
         VALUES (?, ?, ?, ?)`,
      ).run(input.session_id, input.question, JSON.stringify(normalized), ts);
      return this.findById(Number(info.lastInsertRowid))!;
    },
    setDiscordMessageId(id, discordMessageId) {
      db.prepare(
        `UPDATE discord_pending_questions SET discord_message_id = ? WHERE id = ?`,
      ).run(discordMessageId, id);
    },
    markAnswered(id, answerIndex, answerText) {
      db.prepare(
        `UPDATE discord_pending_questions
         SET answered_at = ?, answer_index = ?, answer_text = ?
         WHERE id = ?`,
      ).run(nowSec(), answerIndex, answerText, id);
    },
    markResolvedLocally(id) {
      db.prepare(
        `UPDATE discord_pending_questions
         SET answered_at = ?, answer_index = NULL, answer_text = '(resolved locally)'
         WHERE id = ? AND answered_at IS NULL`,
      ).run(nowSec(), id);
    },
    findById(id) {
      return (
        (db
          .prepare("SELECT * FROM discord_pending_questions WHERE id = ?")
          .get(id) as DiscordPendingQuestionRow | undefined) ?? null
      );
    },
    findLatestUnanswered(sessionId) {
      return (
        (db
          .prepare(
            `SELECT * FROM discord_pending_questions
             WHERE session_id = ? AND answered_at IS NULL
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId) as DiscordPendingQuestionRow | undefined) ?? null
      );
    },
  };
}
