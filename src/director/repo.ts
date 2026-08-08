import type Database from "better-sqlite3";
import type {
  DirectorCase,
  DirectorCaseDetail,
  DirectorDecisionRecord,
  DirectorStep,
  DirectorStepStatus,
} from "./types.js";

interface DirectorCaseRow extends DirectorCase {}

interface DirectorStepRow extends DirectorStep {}

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
}

export class DirectorRepo {
  constructor(private readonly db: Database.Database) {}

  createCase(input: DirectorCase, steps: DirectorStep[]): DirectorCaseDetail {
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO director_cases(id, title, goal, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.id, input.title, input.goal, input.project, input.created_at, input.updated_at);
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
      SELECT id, title, goal, project, created_at, updated_at FROM director_cases WHERE id = ?
    `).get(id) as DirectorCaseRow | undefined;
    return row ?? null;
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
    this.db.prepare(`
      INSERT INTO director_decisions(
        id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
        instruction, genius_available, genius_cards_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.case_id, input.step_id, input.kind, input.question,
      JSON.stringify(input.facts), JSON.stringify(input.options), input.impact, input.decision,
      input.instruction, input.genius_available ? 1 : 0, JSON.stringify(input.genius_cards), input.created_at,
    );
    return input;
  }

  listDecisions(caseId: string): DirectorDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
             instruction, genius_available, genius_cards_json, created_at
        FROM director_decisions WHERE case_id = ? ORDER BY created_at ASC, id ASC
    `).all(caseId) as DirectorDecisionRow[];
    return rows.map((row) => ({
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
    }));
  }
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
    return Array.isArray(parsed) ? parsed as DirectorDecisionRecord["genius_cards"] : [];
  } catch {
    return [];
  }
}
