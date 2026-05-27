/**
 * Concordia dispatcher — チャット発話 / レビュー / 通知 task の発火集約.
 *
 * **チャット発話判断は完全に Concordia 側 (静的アルゴリズム)**.
 * AI 側は受け取った task を実行するだけで、 自分で「雑談しよう」とは判断しない.
 *
 * 静的ルール (v0.1):
 *  - **topic shift** (新領域に作業がスライド): 70% で 新規領域雑談 (NEW_AREA seed)
 *  - **work count per session が 5 の倍数** (edit + tool_call 等の作業 event): 100% で 軽レビュー
 *  - **完全ランダム** (低確率 5%): 純粋雑談 (PURE_CHITCHAT seed)
 *  - chat post 後: 他 active session に chat-reply (chitchat 30% / consultation 50%)
 *  - sweeper の active→lost: 全 active session に session-departed
 *  - DELETE /v1/sessions/:id: 当該 session に daily-report
 *
 * 強制ルール:
 *  - **深夜帯 (23:00–翌05:00)**: 上記の能動的な雑談 / 軽レビュー / chat-reply の
 *    発火頻度を一律 1/10 に抑制する (shared/quiet-hours.ts). session 離脱通知 /
 *    daily-report などのライフサイクル通知は対象外 (取りこぼすと困るため).
 */

import type { SessionsRepo } from "./db/sessions-repo.js";
import type { TasksRepo } from "./db/tasks-repo.js";
import type { ChatChannel, ChatRepo } from "./db/chat-repo.js";
import type { SessionRow } from "./shared/types.js";
import { predictRole } from "./role/predict.js";
import { detectTopicShift } from "./triggers/topic-change.js";
import {
  pickNewAreaSeed,
  pickPureChitchatSeed,
  pickReviewIntroSeed,
} from "./triggers/seeds.js";
import { actionFrequencyMultiplier } from "./shared/quiet-hours.js";
import { createChildLogger } from "./shared/logger.js";

const dispatcherLog = createChildLogger("dispatcher");
const VERBOSE = "[verbose-cs-bug]";

const TOPIC_SHIFT_PROBABILITY = 0.7;
const RANDOM_CHITCHAT_PROBABILITY = 0.05;
const WORK_COUNT_REVIEW_PERIOD = 5;
const REPLY_PROBABILITY_BY_CHANNEL: Record<ChatChannel, number> = {
  chitchat: 0.3,
  consultation: 0.5,
  "報告": 0.8,   // 独白を見たら反応する確率高め
  system: 0,
};

const WORK_KINDS = new Set(["edit", "tool_call", "task_update"]);

/** peer-log-react は同 source から短時間連発しないよう per-source-key で cooldown する. */
const PEER_LOG_REACT_COOLDOWN_SEC = 60;

/** peer-log-react で扱う log event 種別. */
export type LogEventKind =
  | "rule.add"
  | "rule.remove"
  | "rule.fire"
  | "session.started"
  | "skill.poison-spike";

export interface LogEventInput {
  kind: LogEventKind;
  /** 発生源 session_id (あれば). この session は通知対象から除外する. */
  source_session_id?: string | null;
  /** AI が反応するときに参考にする情報. UI 表示でなく chat 投稿の素材. */
  summary: string;
  /** 関連 entity (rule_id / skill_name 等). cooldown key にも使う. */
  ref?: string | null;
  /** 任意の構造化 payload. */
  detail?: Record<string, unknown>;
}

export interface DispatcherDeps {
  sessions: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  rng?: () => number;
  /** 深夜帯判定に使う現在時刻プロバイダ. 既定はシステム時計 (テスト用に注入可). */
  now?: () => Date;
  /**
   * Runtime kill-switch for chat-related enqueues (chitchat-suggest,
   * chat-reply, peer-log-react, daily-report). When the returned value
   * is true, enqueue methods early-return and emit nothing. Wired from
   * AdminState.getChatMuted in production; tests can pass () => false.
   */
  isChatMuted?: () => boolean;
}

export class Dispatcher {
  private rng: () => number;
  private now: () => Date;
  /** peer-log-react cooldown 管理: key = `${kind}|${ref ?? source}` → last_dispatched_sec */
  private logCooldown = new Map<string, number>();
  /** active peer の round-robin index. 偏らせない. */
  private peerCursor = 0;
  private isChatMuted: () => boolean;

  constructor(private readonly deps: DispatcherDeps) {
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? (() => new Date());
    this.isChatMuted = deps.isChatMuted ?? (() => false);
  }

