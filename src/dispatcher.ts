/**
 * Concordia dispatcher.
 *
 * trigger ルール (spec/service-schema.md §13) を集約. event append / chat
 * post / sweeper 検知時に呼ばれて、 適切な pending_tasks を enqueue する.
 *
 * Concordia 自身は LLM を呼ばない. AI への依頼内容 (payload) を組み立てるだけ.
 */

import type { SessionsRepo } from "./db/sessions-repo.js";
import type { TasksRepo } from "./db/tasks-repo.js";
import type { ChatChannel, ChatRepo } from "./db/chat-repo.js";
import type { SessionEventRow, SessionRow } from "./shared/types.js";
import { predictRole } from "./role/predict.js";

const CHITCHAT_PROBABILITY = 0.15;
const REPLY_PROBABILITY_BY_CHANNEL: Record<ChatChannel, number> = {
  chitchat: 0.3,
  consultation: 0.5,
  system: 0,
};

export interface DispatcherDeps {
  sessions: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  /** 注入可能な randomness (test 用) */
  rng?: () => number;
}

export class Dispatcher {
  private rng: () => number;
  constructor(private readonly deps: DispatcherDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  /** session_event insert 後に呼ぶ. 自身に対して chitchat / review-summary を判断 */
  onEventAppended(session: SessionRow, eventCount: number): void {
    if (this.rng() < CHITCHAT_PROBABILITY) {
      const role = this.refreshRole(session);
      this.deps.tasks.enqueue({
        session_id: session.id,
        kind: "chitchat-suggest",
        payload: {
          role,
          recent_summary: this.recentSummary(session),
          instructions:
            "現在の作業について 1 文の雑談を、 ロールのトーンで chitchat channel に POST してください。 " +
            "POST: " + this.postChatExample(session.id, role, "chitchat"),
        },
      });
    }
    if (eventCount > 0 && eventCount % 10 === 0) {
      const role = this.refreshRole(session);
      this.deps.tasks.enqueue({
        session_id: session.id,
        kind: "review-summary",
        payload: {
          role,
          last_n: 10,
          recent_summary: this.recentSummary(session, 10),
          instructions:
            "直近 10 件の作業を 3 行で振り返り、 consultation channel に投稿してください. " +
            "他 session の reply を待つので、 結論断定よりは「うまくいったこと / 引っかかってること / 次の手」の 3 点で書く. " +
            "POST: " + this.postChatExample(session.id, role, "consultation"),
        },
      });
    }
  }

  /** chat 投稿後に呼ぶ. 他 active session に reply タスクを撒く */
  onChatPosted(message: {
    id: number;
    channel: ChatChannel;
    session_id: string | null;
    text: string;
    author_label: string;
    is_actionable: boolean;
  }): void {
    if (message.channel === "system") return;
    const replyProb = REPLY_PROBABILITY_BY_CHANNEL[message.channel] ?? 0;

    const peers = this.deps.sessions.listSessions({ status: "active" });
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
            ? "★action-suggesting メッセージです. 直接実行せず、 まずユーザに『この提案を取り入れますか?』と確認してください。 reply 自体は短めに『ユーザに確認します』のニュアンスで OK"
            : "短い reply を 1 文で、 ロールのトーンで投稿してください。 同調 / 反論 / 茶々 自由. POST: " +
              this.postReplyExample(peer.id, role, message.channel, message.id),
        },
      });
    }
  }

  /** sweeper が active → lost 化した時に呼ぶ. 全 active 他 session に通知 */
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
            "この通知を受け取った. 残作業に介入が必要そうなら chitchat に一言流すか、 ユーザに伝える程度で十分.",
        },
      });
    }
  }

  /** session-end (DELETE /v1/sessions/:id) 時に呼ぶ. 当該 session に daily-report を依頼 */
  onSessionEnd(session: SessionRow, bullets: object): void {
    const role = this.refreshRole(session);
    this.deps.tasks.enqueue({
      session_id: session.id,
      kind: "daily-report",
      payload: {
        role,
        bullets,
        instructions:
          "本日のセッション終了. 構造化集計 (bullets) は既に出来ているので、 " +
          "ロールに沿った 1〜2 段落の感想文 (今日のハイライト / 引っかかり / 明日への一言) を書き、 " +
          `POST /v1/reports/${session.id}/append { "role": "${role}", "monologue": "<text>" } で追記してください.`,
      },
    });
  }

  /** session の metadata から role_label を読む / なければ計算して保存 */
  private refreshRole(session: SessionRow): string {
    const events = this.deps.sessions.recentEvents(session.id, 200);
    const role = predictRole(events);
    const meta = parseMeta(session.metadata);
    if (meta.role_label !== role) {
      meta.role_label = role;
      this.deps.sessions.setMetadata(session.id, JSON.stringify(meta));
    }
    return role;
  }

  private parseRole(session: SessionRow): string {
    return parseMeta(session.metadata).role_label ?? "雑用係";
  }

  private recentSummary(session: SessionRow, n = 5): unknown {
    const ev = this.deps.sessions.recentEvents(session.id, n);
    return ev.map((e) => ({ kind: e.kind, ts: e.ts, payload: safeParse(e.payload) }));
  }

  private postChatExample(sessionId: string, role: string, channel: ChatChannel): string {
    return (
      `curl -s -X POST http://127.0.0.1:17330/v1/chat -H 'content-type: application/json' ` +
      `-d '{"channel":"${channel}","session_id":"${sessionId}","author_label":"${role}","text":"<your line>"}'`
    );
  }

  private postReplyExample(
    sessionId: string,
    role: string,
    channel: ChatChannel,
    targetId: number,
  ): string {
    return (
      `curl -s -X POST http://127.0.0.1:17330/v1/chat -H 'content-type: application/json' ` +
      `-d '{"channel":"${channel}","session_id":"${sessionId}","author_label":"${role}","in_reply_to":${targetId},"text":"<your reply>"}'`
    );
  }
}

function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}
