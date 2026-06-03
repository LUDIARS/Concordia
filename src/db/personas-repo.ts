import type Database from "better-sqlite3";

export interface PersonaRow {
  id: string;
  name: string;
  description: string;
  traits: string;          // JSON
  speech_style: string;
  skill_template: string;
  learned_notes: string;   // JSON
  display_name: string;    // 人物名 (chat author_label / statusline で利用). 空文字なら未設定
  created_at: number;
  updated_at: number;
}

export interface PersonaAssignmentRow {
  id: number;
  persona_id: string;
  session_id: string;
  assigned_at: number;
  released_at: number | null;
}

export interface PersonaFeedbackRow {
  id: number;
  persona_id: string;
  session_id: string | null;
  ts: number;
  kind: "session-end" | "chat-update" | "manual" | "system" | "boyaki";
  delta: string;
  detail: string | null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class PersonasRepo {
  constructor(private readonly db: Database.Database) {}

  // ─── persona CRUD ───────────────────────────────────

  insertOrIgnore(input: {
    id: string;
    name: string;
    description: string;
    traits: string;
    speech_style: string;
    skill_template: string;
    display_name?: string;
  }): void {
    const now = nowSec();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO personas
          (id, name, description, traits, speech_style, skill_template, learned_notes, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      )
      .run(
        input.id, input.name, input.description, input.traits,
        input.speech_style, input.skill_template, input.display_name ?? "",
        now, now,
      );
  }

  find(id: string): PersonaRow | null {
    return (
      (this.db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id) as PersonaRow | undefined) ?? null
    );
  }

  list(): PersonaRow[] {
    return this.db
      .prepare(`SELECT * FROM personas ORDER BY name ASC`)
      .all() as PersonaRow[];
  }

