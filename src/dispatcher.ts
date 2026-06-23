/**
 * Concordia dispatcher — チャット発話の発火集約 (決定的トリガ).
 *
 * **発話判断は完全に Concordia 側 (静的アルゴリズム)**. 何を喋るかは 2 系統:
 *
 *  - **セッション帰属の発話** (あるセッションの persona が喋るもの) は、 その
 *    セッションのタスクキューに chat task を積み、 **セッション側エージェント
 *    (= そのセッションの LLM, 作業メモリを持つ)** に書かせる. これにより発話が
 *    そのセッションの記憶 / 文脈を反映する. 対象: 雑談 (chitchat-suggest) /
 *    軽レビュー (review-summary) / peer 返信 (chat-reply) / ログ反応 (peer-log-react).
 *  - **Concordia 自身の声** (司会の口火・離脱告知) は中央 Haiku レスポンダ
 *    (chat/responder.ts) が描画する. 特定セッションの記憶に依存しないため安価でよい.
 *
 * 静的トリガ:
 *  - **topic shift** (新領域へ作業がスライド): 70% で新規領域雑談 (→ session LLM)
 *  - **work count が 5 の倍数**: 軽レビュー (→ session LLM)
 *  - **完全ランダム** (低確率 5%): 純粋雑談 (→ session LLM)
 *  - chat post 後: 他 active session が返信 (channel 別確率, → session LLM)
 *  - session lost: 司会が離脱を 1 件告知 (→ 中央 Haiku)
 *  - 動作ログ更新: 1 active peer が反応 (→ session LLM)
 *
 * 強制ルール: 深夜帯 (23:00–翌05:00) は能動発火を一律 1/10 に抑制 (shared/quiet-hours.ts).
 */

import type { SessionsRepo } from "./db/sessions-repo.js";
import type { TasksRepo } from "./db/tasks-repo.js";
import type { ChatChannel, ChatRepo } from "./db/chat-repo.js";
import type { SessionRow } from "./shared/types.js";
import type { ChatResponder } from "./chat/responder.js";
import { MAX_REPLY_DEPTH } from "./chat/responder.js";
import { predictRole } from "./role/predict.js";
import { detectTopicShift } from "./triggers/topic-change.js";
import { pickNewAreaSeed, pickPureChitchatSeed, pickReviewIntroSeed } from "./triggers/seeds.js";
import { actionFrequencyMultiplier } from "./shared/quiet-hours.js";
import { createChildLogger } from "./shared/logger.js";

const dispatcherLog = createChildLogger("dispatcher");

const TOPIC_SHIFT_PROBABILITY = 0.7;
const RANDOM_CHITCHAT_PROBABILITY = 0.05;
const WORK_COUNT_REVIEW_PERIOD = 5;
const REPLY_PROBABILITY_BY_CHANNEL: Record<ChatChannel, number> = {
  chitchat: 0.3,
  consultation: 0.5,
  "報告": 0.8,
  "ぼやき": 0.2,
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
  source_session_id?: string | null;
  summary: string;
  ref?: string | null;
  detail?: Record<string, unknown>;
}

export interface DispatcherDeps {
  sessions: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  /** Concordia 自身の声 (司会 / 離脱告知) の中央 Haiku 描画用. */
  responder: ChatResponder;
  rng?: () => number;
  /** 深夜帯判定に使う現在時刻プロバイダ. 既定はシステム時計 (テスト用に注入可). */
  now?: () => Date;
  /** chat 全停止スイッチ. true で能動発火しない. */
  isChatMuted?: () => boolean;
  /** コスト予算超過スイッチ. true で全 dispatch を止める. */
  isCostBlocked?: () => boolean;
}

export class Dispatcher {
  private rng: () => number;
  private now: () => Date;
  /** peer-log-react cooldown: key = `${kind}|${ref ?? source}` → last_dispatched_sec */
  private logCooldown = new Map<string, number>();
  private peerCursor = 0;
  private isChatMuted: () => boolean;
  private isCostBlocked: () => boolean;

  constructor(private readonly deps: DispatcherDeps) {
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? (() => new Date());
    this.isChatMuted = deps.isChatMuted ?? (() => false);
    this.isCostBlocked = deps.isCostBlocked ?? (() => false);
  }

