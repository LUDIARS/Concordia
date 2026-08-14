import type Database from "better-sqlite3";
import type { GeniusCard } from "../inquiry/genius-client.js";
import type {
  DirectorCase,
  DirectorCaseDetail,
  DirectorDecisionRecord,
  DirectorStep,
  DirectorStepSummary,
  DirectorStepStatus,
} from "./types.js";

interface DirectorCaseRow extends DirectorCase {}

interface DirectorStepRow extends DirectorStep {}

interface DirectorStepSummaryRow extends DirectorStepSummary {
  case_id: string;
}

interface DirectorDecisionRow {
  id: string;
  case_id: string;
  step_id: string;
  kind: DirectorDecisionRecord["kind"];
  question: string;
  facts_json: string;
  options_json: string;
  impact: string;
  decision: DirectorDecisionRecord["decision"];
  instruction: string;
  genius_available: number;
  genius_cards_json: string;
  created_at: number;
  plan_version: number | null;
  plan_md_ref: string | null;
  pending_question_id: number | null;
  human_answer: string | null;
  human_answered_at: number | null;
}

export class DirectorRepo {
  constructor(private readonly db: Database.Database) {}

  createCase(input: DirectorCase, steps: DirectorStep[]): DirectorCaseDetail {
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO director_cases(id, title, goal, project, session_id, team_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.title, input.goal, input.project, input.session_id, input.team_id, input.created_at, input.updated_at);
      const insertStep = this.db.prepare(`
        INSERT INTO director_steps(
          id, case_id, sequence, kind, title, status, task_path, delegation_run_id,
          local_pr_id, confirm_run_id, handoff_note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const step of steps) {
        insertStep.run(
          step.id, step.case_id, step.sequence, step.kind, step.title, step.status, step.task_path,
          step.delegation_run_id, step.local_pr_id, step.confirm_run_id, step.handoff_note,
          step.created_at, step.updated_at,
        );
      }
    });
    create();
    return { case: input, steps, decisions: [] };
  }

  findCase(id: string): DirectorCase | null {
    const row = this.db.prepare(`
      SELECT id, title, goal, project, session_id, team_id, created_at, updated_at FROM director_cases WHERE id = ?
    `).get(id) as DirectorCaseRow | undefined;
    return row ?? null;
  }

  /** kanban / 一覧用。 team 指定で絞り、 未指定なら全件を更新順で返す。 */
  listCases(filter: { teamId?: string; limit?: number } = {}): DirectorCase[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
    if (filter.teamId) {
      return this.db.prepare(`
        SELECT id, title, goal, project, session_id, team_id, created_at, updated_at
        FROM director_cases WHERE team_id = ? ORDER BY updated_at DESC LIMIT ?
      `).all(filter.teamId, limit) as DirectorCaseRow[];
    }
    return this.db.prepare(`
      SELECT id, title, goal, project, session_id, team_id, created_at, updated_at
      FROM director_cases ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as DirectorCaseRow[];
  }

  /** kanban 用 read model。case と step を件数に依存しない 2 クエリで取得する。 */
  listCasesWithSteps(
    filter: { teamId?: string; limit?: number } = {},
  ): Array<{ case: DirectorCase; steps: DirectorStepSummary[] }> {
    const cases = this.listCases(filter);
    if (cases.length === 0) return [];
    const placeholders = cases.map(() => "?").join(", ");
    const steps = this.db.prepare(`
      SELECT id, case_id, sequence, kind, title, status
        FROM director_steps
       WHERE case_id IN (${placeholders})
       ORDER BY case_id, sequence ASC
    `).all(...cases.map((row) => row.id)) as DirectorStepSummaryRow[];
    const stepsByCase = new Map<string, DirectorStepSummary[]>();
    for (const step of steps) {
      const grouped = stepsByCase.get(step.case_id) ?? [];
      grouped.push({
        id: step.id,
        sequence: step.sequence,
        kind: step.kind,
        title: step.title,
        status: step.status,
      });
      stepsByCase.set(step.case_id, grouped);
    }
    return cases.map((row) => ({ case: row, steps: stepsByCase.get(row.id) ?? [] }));
  }

  findLatestCaseForSession(sessionId: string): DirectorCase | null {
    return (this.db.prepare(`
      SELECT id, title, goal, project, session_id, team_id, created_at, updated_at
      FROM director_cases WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId) as DirectorCaseRow | undefined) ?? null;
  }

  findCaseDetail(id: string): DirectorCaseDetail | null {
    const found = this.findCase(id);
    if (!found) return null;
    return {
      case: found,
      steps: this.listSteps(id),
      decisions: this.listDecisions(id),
    };
  }

  findStep(id: string): DirectorStep | null {
    const row = this.db.prepare(`
      SELECT id, case_id, sequence, kind, title, status, task_path, delegation_run_id,
             local_pr_id, confirm_run_id, handoff_note, created_at, updated_at
        FROM director_steps WHERE id = ?
    `).get(id) as DirectorStepRow | undefined;
    return row ?? null;
  }

  listSteps(caseId: string): DirectorStep[] {
    return this.db.prepare(`
      SELECT id, case_id, sequence, kind, title, status, task_path, delegation_run_id,
             local_pr_id, confirm_run_id, handoff_note, created_at, updated_at
        FROM director_steps WHERE case_id = ? ORDER BY sequence ASC
    `).all(caseId) as DirectorStepRow[];
  }

  updateStepStatus(input: {
    id: string;
    status: DirectorStepStatus;
    handoff_note: string | null | undefined;
    updated_at: number;
  }): DirectorStep | null {
    const update = this.db.transaction(() => {
      const existing = this.findStep(input.id);
      if (!existing) return null;
      const note = input.handoff_note === undefined ? existing.handoff_note : input.handoff_note;
      this.db.prepare(`
        UPDATE director_steps SET status = ?, handoff_note = ?, updated_at = ? WHERE id = ?
      `).run(input.status, note, input.updated_at, input.id);
      this.db.prepare(`UPDATE director_cases SET updated_at = ? WHERE id = ?`)
        .run(input.updated_at, existing.case_id);
      return { ...existing, status: input.status, handoff_note: note, updated_at: input.updated_at };
    });
    return update();
  }

  createDecision(input: DirectorDecisionRecord): DirectorDecisionRecord {
    // Genius は外部サービス境界なので、既知フィールドだけを監査保存・API 応答へ通す。
    // 構文上は JSON 化できても契約外の内部フィールドをそのまま永続化しない。
    const geniusCards = readCards(JSON.stringify(input.genius_cards));
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO director_decisions(
          id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
          instruction, genius_available, genius_cards_json, created_at, plan_version, plan_md_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.case_id, input.step_id, input.kind, input.question,
        JSON.stringify(input.facts), JSON.stringify(input.options), input.impact, input.decision,
        input.instruction, input.genius_available ? 1 : 0, JSON.stringify(geniusCards), input.created_at, input.plan_version ?? null, input.plan_md_ref ?? null,
      );
      // 判断の追加も case の監査履歴を変更する。step 遷移を伴わない proceed / self_judge
      // でも read model の更新時刻が進むよう、同じ transaction で case を touch する。
      this.db.prepare(`UPDATE director_cases SET updated_at = MAX(updated_at, ?) WHERE id = ?`)
        .run(input.created_at, input.case_id);
    });
    create();
    return { ...input, genius_cards: geniusCards };
  }

  listDecisions(caseId: string): DirectorDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT ${DECISION_COLUMNS}
        FROM director_decisions WHERE case_id = ? ORDER BY audit_sequence ASC
    `).all(caseId) as DirectorDecisionRow[];
    return rows.map(toDecisionRecord);
  }

  /** ask_human 束ねカード投稿後、載せた decision へカード id を刻む (回答マッピングの正本)。 */
  assignPendingQuestion(decisionIds: readonly string[], pendingQuestionId: number): void {
    const update = this.db.prepare(`
      UPDATE director_decisions SET pending_question_id = ? WHERE id = ?
    `);
    const assign = this.db.transaction(() => {
      for (const id of decisionIds) update.run(pendingQuestionId, id);
    });
    assign();
  }

  /** 設問カード 1 枚に束ねられた decision 群を投稿時と同じ順序 (audit_sequence) で返す。 */
  listDecisionsByPendingQuestion(pendingQuestionId: number): DirectorDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT ${DECISION_COLUMNS}
        FROM director_decisions WHERE pending_question_id = ? ORDER BY audit_sequence ASC
    `).all(pendingQuestionId) as DirectorDecisionRow[];
    return rows.map(toDecisionRecord);
  }

  /** 停止や flush 失敗の後に回収する、未投稿の Decision Request 由来 ask_human。 */
  listUnpostedAskHumanDecisions(): DirectorDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT ${DECISION_COLUMNS}
        FROM director_decisions
       WHERE decision = 'ask_human'
         AND plan_version IS NULL
         AND pending_question_id IS NULL
         AND human_answered_at IS NULL
       ORDER BY audit_sequence ASC
    `).all() as DirectorDecisionRow[];
    return rows.map(toDecisionRecord);
  }