  appendLearnedNote(persona_id: string, note: string): void {
    const cur = this.find(persona_id);
    if (!cur) return;
    let arr: string[] = [];
    try { arr = JSON.parse(cur.learned_notes); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push(note);
    // 最新 50 件に制限 (人格膨張防止)
    while (arr.length > 50) arr.shift();
    this.db
      .prepare(`UPDATE personas SET learned_notes = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(arr), nowSec(), persona_id);
  }

  /** UI / API での編集用. id / created_at は不変. */
  update(id: string, patch: {
    name?: string;
    description?: string;
    traits?: string;
    speech_style?: string;
    skill_template?: string;
    learned_notes?: string;
    display_name?: string;
  }): boolean {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined)           { sets.push("name = ?");           args.push(patch.name); }
    if (patch.description !== undefined)    { sets.push("description = ?");    args.push(patch.description); }
    if (patch.traits !== undefined)         { sets.push("traits = ?");         args.push(patch.traits); }
    if (patch.speech_style !== undefined)   { sets.push("speech_style = ?");   args.push(patch.speech_style); }
    if (patch.skill_template !== undefined) { sets.push("skill_template = ?"); args.push(patch.skill_template); }
    if (patch.learned_notes !== undefined)  { sets.push("learned_notes = ?");  args.push(patch.learned_notes); }
    if (patch.display_name !== undefined)   { sets.push("display_name = ?");   args.push(patch.display_name); }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    args.push(nowSec());
    args.push(id);
    const r = this.db
      .prepare(`UPDATE personas SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    return Number(r.changes ?? 0) > 0;
  }

  // ─── assignment ─────────────────────────────────────

  /** session に既に active assignment があれば返す, 無ければ null. */
  findActiveBySession(session_id: string): PersonaAssignmentRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM persona_assignments
           WHERE session_id = ? AND released_at IS NULL
           ORDER BY assigned_at DESC LIMIT 1`,
        )
        .get(session_id) as PersonaAssignmentRow | undefined) ?? null
    );
  }

  /** 現在 active な persona id 集合. */
  listActivePersonaIds(): Set<string> {
    const rows = this.db
      .prepare(`SELECT persona_id FROM persona_assignments WHERE released_at IS NULL`)
      .all() as Array<{ persona_id: string }>;
    return new Set(rows.map((r) => r.persona_id));
  }

  /** active な (persona, session) のペア一覧. UI 用. */
  listActiveAssignments(): Array<PersonaAssignmentRow & { persona: PersonaRow }> {
    const rows = this.db
      .prepare(
        `SELECT pa.*, p.id AS p_id, p.name, p.description, p.traits, p.speech_style,
                p.skill_template, p.learned_notes, p.display_name,
                p.created_at AS p_created_at, p.updated_at AS p_updated_at
         FROM persona_assignments pa
         JOIN personas p ON p.id = pa.persona_id
         WHERE pa.released_at IS NULL
         ORDER BY pa.assigned_at DESC`,
      )
      .all() as Array<any>;
    return rows.map((r) => ({
      id: r.id, persona_id: r.persona_id, session_id: r.session_id,
      assigned_at: r.assigned_at, released_at: r.released_at,
      persona: {
        id: r.p_id, name: r.name, description: r.description,
        traits: r.traits, speech_style: r.speech_style,
        skill_template: r.skill_template, learned_notes: r.learned_notes,
        display_name: r.display_name ?? "",
        created_at: r.p_created_at, updated_at: r.p_updated_at,
      },
    }));
  }

  /**
   * session に persona を排他 assign する.
   *
   * 優先順:
   *   1. session に active assignment があればそれを reuse (no-op)
   *   2. session の **過去 (released) assignment** に対応する persona が今 free なら、 同じ persona を再 assign
   *      → ended → re-POST しても 1 セッションには **最初に貰った人格** がそのまま戻る (人格の継続性)
   *   3. 過去履歴ゼロ or その persona が今 active で取れない場合のみ、 free な persona を rng で選ぶ
   *   4. 全 persona 取得中なら null
   */
  assign(session_id: string, rng: () => number = Math.random): { persona: PersonaRow; reused: boolean } | null {
    const existing = this.findActiveBySession(session_id);
    if (existing) {
      const p = this.find(existing.persona_id);
      if (p) return { persona: p, reused: true };
    }

    const taken = this.listActivePersonaIds();
    const all = this.list();

    // 過去 assign の優先再利用 (session 単位で人格を固定する)
    const history = this.recentAssignmentsBySession(session_id, 5);
    for (const h of history) {
      if (taken.has(h.persona_id)) continue; // 今他 session が使ってたら諦める
      const p = this.find(h.persona_id);
      if (!p) continue;
      try {
        this.db
          .prepare(
            `INSERT INTO persona_assignments(persona_id, session_id, assigned_at, released_at)
             VALUES (?, ?, ?, NULL)`,
          )
          .run(p.id, session_id, nowSec());
        return { persona: p, reused: true };
      } catch {
        // race で取れなければ次の候補へ
        continue;
      }
    }

    const free = all.filter((p) => !taken.has(p.id));
    if (free.length === 0) return null;
    const pick = free[Math.floor(rng() * free.length)];
    try {
      this.db
        .prepare(
          `INSERT INTO persona_assignments(persona_id, session_id, assigned_at, released_at)
           VALUES (?, ?, ?, NULL)`,
        )
        .run(pick.id, session_id, nowSec());
    } catch {
      // race: 同時 assign で unique 違反 → 既存を返す or null
      const again = this.findActiveBySession(session_id);
      if (again) {
        const p = this.find(again.persona_id);
        if (p) return { persona: p, reused: true };
      }
      return null;
    }
    return { persona: pick, reused: false };
  }

  /** session の active assignment を release. */
  release(session_id: string): { persona_id: string } | null {
    const row = this.findActiveBySession(session_id);
    if (!row) return null;
    this.db
      .prepare(`UPDATE persona_assignments SET released_at = ? WHERE id = ?`)
      .run(nowSec(), row.id);
    return { persona_id: row.persona_id };
  }

  // ─── feedback log ────────────────────────────────────

  appendFeedback(input: {
    persona_id: string;
    session_id: string | null;
    kind: PersonaFeedbackRow["kind"];
    delta: string;
    detail?: object;
  }): PersonaFeedbackRow {
    const r = this.db
      .prepare(
        `INSERT INTO persona_feedback_log(persona_id, session_id, ts, kind, delta, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.persona_id, input.session_id, nowSec(),
        input.kind, input.delta, input.detail ? JSON.stringify(input.detail) : null,
      );
    return this.findFeedback(Number(r.lastInsertRowid))!;
  }

  findFeedback(id: number): PersonaFeedbackRow | null {
    return (
      (this.db.prepare(`SELECT * FROM persona_feedback_log WHERE id = ?`).get(id) as PersonaFeedbackRow | undefined) ?? null
    );
  }

  recentFeedback(persona_id: string, limit = 50): PersonaFeedbackRow[] {
    return this.db
      .prepare(`SELECT * FROM persona_feedback_log WHERE persona_id = ? ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(persona_id, limit) as PersonaFeedbackRow[];
  }

  recentFeedbackAll(limit = 100): PersonaFeedbackRow[] {
    return this.db
      .prepare(`SELECT * FROM persona_feedback_log ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(limit) as PersonaFeedbackRow[];
  }

  /** session 履歴用. UI で過去 assignment を出すとき. */
  recentAssignmentsBySession(session_id: string, limit = 10): PersonaAssignmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM persona_assignments WHERE session_id = ? ORDER BY assigned_at DESC LIMIT ?`,
      )
      .all(session_id, limit) as PersonaAssignmentRow[];
  }

  recentAssignmentsByPersona(persona_id: string, limit = 30): PersonaAssignmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM persona_assignments WHERE persona_id = ? ORDER BY assigned_at DESC LIMIT ?`,
      )
      .all(persona_id, limit) as PersonaAssignmentRow[];
  }
}
