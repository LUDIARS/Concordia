/**
 * src/db/domain-review-repo.ts — ドメインレビュー投稿とその返信の台帳。
 *
 * 投稿した message id を残すのは、 返信を「どの投稿・どのプロジェクト・どの plan への
 * 回答か」に結び付けるため。 Discord の返信は再起動をまたいで来るので in-memory では
 * 持てない。 回答本文もここに残す — plan ファイルへの追記が失敗しても、
 * **人が答えた事実は消えない**ようにする。
 *
 * SRP: 永続化だけ。 投稿するか / 何を書き戻すか / 一覧を何件どう見せるかは
 * domain-review/ 側の判断。
 *
 * @implements spec/feature/domain-review-discord.md §4, §8
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
  /** 投稿したレポートの出所 (prepared / raw)。 migration 111 より前の行は null。 */
  report_source: string | null;
  core_domain_count: number | null;
  layer_count: number | null;
  layer_violation_count: number | null;
}

/**
 * 一覧 (spec §8) の 1 行。 repo_origin は project_codes の現在値で、 投稿行へは複製しない
 * (origin の正本を 2 つにしない)。 登録から消えた code は null。
 */
export interface DomainReviewPostListRow extends DomainReviewPostRow {
  repo_origin: string | null;
}

/** 投稿したレポートの規模。 一覧は本文の代わりにこの件数を返す。 */
export interface DomainReviewPostSummaryInput {
  source: string;
  coreDomains: number;
  layers: number;
  layerViolations: number;
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
  /** 投稿したレポートの件数。 無ければ null のまま残す (0 で埋めない)。 */
  summary?: DomainReviewPostSummaryInput | null;
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

/**
 * domain-note を Anatomia の review-notes へ渡す状態 (spec §4.2)。
 *  - `awaiting_choice`: どのドメインの話か決まらず、選択ダイアログの回答待ち
 *  - `sending`: 送信を始めた (二重クリック・再配送での二重送信を止める占有)
 *  - `sent`: Anatomia が下書き提案を作った (proposal_id)
 *  - `rejected`: Anatomia が受け取りを拒んだ (reason)
 *  - `failed`: ドメイン一覧が取れない・送信できない (reason)。再試行できる
 */
export type DomainReviewNoteDeliveryStatus = "awaiting_choice" | "sending" | "sent" | "rejected" | "failed";

export interface DomainReviewNoteDeliveryRow {
  answer_id: number;
  status: DomainReviewNoteDeliveryStatus;
  domain_id: string | null;
  project_wide: number;
  proposal_id: string | null;
  reason: string | null;
  chosen_by: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface DomainReviewNoteTargetInput {
  domainId: string | null;
  projectWide: boolean;
  chosenBy: string | null;
}

export class DomainReviewRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * 投稿を記録する。 同じ (platform, message_id) を二度記録しないのは、
   * 起動直後の取りこぼし補完などで同じ投稿が二度流れても 1 行に収めるため。
   */
  recordPost(input: DomainReviewPostInput): DomainReviewPostRow {
    const now = Date.now();
    const summary = input.summary ?? null;
    // 件数の無い再記録で、 既に残っている件数を null へ戻さない。
    this.db.prepare(`
      INSERT INTO domain_review_posts(
        code, repo_path, anatomia_project_id, plan_task_hash, trigger_kind,
        platform, channel_id, message_id, questions, created_at,
        report_source, core_domain_count, layer_count, layer_violation_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, message_id) DO UPDATE SET
        code = excluded.code,
        repo_path = excluded.repo_path,
        anatomia_project_id = excluded.anatomia_project_id,
        plan_task_hash = excluded.plan_task_hash,
        trigger_kind = excluded.trigger_kind,
        channel_id = excluded.channel_id,
        questions = excluded.questions,
        report_source = COALESCE(excluded.report_source, domain_review_posts.report_source),
        core_domain_count = COALESCE(excluded.core_domain_count, domain_review_posts.core_domain_count),
        layer_count = COALESCE(excluded.layer_count, domain_review_posts.layer_count),
        layer_violation_count = COALESCE(excluded.layer_violation_count, domain_review_posts.layer_violation_count)
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
      summary?.source ?? null,
      summary?.coreDomains ?? null,
      summary?.layers ?? null,
      summary?.layerViolations ?? null,
    );
    return this.findPostByMessage(input.platform, input.messageId)!;
  }

  /**
   * 投稿を新しい順に返す (spec §8)。 code が null なら全プロジェクト。
   * 件数の既定と上限は呼び出し側 (domain-review/post-listing) の規則で、 ここは
   * 解決済みの正の整数だけを受ける — SQLite は負の LIMIT を「無制限」と読むため。
   */
  listByCode(code: string | null, limit: number): DomainReviewPostListRow[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`domain review post limit must be a positive integer: ${limit}`);
    }
    const select = `
      SELECT p.*, pc.repo_origin AS repo_origin
        FROM domain_review_posts p
        LEFT JOIN project_codes pc ON pc.code = p.code
    `;
    const order = "ORDER BY p.created_at DESC, p.id DESC LIMIT ?";
    if (code === null) {
      return this.db.prepare(`${select} ${order}`).all(limit) as DomainReviewPostListRow[];
    }
    return this.db.prepare(`${select} WHERE p.code = ? ${order}`)
      .all(code, limit) as DomainReviewPostListRow[];
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

  findAnswerById(id: number): DomainReviewAnswerRow | null {
    return (this.db.prepare("SELECT * FROM domain_review_answers WHERE id = ?")
      .get(id) as DomainReviewAnswerRow | undefined) ?? null;
  }

  findNoteDelivery(answerId: number): DomainReviewNoteDeliveryRow | null {
    return (this.db.prepare("SELECT * FROM domain_review_note_deliveries WHERE answer_id = ?")
      .get(answerId) as DomainReviewNoteDeliveryRow | undefined) ?? null;
  }

  /**
   * 送信を占有する。 現在の行 (無ければ null) を `claimable` が許したときだけ
   * `sending` にして true を返す。 判定と更新を BEGIN IMMEDIATE の中で行うので、
   * 同じ回答への二重クリック・再配送・別 process の同時実行でも送信は 1 回になる。
   */
  claimNoteDelivery(
    answerId: number,
    target: DomainReviewNoteTargetInput,
    claimable: (current: DomainReviewNoteDeliveryRow | null) => boolean,
  ): boolean {
    const claim = this.db.transaction((): boolean => {
      const current = this.findNoteDelivery(answerId);
      if (!claimable(current)) return false;
      this.upsertNoteDelivery(answerId, {
        status: "sending",
        domainId: target.domainId,
        projectWide: target.projectWide,
        proposalId: null,
        reason: null,
        chosenBy: target.chosenBy ?? current?.chosen_by ?? null,
        countAttempt: true,
      });
      return true;
    });
    return claim.immediate();
  }

  /** 送信の結果・選択待ち・失敗理由を残す。 */
  saveNoteDelivery(answerId: number, input: {
    status: DomainReviewNoteDeliveryStatus;
    domainId?: string | null;
    projectWide?: boolean;
    proposalId?: string | null;
    reason?: string | null;
  }): DomainReviewNoteDeliveryRow {
    const current = this.findNoteDelivery(answerId);
    this.upsertNoteDelivery(answerId, {
      status: input.status,
      domainId: input.domainId === undefined ? current?.domain_id ?? null : input.domainId,
      projectWide: input.projectWide === undefined ? current?.project_wide === 1 : input.projectWide,
      proposalId: input.proposalId ?? null,
      reason: input.reason ?? null,
      chosenBy: current?.chosen_by ?? null,
      countAttempt: false,
    });
    return this.findNoteDelivery(answerId)!;
  }

  private upsertNoteDelivery(answerId: number, input: {
    status: DomainReviewNoteDeliveryStatus;
    domainId: string | null;
    projectWide: boolean;
    proposalId: string | null;
    reason: string | null;
    chosenBy: string | null;
    countAttempt: boolean;
  }): void {
    const now = Date.now();
    const attempt = input.countAttempt ? 1 : 0;
    this.db.prepare(`
      INSERT INTO domain_review_note_deliveries(
        answer_id, status, domain_id, project_wide, proposal_id, reason, chosen_by,
        attempts, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(answer_id) DO UPDATE SET
        status = excluded.status,
        domain_id = excluded.domain_id,
        project_wide = excluded.project_wide,
        proposal_id = excluded.proposal_id,
        reason = excluded.reason,
        chosen_by = excluded.chosen_by,
        attempts = domain_review_note_deliveries.attempts + ?,
        updated_at = excluded.updated_at
    `).run(
      answerId,
      input.status,
      input.domainId,
      input.projectWide ? 1 : 0,
      input.proposalId,
      input.reason,
      input.chosenBy,
      attempt,
      now,
      now,
      attempt,
    );
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