  /** session_event insert 後に呼ぶ. 発火条件を全部評価する */
  onEventAppended(session: SessionRow, _eventCount: number): void {
    // chat 全停止スイッチが入っているなら chitchat / chat-reply / 雑談関連を
    // 一切 enqueue しない. role 推定だけ走らせて metadata 保持し、 task 列は触らない.
    if (this.isChatMuted()) {
      this.refreshRole(session);
      return;
    }
    const recent = this.deps.sessions.recentEvents(session.id, 30);
    const role = this.refreshRole(session, recent);
    // 強制ルール: 深夜帯 (23:00–翌05:00) は能動的な発火頻度を 1/10 に抑制する.
    const freq = actionFrequencyMultiplier(this.now());

    // 1. topic shift 検出 — 新領域雑談
    if (recent.length >= 2) {
      const newest = recent[0];
      const previous = recent.slice(1).reverse(); // 古い→新しい順
      if (detectTopicShift(previous, newest) && this.rng() < TOPIC_SHIFT_PROBABILITY * freq) {
        this.enqueueChitchat(session, role, "new-area", pickNewAreaSeed(this.rng), recent);
        return;
      }
    }

    // 2. work count == n*5 — 軽レビュー (深夜帯は freq で確率的に間引く)
    const workCount = countWorkEvents(recent);
    if (workCount > 0 && workCount % WORK_COUNT_REVIEW_PERIOD === 0 && this.rng() < freq) {
      const total = this.deps.sessions.countEvents(session.id);
      this.deps.tasks.enqueue({
        session_id: session.id,
        kind: "review-summary",
        payload: {
          role,
          last_n: WORK_COUNT_REVIEW_PERIOD,
          total_events: total,
          recent_summary: recent.slice(0, WORK_COUNT_REVIEW_PERIOD).map(serializeEvent),
          intro_seed: pickReviewIntroSeed(this.rng),
          instructions:
            "直近 5 件の作業 (edit/tool_call/task_update) を 3 行で振り返る. " +
            "うまくいったこと / 引っかかってること / 次の手 の 3 点で chitchat channel に POST.",
        },
      });
      return;
    }

    // 3. 完全ランダム — 純粋雑談
    if (this.rng() < RANDOM_CHITCHAT_PROBABILITY * freq) {
      this.enqueueChitchat(session, role, "pure", pickPureChitchatSeed(this.rng), recent);
    }
  }

  onChatPosted(message: {
    id: number;
    channel: ChatChannel;
    session_id: string | null;
    text: string;
    author_label: string;
    is_actionable: boolean;
  }): void {
    if (message.channel === "system") return;
    // 強制ルール: 深夜帯 (23:00–翌05:00) は chat-reply の確率も 1/10 に抑制する.
    const freq = actionFrequencyMultiplier(this.now());
    const replyProb =
      (REPLY_PROBABILITY_BY_CHANNEL[message.channel] ?? 0) * freq;

    const peers = this.deps.sessions.listSessions({ status: "active" });
    dispatcherLog.info(
      {
        message_id: message.id,
        source_session_id: message.session_id,
        channel: message.channel,
        author_label: message.author_label,
        reply_prob: replyProb,
        freq_multiplier: freq,
        active_peer_count: peers.length,
        active_peer_ids: peers.map((p) => p.id),
      },
      `${VERBOSE} dispatcher.onChatPosted entry`,
    );
    const enqueued: string[] = [];
    const skippedSelf: string[] = [];
    const skippedProb: string[] = [];
    for (const peer of peers) {
      if (peer.id === message.session_id) { skippedSelf.push(peer.id); continue; }
      if (this.rng() >= replyProb) { skippedProb.push(peer.id); continue; }

      const role = this.refreshRole(peer);
      this.deps.tasks.enqueue({
        session_id: peer.id,
        kind: "chat-reply",
        payload: {
          role,
          target_message_id: message.id,
          target_channel: message.channel,
          target_text: message.text,
          target_author: message.author_label,
          is_actionable_suggestion: message.is_actionable,
          instructions: message.is_actionable
            ? "★action-suggesting メッセージ. 直接実行せず、 まずユーザに『この提案を取り入れますか?』と確認. reply 自体は短文で OK."
            : "短い reply を 1 文、 ロールのトーンで投稿. AI 同士の対話前提なので人間配慮は不要.",
        },
      });
      enqueued.push(peer.id);
    }
    dispatcherLog.info(
      {
        message_id: message.id,
        source_session_id: message.session_id,
        enqueued_peer_ids: enqueued,
        skipped_self: skippedSelf,
        skipped_by_probability: skippedProb,
      },
      `${VERBOSE} dispatcher.onChatPosted result`,
    );
  }

  onSessionLost(lost: SessionRow): void {
    const role = this.parseRole(lost);
    const lastTask = lost.current_task ?? "(不明)";
    const peers = this.deps.sessions.listSessions({ status: "active" });
    for (const peer of peers) {
      this.deps.tasks.enqueue({
        session_id: peer.id,
        kind: "session-departed",
        payload: {
          lost_session_id: lost.id,
          lost_role: role,
          lost_branch: lost.branch,
          lost_repo: lost.repo_path,
          last_task: lastTask,
          instructions:
            "離脱通知. 残作業に介入が必要そうなら chitchat に一言流すか、 ユーザに伝える程度で十分.",
        },
      });
    }
  }

