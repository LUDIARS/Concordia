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

/**
 * discord_config を key/value で読み書きする。
 *
 * `scope` は子会社 Bot 用の namespacing。 既定 '' (本社) は従来どおりキー無加工で、
 * 既存 DB と完全互換。 子会社は `sub:<id>` を渡すと全キーに `<scope>::` を前置し、
 * 別 guild のレイアウト (category id 等) が本社と混ざらないようにする。 all() は
 * その scope のキーのみを prefix 除去して返す (ingress の resolveMetaKind 等が
 * scope 内で閉じる)。
 */
export function makeDiscordConfigRepo(db: Database, scope = ""): DiscordConfigRepo {
  const prefix = scope ? `${scope}::` : "";
  const k = (key: string): string => `${prefix}${key}`;
  return {
    get(key) {
      const row = db.prepare("SELECT value FROM discord_config WHERE key = ?").get(k(key)) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO discord_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(k(key), value);
    },
    delete(key) {
      db.prepare("DELETE FROM discord_config WHERE key = ?").run(k(key));
    },
    all() {
      const rows = db.prepare("SELECT key, value FROM discord_config").all() as {
        key: string;
        value: string;
      }[];
      const out: Record<string, string> = {};
      for (const r of rows) {
        if (prefix) {
          if (!r.key.startsWith(prefix)) continue;
          out[r.key.slice(prefix.length)] = r.value;
        } else {
          // 本社 scope ('') は子会社キー (sub:...::) を除外する。
          if (r.key.includes("::")) continue;
          out[r.key] = r.value;
        }
      }
      return out;
    },
  };
}

// ─── discord_session_channels ────────────────────────────────────────────

export type DiscordSessionStatus = "active" | "lost" | "ended";

/**
 * チャンネル名先頭絵文字の「表示状態」。
 * status とは別軸: active 中でも working (⚙️) ⟷ active (🟢) を切り替える。
 * チャンネル名文字列から推定せず、このカラムを権威データとする (three-out redesign)。
 */
export type ChannelDisplayState = "working" | "active" | "lost" | "ended";

export interface DiscordSessionChannelRow {
  session_id: string;
  channel_id: string;
  webhook_id: string | null;
  webhook_token: string | null;
  status: DiscordSessionStatus;
  display_state: ChannelDisplayState;
  agent_type: string | null;
  name_body: string | null;
  delegation_emoji: string | null;
  last_rename_ts: number;
  scope: string;
  /** 1 = /ch_name で名前を固定 (title_renamed による name_body 上書きを抑止)。 */
  name_locked: number;
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
    display_state?: ChannelDisplayState;
    agent_type?: string | null;
    name_body?: string | null;
    delegation_emoji?: string | null;
  }): void;
  setWebhook(sessionId: string, webhookId: string, webhookToken: string): void;
  /** session 行の webhook_id / webhook_token を NULL に戻す (webhook 削除時)。 */
  clearWebhook(sessionId: string): void;
  setStatus(sessionId: string, status: DiscordSessionStatus): void;
  /**
   * /ch_name 用。 name_body を固定値に更新し name_locked=1 を立てる。
   * 以後 setDisplayState(nameBody) / title 由来の name_body 上書きを抑止する。
   */
  setNameLock(sessionId: string, nameBody: string): void;
  /** display_state / agent_type / name_body をまとめて更新する。 */
  setDisplayState(
    sessionId: string,
    displayState: ChannelDisplayState,
    agentType?: string | null,
    nameBody?: string | null,
  ): void;
  /**
   * channel rename 直前に呼び、 5 分以内に rename 済なら false を返す
   * (rate limit guard)。 真を返したら ts も更新する。
   */
  tryClaimRename(sessionId: string, cooldownSec: number, now?: number): boolean;
  listActive(): DiscordSessionChannelRow[];
  listAll(): DiscordSessionChannelRow[];
  deleteBySessionId(sessionId: string): void;
}

/**
 * `scope` は子会社 Bot 用の per-guild namespacing。 '' = 本社。 listActive/listAll は
 * scope で絞り、 upsert は行に scope を刻む。 find 系/delete 系は session_id/channel_id が
 * 全 scope 横断で一意なため scope 非依存 (1 セッションは 1 scope にしか属さない)。
 */
