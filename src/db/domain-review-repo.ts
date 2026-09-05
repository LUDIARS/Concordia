/**
 * src/db/domain-review-repo.ts — ドメインレビュー投稿とその返信の台帳。
 *
 * 投稿した message id を残すのは、 返信を「どの投稿・どのプロジェクト・どの plan への
 * 回答か」に結び付けるため。 Discord の返信は再起動をまたいで来るので in-memory では
 * 持てない。 回答本文もここに残す — plan ファイルへの追記が失敗しても、
 * **人が答えた事実は消えない**ようにする。
 *
 * SRP: 永続化だけ。 投稿するか / 何を書き戻すかは domain-review/ 側の判断。
 *
 * @implements spec/feature/domain-review-discord.md §4
 */

import type Database from "better-sqlite3";

export interface DomainReviewPostRow {
  id: number;
  code: string;
  repo_path: string;
  anatomia_project_id: string;
  plan_task_hash: string | null;
  trigger_kind: string;
  platform: string;
  channel_id: string;
  message_id: string;
  /** JSON 配列 (投稿に載せた plan の問い)。 */
  questions: string;
  created_at: number;
}

export interface DomainReviewPostInput {
  code: string;
  repoPath: string;
  anatomiaProjectId: string;
  planTaskHash: string | null;
  triggerKind: string;
  platform: string;
  channelId: string;
  messageId: string;
  questions: readonly string[];
}

/** 回答の種別。 plan の問いへの回答と、 ドメイン説明・紐付けへの指摘を分ける。 */
export type DomainReviewAnswerKind = "plan-question" | "domain-note";

export interface DomainReviewAnswerInput {
  postId: number;
  kind: DomainReviewAnswerKind;
  answeredBy: string;
  answerText: string;
  source: string;
  /** plan ファイルへ追記できたか。 できなくても回答は残す。 */
  planAppended: boolean;
}

export interface DomainReviewAnswerRow {
  id: number;
  post_id: number;
  kind: string;
  answered_by: string;
  answer_text: string;
  source: string;
  plan_appended: number;
  created_at: number;
}

export class DomainReviewRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * 投稿を記録する。 同じ (platform, message_id) を二度記録しないのは、
   * 起動直後の取りこぼし補完などで同じ投稿が二度流れても 1 行に収めるため。
   */
  recordPost(input: DomainReviewPostInput): DomainReviewPostRow {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO domain_review_posts(
        code, repo_path, anatomia_project_id, plan_task_hash, trigger_kind,
        platform, channel_id, message_id, questions, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, message_id) DO UPDATE SET
        code = excluded.code,
        repo_path = excluded.repo_path,
        anatomia_project_id = excluded.anatomia_project_id,
        plan_task_hash = excluded.plan_task_hash,
        trigger_kind = excluded.trigger_kind,
        channel_id = excluded.channel_id,
        questions = excluded.questions
    `).run(
      input.code,
      input.repoPath,
      input.anatomiaProjectId,
      input.planTaskHash,
      input.triggerKind,
      input.platform,
      input.channelId,
      input.messageId,
      JSON.stringify([...input.questions]),
      now,
    );
    return this.findPostByMessage(input.platform, input.messageId)!;
  }

  findPostByMessage(platform: string, messageId: string): DomainReviewPostRow | null {
    return (this.db.prepare(
      "SELECT * FROM domain_review_posts WHERE platform = ? AND message_id = ?",
    ).get(platform, messageId) as DomainReviewPostRow | undefined) ?? null;
  }

  findPostById(id: number): DomainReviewPostRow | null {
    return (this.db.prepare("SELECT * FROM domain_review_posts WHERE id = ?")
      .get(id) as DomainReviewPostRow | undefined) ?? null;
  }

  recordAnswer(input: DomainReviewAnswerInput): DomainReviewAnswerRow {
    // SQLite の BEGIN IMMEDIATE で process 間も直列化する。service 側の queue は
    // 同一 process にしか効かないため、check と insert を別 statement のままにすると
    // chat worker 等の別 writer が同じ source を二重記録できてしまう。
    const record = this.db.transaction((): DomainReviewAnswerRow => {
      const existing = this.findAnswerBySource(input.postId, input.source);
      if (existing) return existing;
      const now = Date.now();
      const result = this.db.prepare(`
        INSERT INTO domain_review_answers(
          post_id, kind, answered_by, answer_text, source, plan_appended, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.postId,
        input.kind,
        input.answeredBy,
        input.answerText,
        input.source,
        input.planAppended ? 1 : 0,
        now,
      );
      return this.db.prepare("SELECT * FROM domain_review_answers WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as DomainReviewAnswerRow;
    });
    return record.immediate();
  }

  /** Discord message source は安定 ID。再配送時の冪等判定に使う。 */
  findAnswerBySource(postId: number, source: string): DomainReviewAnswerRow | null {
    return (this.db.prepare(
      "SELECT * FROM domain_review_answers WHERE post_id = ? AND source = ? ORDER BY id LIMIT 1",
    ).get(postId, source) as DomainReviewAnswerRow | undefined) ?? null;
  }

  markAnswerPlanAppended(id: number): void {
    this.db.prepare("UPDATE domain_review_answers SET plan_appended = 1 WHERE id = ?").run(id);
  }

  listAnswers(postId: number): DomainReviewAnswerRow[] {
    return this.db.prepare(
      "SELECT * FROM domain_review_answers WHERE post_id = ? ORDER BY created_at, id",
    ).all(postId) as DomainReviewAnswerRow[];
  }
}

/** 投稿行に保存した問い一覧。 壊れた JSON は空として扱う (投稿は消さない)。 */
export function parsePostQuestions(row: DomainReviewPostRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.questions);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