  /**
   * 動作ログ更新を 1 active peer に exclusive 通知する.
   *
   * - source_session_id を除外し、 round-robin で 1 peer を選ぶ
   * - 60 秒 cooldown (kind+ref キー単位) で連発抑制
   * - pending_tasks に enqueue するので 1 task = 1 session = 1 回だけ pull される (排他)
   * - 反応の中身は AI 側 (skill) に委ねる: chat 投稿 / 静観 / ユーザに伝達
   */
  onLogUpdate(ev: LogEventInput): void {
    if (this.isChatMuted()) return;
    const now = Math.floor(Date.now() / 1000);
    const key = `${ev.kind}|${ev.ref ?? ev.source_session_id ?? ""}`;
    const last = this.logCooldown.get(key) ?? 0;
    if (now - last < PEER_LOG_REACT_COOLDOWN_SEC) return;

    const peers = this.deps.sessions.listSessions({ status: "active" })
      .filter((s) => s.id !== ev.source_session_id);
    if (peers.length === 0) return;

    // round-robin: cursor を peers の数で取り回す. log 量が多い時に偏らない.
    const target = peers[this.peerCursor % peers.length];
    this.peerCursor = (this.peerCursor + 1) % Math.max(1, peers.length);
    this.logCooldown.set(key, now);

    const role = this.refreshRole(target);
    this.deps.tasks.enqueue({
      session_id: target.id,
      kind: "peer-log-react",
      payload: {
        role,
        log_kind: ev.kind,
        ref: ev.ref ?? null,
        source_session_id: ev.source_session_id ?? null,
        summary: ev.summary,
        detail: ev.detail ?? {},
        instructions:
          "Concordia の動作ログ更新 通知. " +
          "summary を読んで、 自分のロールで chitchat (or consultation) に 1 文 reaction を出すか、 言うべきことが無ければ skip. " +
          "他 peer も同じ event を見ている可能性があるので、 同じ趣旨の重複投稿はしない (この task 自体は 1 peer にしか届かないので排他).",
      },
    });
  }

  onSessionEnd(session: SessionRow, bullets: object): void {
    if (this.isChatMuted()) return;
    const role = this.refreshRole(session);
    this.deps.tasks.enqueue({
      session_id: session.id,
      kind: "daily-report",
      payload: {
        role,
        bullets,
        instructions:
          "本日のセッション終了. ロールに沿った 1〜2 段落の感想文 (ハイライト / 引っかかり / 明日への一言) を書き、 " +
          `POST /v1/reports/${session.id}/append { "role": "${role}", "monologue": "<text>" } で追記.`,
      },
    });
  }

  private enqueueChitchat(
    session: SessionRow,
    role: string,
    kind: "new-area" | "pure",
    seed: string,
    recent: ReturnType<SessionsRepo["recentEvents"]>,
  ): void {
    this.deps.tasks.enqueue({
      session_id: session.id,
      kind: "chitchat-suggest",
      payload: {
        role,
        chitchat_kind: kind,
        seed,
        recent_summary: recent.slice(0, 5).map(serializeEvent),
        instructions:
          kind === "new-area"
            ? `新領域に作業が移った. 「${seed}」のテイストで 1 文の雑談を chitchat に POST. 人間配慮不要、 AI 向けの口調で.`
            : `特に意味のない雑談時間. 「${seed}」のテイストで 1 文を chitchat に POST. 人間配慮不要.`,
      },
    });
  }

  private refreshRole(
    session: SessionRow,
    recentEvents?: ReturnType<SessionsRepo["recentEvents"]>,
  ): string {
    const meta = parseMeta(session.metadata);
    // persona が assign 済の session は role_label を固定する.
    // session-end (DELETE) で release されるまで人格はぶれない.
    if (meta.persona_id && typeof meta.role_label === "string") {
      return meta.role_label;
    }
    const events = recentEvents ?? this.deps.sessions.recentEvents(session.id, 200);
    const role = predictRole(events);
    if (meta.role_label !== role) {
      meta.role_label = role;
      this.deps.sessions.setMetadata(session.id, JSON.stringify(meta));
    }
    return role;
  }

  private parseRole(session: SessionRow): string {
    return parseMeta(session.metadata).role_label ?? "雑用係";
  }
}

function countWorkEvents(events: ReturnType<SessionsRepo["recentEvents"]>): number {
  let n = 0;
  for (const ev of events) if (WORK_KINDS.has(ev.kind)) n++;
  return n;
}

function serializeEvent(ev: { kind: string; ts: number; payload: string }) {
  return { kind: ev.kind, ts: ev.ts, payload: safeParse(ev.payload) };
}

function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}