  /** session_event insert 後に呼ぶ. 発火条件を全部評価する */
  onEventAppended(session: SessionRow, _eventCount: number): void {
    if (this.isChatMuted() || this.isCostBlocked()) {
      this.refreshRole(session);
      return;
    }
    const recent = this.deps.sessions.recentEvents(session.id, 30);
    const role = this.refreshRole(session, recent);
    const freq = actionFrequencyMultiplier(this.now());

    // 1. topic shift 検出 — 新領域雑談
    if (recent.length >= 2) {
      const newest = recent[0];
      const previous = recent.slice(1).reverse();
      if (detectTopicShift(previous, newest) && this.rng() < TOPIC_SHIFT_PROBABILITY * freq) {
        this.enqueueChitchat(session, role, "new-area", pickNewAreaSeed(this.rng), recent);
        return;
      }
    }

    // 2. work count == n*5 — 軽レビュー
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

  /**
   * chat 投稿後に呼ぶ. 他 active session が **自分の LLM で** 返信する
   * (chat-reply task をキューに積む = セッションの記憶を反映した返信).
   *
   * replyDepth は中央レスポンダ (司会) 起点の連鎖を止めるための guard.
   * セッション LLM の返信は /v1/chat 経由で depth 0 として戻るため、 連鎖の
   * 主たる減衰は channel 別確率に委ねる (旧来動作と同じ).
   */
  onChatPosted(
    message: {
      id: number;
      channel: ChatChannel;
      session_id: string | null;
      text: string;
      author_label: string;
      is_actionable: boolean;
    },
    replyDepth = 0,
  ): void {
    if (message.channel === "system") return;
    if (this.isCostBlocked()) return;
    if (replyDepth >= MAX_REPLY_DEPTH) return; // 司会起点の連鎖暴走を止める

    const freq = actionFrequencyMultiplier(this.now());
    const replyProb = (REPLY_PROBABILITY_BY_CHANNEL[message.channel] ?? 0) * freq;
    const peers = this.deps.sessions.listSessions({ status: "active" });

    const enqueued: string[] = [];
    for (const peer of peers) {
      if (peer.id === message.session_id) continue;
      if (this.rng() >= replyProb) continue;
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
      { message_id: message.id, source_session_id: message.session_id, reply_depth: replyDepth, replied_peer_ids: enqueued },
      "dispatcher.onChatPosted fanout (session LLM)",
    );
  }

  /** session lost 時. 司会が 1 件だけ離脱を告知する (Concordia 自身の声 = 中央 Haiku). */
  onSessionLost(lost: SessionRow): void {
    if (this.isChatMuted() || this.isCostBlocked()) return;
    const role = this.parseRole(lost);
    const lastTask = lost.current_task ?? "(不明)";
    const peers = this.deps.sessions.listSessions({ status: "active" });
    if (peers.length === 0) return;
    void this.deps.responder
      .speak({
        channel: "chitchat",
        intent: "notice",
        sessionId: null, // 司会
        context: {
          extra:
            `セッション離脱: ${role} (${repoBase(lost.repo_path)}, branch ${lost.branch ?? "-"})。 ` +
            `残作業: ${lastTask}。 介入が要りそうなら一言。`,
          recent: this.recentChatLines(),
        },
      })
      .catch(() => {});
  }

  /**
   * 動作ログ更新を 1 active peer に exclusive 通知する (peer-log-react task).
   * - source を除外し round-robin で 1 peer を選ぶ
   * - 60 秒 cooldown (kind+ref キー単位) で連発抑制
   * - 反応の中身はセッション側 LLM に委ねる (記憶反映)
   */
  onLogUpdate(ev: LogEventInput): void {
    if (this.isChatMuted() || this.isCostBlocked()) return;
    const now = Math.floor(Date.now() / 1000);
    const key = `${ev.kind}|${ev.ref ?? ev.source_session_id ?? ""}`;
    const last = this.logCooldown.get(key) ?? 0;
    if (now - last < PEER_LOG_REACT_COOLDOWN_SEC) return;

    const peers = this.deps.sessions
      .listSessions({ status: "active" })
      .filter((s) => s.id !== ev.source_session_id);
    if (peers.length === 0) return;

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
          "Concordia の動作ログ更新 通知. summary を読んで、 自分のロールで chitchat (or consultation) に " +
          "1 文 reaction を出すか、 言うべきことが無ければ skip. この task は 1 peer にしか届かないので排他.",
      },
    });
  }

  /**
   * session 終了時. 終了レポートの独白は report 経路 (#報告) が扱うため、
   * ここでは追加の発話を起こさない (二重投稿防止). フックは互換のため残す.
   */
  onSessionEnd(_session: SessionRow, _bullets: object): void {
    /* no-op: report 経路が独白を担う */
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

  private recentChatLines(): string[] {
    return this.deps.chat
      .list({ limit: 8 })
      .map((m) => `[${m.channel}] ${m.author_label}: ${m.text.slice(0, 80)}`);
  }

  private refreshRole(
    session: SessionRow,
    recentEvents?: ReturnType<SessionsRepo["recentEvents"]>,
  ): string {
    const meta = parseMeta(session.metadata);
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

function repoBase(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