export function makeDiscordSessionChannelsRepo(db: Database, scope = ""): DiscordSessionChannelsRepo {
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
           (session_id, channel_id, webhook_id, webhook_token, status,
            display_state, agent_type, name_body, delegation_emoji, last_rename_ts, scope, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           webhook_id       = COALESCE(excluded.webhook_id,       discord_session_channels.webhook_id),
           webhook_token    = COALESCE(excluded.webhook_token,    discord_session_channels.webhook_token),
           status           = excluded.status,
           display_state    = excluded.display_state,
           agent_type       = COALESCE(excluded.agent_type,       discord_session_channels.agent_type),
           name_body        = COALESCE(excluded.name_body,        discord_session_channels.name_body),
           delegation_emoji = COALESCE(excluded.delegation_emoji, discord_session_channels.delegation_emoji),
           ts               = excluded.ts`,
      ).run(
        input.session_id,
        input.channel_id,
        input.webhook_id ?? null,
        input.webhook_token ?? null,
        input.status ?? "active",
        input.display_state ?? "active",
        input.agent_type ?? null,
        input.name_body ?? null,
        input.delegation_emoji ?? null,
        scope,
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
    setNameLock(sessionId, nameBody) {
      db.prepare(
        `UPDATE discord_session_channels SET name_body = ?, name_locked = 1 WHERE session_id = ?`,
      ).run(nameBody, sessionId);
    },
    setDisplayState(sessionId, displayState, agentType, nameBody) {
      if (agentType !== undefined && nameBody !== undefined) {
        db.prepare(
          `UPDATE discord_session_channels
           SET display_state = ?, agent_type = ?, name_body = ?
           WHERE session_id = ?`,
        ).run(displayState, agentType ?? null, nameBody ?? null, sessionId);
      } else if (agentType !== undefined) {
        db.prepare(
          `UPDATE discord_session_channels SET display_state = ?, agent_type = ? WHERE session_id = ?`,
        ).run(displayState, agentType ?? null, sessionId);
      } else if (nameBody !== undefined) {
        db.prepare(
          `UPDATE discord_session_channels SET display_state = ?, name_body = ? WHERE session_id = ?`,
        ).run(displayState, nameBody ?? null, sessionId);
      } else {
        db.prepare(
          `UPDATE discord_session_channels SET display_state = ? WHERE session_id = ?`,
        ).run(displayState, sessionId);
      }
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
        .prepare("SELECT * FROM discord_session_channels WHERE status = 'active' AND scope = ?")
        .all(scope) as DiscordSessionChannelRow[];
    },
    listAll() {
      return db
        .prepare("SELECT * FROM discord_session_channels WHERE scope = ?")
        .all(scope) as DiscordSessionChannelRow[];
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
  multi_select: number;
  answer_indices_json: string | null;
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
    multiSelect?: boolean;
  }): DiscordPendingQuestionRow;
  setDiscordMessageId(id: number, discordMessageId: string): void;
  markAnswered(id: number, answerIndex: number, answerText: string): void;
  /** 複数選択回答。answer_index には先頭 index、answer_indices_json に全 index を記録。 */
  markAnsweredMulti(id: number, answerIndices: number[], answerText: string): void;
  /** 自由文 (Other) 回答。answer_index は null、answer_text に本文。 */
  markAnsweredOther(id: number, answerText: string): void;
  /**
   * picker がローカル（端末キーボード）で回答され、リモート回答なしに解決した場合に
   * 呼ぶ。answered_at を立てて以後の answer-question / ボタン押下を弾く（stray 注入防止）。
   * answer_index は null（リモート選択ではないため）。
   */
  markResolvedLocally(id: number): void;
  findById(id: number): DiscordPendingQuestionRow | null;
  findLatestUnanswered(sessionId: string): DiscordPendingQuestionRow | null;
  /**
   * 同一 session で同じ question 文の **未回答** 行があれば返す (冪等化用)。
   * AskUserQuestion は picker-open 時 (PreToolUse hook) と transcript-tail
   * (回答後) の 2 経路から POST され得るので、 2 度目を重複投稿させないために使う。
   */
  findUnansweredByQuestion(sessionId: string, question: string): DiscordPendingQuestionRow | null;
  /**
   * 同一 session で同じ question 文の **最近回答済** 行があれば返す (冪等化用)。
   * picker-open での早期投稿 → 回答 → その後に transcript-tail が遅れて同じ
   * question を再 POST してくるケースで、 未回答行が無いため
   * findUnansweredByQuestion では弾けない。 回答済でも sinceTs 以降の行を拾えば
   * 「回答後に重複カードが生える」事故を防げる。
   */
  findRecentlyAnsweredByQuestion(
    sessionId: string,
    question: string,
    sinceTs: number,
  ): DiscordPendingQuestionRow | null;
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
        `INSERT INTO discord_pending_questions (session_id, question, options_json, multi_select, ts)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(input.session_id, input.question, JSON.stringify(normalized), input.multiSelect ? 1 : 0, ts);
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
    markAnsweredMulti(id, answerIndices, answerText) {
      db.prepare(
        `UPDATE discord_pending_questions
         SET answered_at = ?, answer_index = ?, answer_indices_json = ?, answer_text = ?
         WHERE id = ?`,
      ).run(nowSec(), answerIndices[0] ?? null, JSON.stringify(answerIndices), answerText, id);
    },
    markAnsweredOther(id, answerText) {
      db.prepare(
        `UPDATE discord_pending_questions
         SET answered_at = ?, answer_index = NULL, answer_text = ?
         WHERE id = ?`,
      ).run(nowSec(), answerText, id);
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
    findUnansweredByQuestion(sessionId, question) {
      return (
        (db
          .prepare(
            `SELECT * FROM discord_pending_questions
             WHERE session_id = ? AND question = ? AND answered_at IS NULL
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId, question) as DiscordPendingQuestionRow | undefined) ?? null
      );
    },
    findRecentlyAnsweredByQuestion(sessionId, question, sinceTs) {
      return (
        (db
          .prepare(
            `SELECT * FROM discord_pending_questions
             WHERE session_id = ? AND question = ?
               AND answered_at IS NOT NULL AND answered_at >= ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId, question, sinceTs) as DiscordPendingQuestionRow | undefined) ?? null
      );
    },
  };
}