  /** question は回答済みだが decision 反映前に停止した場合の再適用候補。 */
  listPendingQuestionIdsAwaitingAnswerApplication(): number[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT pending_question_id
        FROM director_decisions
       WHERE decision = 'ask_human'
         AND plan_version IS NULL
         AND pending_question_id IS NOT NULL
         AND human_answered_at IS NULL
       ORDER BY pending_question_id ASC
    `).all() as Array<{ pending_question_id: number }>;
    return rows.map((row) => row.pending_question_id);
  }

  /** plan 提出分を除き、step に未回答の人間判断が残っているか。 */
  hasUnansweredAskHumanDecisions(stepId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
        FROM director_decisions
       WHERE step_id = ?
         AND decision = 'ask_human'
         AND plan_version IS NULL
         AND human_answered_at IS NULL
       LIMIT 1
    `).get(stepId);
    return row !== undefined;
  }

  /** 人間の回答を監査保存する。既回答は上書きしない (最初の回答が正)。 */
  recordHumanAnswer(decisionId: string, answer: string, answeredAt: number): boolean {
    const info = this.db.prepare(`
      UPDATE director_decisions SET human_answer = ?, human_answered_at = ?
       WHERE id = ? AND human_answered_at IS NULL
    `).run(answer, answeredAt, decisionId);
    return info.changes > 0;
  }
}

