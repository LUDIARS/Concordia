import type Database from "better-sqlite3";

/**
 * 人間宛ての未回答事項を 1 本の一覧へ束ねる read model。
 *
 * 質問カード / inquiry の ask_human / Director の blocked / confirm の承認待ちは、
 * それぞれ別のテーブルに別の形で溜まる。**「いま自分が答えるべきものは何件あるのか」を
 * 見る場所が無く**、Discord を遡るか各画面を回るしかなかった。
 *
 * **新しい正本を作らない。** ここは既存テーブルを束ねて読むだけで、回答・解決は
 * 既存経路 (answer-question / confirm / director API) のまま行う。
 * 状態を持つと、どちらが正なのか分からなくなる。
 *
 * @implements spec/feature/approval-inbox.md §1-2
 */

/** 集約する種別。 正本のテーブルが違うので、 種別は項目のキーの一部になる。 */
export type InboxItemKind = "ask-card" | "inquiry-ask-human" | "director-blocked" | "confirm-pending";

export interface InboxItem {
  /**
   * 種別と正本の主キーから決定的に作るキー。
   * 既読・スヌーズ (UI 状態) がこれで項目を指す。
   */
  readonly key: string;
  readonly kind: InboxItemKind;
  /** 一覧に出す要旨。 本文そのままではなく先頭を切り詰めたもの。 */
  readonly summary: string;
  /** 発生時刻 (epoch ms)。 経過時間の計算元。 */
  readonly raisedAt: number;
  /** 由来。 回答画面への遷移に使う。 どれか 1 つ以上が入る。 */
  readonly sessionId?: string;
  readonly caseId?: string;
  readonly repoOrigin?: string;
  readonly prNumber?: number;
}

/** 一覧に出す長さ。 全文は遷移先で読む。 */
const SUMMARY_LIMIT = 120;

function summarize(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT - 1)}…` : flat;
}

/**
 * 未回答の質問カード。
 *
 * `director_decisions.pending_question_id` から参照されているカードは inquiry 由来なので、
 * ここでは除く。**同じカードが 2 件に見えるのを防ぐ**のが目的
 * (spec は結合キーを `inquiry_id` と書いているが、実際の列名は `pending_question_id`)。
 */
export function askCardItems(db: Database.Database): InboxItem[] {
  const rows = db.prepare(`
    SELECT q.id, q.session_id, q.question, q.ts * 1000 AS raised_at
      FROM discord_pending_questions q
     WHERE q.answered_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM director_decisions d WHERE d.pending_question_id = q.id
           )
     ORDER BY q.ts ASC
  `).all() as Array<{ id: number; session_id: string; question: string; raised_at: number }>;
  return rows.map((row) => ({
    key: `ask-card:${row.id}`,
    kind: "ask-card" as const,
    summary: summarize(row.question),
    // discord_pending_questions is an older table whose timestamps are epoch seconds.
    raisedAt: row.raised_at,
    sessionId: row.session_id,
  }));
}

/**
 * inquiry の ask_human。
 *
 * 監査行 (`director_decisions`) とカードを結合して **1 件だけ** 出す。
 * 質問カードの `answered_at` と判断監査行の `human_answered_at` がともに
 * 未設定の間だけ出す。人間の別発言や nudge の disarm は回答とみなさない。
 */
export function inquiryAskHumanItems(db: Database.Database): InboxItem[] {
  const rows = db.prepare(`
    SELECT q.id, MIN(d.case_id) AS case_id, q.question, q.session_id,
           q.ts * 1000 AS raised_at
      FROM director_decisions d
      JOIN discord_pending_questions q ON q.id = d.pending_question_id
     WHERE d.human_answered_at IS NULL
       AND d.decision = 'ask_human'
       AND d.plan_version IS NULL
       AND q.answered_at IS NULL
     GROUP BY q.id, q.question, q.session_id, q.ts
     ORDER BY q.ts ASC
  `).all() as Array<{ id: number; case_id: string; question: string; session_id: string; raised_at: number }>;
  return rows.map((row) => ({
    key: `inquiry-ask-human:${row.id}`,
    kind: "inquiry-ask-human" as const,
    summary: summarize(row.question),
    raisedAt: row.raised_at,
    sessionId: row.session_id,
    caseId: row.case_id,
  }));
}

/** blocked で止まっている Director の工程。 */
export function directorBlockedItems(db: Database.Database): InboxItem[] {
  const rows = db.prepare(`
    SELECT s.id, s.case_id, s.kind, s.title, s.updated_at
      FROM director_steps s
     WHERE s.status = 'blocked'
     ORDER BY s.updated_at ASC
  `).all() as Array<{ id: string; case_id: string; kind: string; title: string; updated_at: number }>;
  return rows.map((row) => ({
    key: `director-blocked:${row.id}`,
    kind: "director-blocked" as const,
    summary: summarize(`${row.title || row.kind} が blocked`),
    // A step may become blocked long after creation; elapsed time starts at that transition.
    raisedAt: row.updated_at,
    caseId: row.case_id,
  }));
}

/** 承認待ちの confirm。 pending は起動待ち、 confirming は昇格待ち。 */
export function confirmPendingItems(db: Database.Database): InboxItem[] {
  const rows = db.prepare(`
    SELECT c.id, c.repo_origin, c.pr_number, c.pr_title, c.status, c.created_at
      FROM confirm_runs c
     WHERE c.status IN ('pending', 'confirming')
     ORDER BY c.created_at ASC
  `).all() as Array<{
    id: string; repo_origin: string; pr_number: number; pr_title: string;
    status: string; created_at: number;
  }>;
  return rows.map((row) => ({
    key: `confirm-pending:${row.id}`,
    kind: "confirm-pending" as const,
    summary: summarize(
      `${row.status === "pending" ? "起動承認待ち" : "昇格承認待ち"}: ${row.repo_origin}#${row.pr_number} ${row.pr_title}`,
    ),
    raisedAt: row.created_at,
    repoOrigin: row.repo_origin,
    prNumber: row.pr_number,
  }));
}

/**
 * 4 種別を束ねて経過時間の降順 (古い順) で返す。
 *
 * 古いものほど上に来る。**放置されているものを先に見せる**のが一覧の目的なので、
 * 新着順にはしない。
 */
export function inboxItems(db: Database.Database): InboxItem[] {
  return [
    ...askCardItems(db),
    ...inquiryAskHumanItems(db),
    ...directorBlockedItems(db),
    ...confirmPendingItems(db),
  ].sort((left, right) => left.raisedAt - right.raisedAt);
}