const DECISION_COLUMNS = `id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
             instruction, genius_available, genius_cards_json, created_at, plan_version, plan_md_ref,
             pending_question_id, human_answer, human_answered_at`;

function toDecisionRecord(row: DirectorDecisionRow): DirectorDecisionRecord {
  return {
    id: row.id,
    case_id: row.case_id,
    step_id: row.step_id,
    kind: row.kind,
    question: row.question,
    facts: readStringArray(row.facts_json),
    options: readStringArray(row.options_json),
    impact: row.impact,
    decision: row.decision,
    instruction: row.instruction,
    genius_available: row.genius_available === 1,
    genius_cards: readCards(row.genius_cards_json),
    created_at: row.created_at,
    plan_version: row.plan_version,
    plan_md_ref: row.plan_md_ref,
    pending_question_id: row.pending_question_id,
    human_answer: row.human_answer,
    human_answered_at: row.human_answered_at,
  };
}

function readStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readCards(value: string): DirectorDecisionRecord["genius_cards"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const cards: GeniusCard[] = [];
    for (const value of parsed) {
      const card = readCard(value);
      if (!card) return [];
      cards.push(card);
    }
    return cards;
  } catch {
    return [];
  }
}

function readCard(value: unknown): GeniusCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string"
    || row.id.trim().length === 0
    || typeof row.title !== "string"
    || row.title.trim().length === 0
    || typeof row.score !== "number"
    || !Number.isFinite(row.score)
  ) {
    return null;
  }
  for (const key of ["domain", "situation", "judgment", "rationale"] as const) {
    if (row[key] !== undefined && typeof row[key] !== "string") return null;
  }
  if (row.category !== undefined && row.category !== null && typeof row.category !== "string") {
    return null;
  }
  if (row.confidence !== undefined && (typeof row.confidence !== "number" || !Number.isFinite(row.confidence))) {
    return null;
  }
  if (row.tags !== undefined && (!Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === "string"))) {
    return null;
  }
  const card: GeniusCard = {
    id: row.id,
    title: row.title,
    score: row.score,
  };
  if (typeof row.domain === "string") card.domain = row.domain;
  if (typeof row.category === "string" || row.category === null) card.category = row.category;
  if (typeof row.situation === "string") card.situation = row.situation;
  if (typeof row.judgment === "string") card.judgment = row.judgment;
  if (typeof row.rationale === "string") card.rationale = row.rationale;
  if (typeof row.confidence === "number") card.confidence = row.confidence;
  if (Array.isArray(row.tags)) card.tags = row.tags as string[];
  return card;
}
