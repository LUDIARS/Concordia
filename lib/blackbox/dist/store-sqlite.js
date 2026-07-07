// SQLite 実装の RuleStore / DecisionLedger。
//
// better-sqlite3 と node:sqlite (DatabaseSync) の両方が満たす最小構造型
// (SqliteLike) だけに依存し、 どちらのドライバも import しない。
// ensureBlackboxSchema() は新規作成に加えて、 Memoria 旧 schema
// (enabled 列 / state 無し) からの追い付き migration も行う。
import { ruleFingerprint } from './fingerprint.js';
function newId() {
    const c = globalThis.crypto;
    if (c?.randomUUID)
        return c.randomUUID();
    return `bb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
// ── schema ─────────────────────────────────────────────────────────────────
const CREATE_RULES = `
CREATE TABLE IF NOT EXISTS blackbox_rules (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  when_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  state TEXT NOT NULL DEFAULT 'candidate',
  source TEXT NOT NULL DEFAULT 'manual',
  approvals INTEGER NOT NULL DEFAULT 0,
  rejections INTEGER NOT NULL DEFAULT 0,
  shadow_agreements INTEGER NOT NULL DEFAULT 0,
  shadow_conflicts INTEGER NOT NULL DEFAULT 0,
  proposals INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
const CREATE_DECISIONS = `
CREATE TABLE IF NOT EXISTS blackbox_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  input_json TEXT,
  features_json TEXT,
  output_json TEXT,
  source TEXT NOT NULL,
  rule_id TEXT,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  shadow_json TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);`;
function columnNames(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.map((r) => r.name);
}
/**
 * テーブルを作成し、 旧 schema (Memoria v1) なら列を足して state を埋める。
 * 旧 enabled 列は残すが以後は参照しない。 何度呼んでも冪等。
 */
export function ensureBlackboxSchema(db) {
    db.exec(CREATE_RULES);
    db.exec(CREATE_DECISIONS);
    const ruleCols = columnNames(db, 'blackbox_rules');
    if (!ruleCols.includes('state')) {
        db.exec(`ALTER TABLE blackbox_rules ADD COLUMN state TEXT NOT NULL DEFAULT 'candidate'`);
        db.exec(`ALTER TABLE blackbox_rules ADD COLUMN shadow_agreements INTEGER NOT NULL DEFAULT 0`);
        db.exec(`ALTER TABLE blackbox_rules ADD COLUMN shadow_conflicts INTEGER NOT NULL DEFAULT 0`);
        db.exec(`ALTER TABLE blackbox_rules ADD COLUMN proposals INTEGER NOT NULL DEFAULT 1`);
        db.exec(`ALTER TABLE blackbox_rules ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''`);
        // 旧 enabled/approvals/rejections から state を再構成する。
        // enabled かつ承認済み → auto / enabled → trial / NG 撤回済み → retired / それ以外 → candidate
        db.exec(`
      UPDATE blackbox_rules SET state = CASE
        WHEN enabled = 1 AND approvals >= 3 THEN 'auto'
        WHEN enabled = 1 THEN 'trial'
        WHEN rejections >= 3 THEN 'retired'
        ELSE 'candidate'
      END`);
    }
    // fingerprint 未計算の行を埋める (新規作成直後は 0 行なので no-op)。
    const missing = db.prepare(`SELECT id, when_json, output_json FROM blackbox_rules WHERE fingerprint = ''`).all();
    for (const row of missing) {
        const fp = ruleFingerprint(JSON.parse(row.when_json), row.output_json ? JSON.parse(row.output_json) : null);
        db.prepare(`UPDATE blackbox_rules SET fingerprint = ? WHERE id = ?`).run(fp, row.id);
    }
    const decCols = columnNames(db, 'blackbox_decisions');
    if (!decCols.includes('shadow_json')) {
        db.exec(`ALTER TABLE blackbox_decisions ADD COLUMN shadow_json TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_blackbox_rules_domain ON blackbox_rules(domain)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_blackbox_decisions_domain ON blackbox_decisions(domain, created_at)`);
}
function rowToRule(r) {
    return {
        id: r.id, domain: r.domain, description: r.description,
        when: JSON.parse(r.when_json),
        output: r.output_json ? JSON.parse(r.output_json) : null,
        confidence: r.confidence,
        state: r.state,
        source: r.source,
        approvals: r.approvals, rejections: r.rejections,
        shadowAgreements: r.shadow_agreements, shadowConflicts: r.shadow_conflicts,
        proposals: r.proposals, fingerprint: r.fingerprint, priority: r.priority,
        createdAt: r.created_at, updatedAt: r.updated_at,
    };
}
export class SqliteRuleStore {
    db;
    now;
    constructor(db, now = () => new Date().toISOString()) {
        this.db = db;
        this.now = now;
    }
    listByDomain(domain) {
        const rows = this.db.prepare(`SELECT * FROM blackbox_rules WHERE domain = ? ORDER BY priority DESC, created_at ASC`).all(domain);
        return rows.map(rowToRule);
    }
    findByFingerprint(domain, fingerprint) {
        const row = this.db.prepare(`SELECT * FROM blackbox_rules WHERE domain = ? AND fingerprint = ? LIMIT 1`).get(domain, fingerprint);
        return row ? rowToRule(row) : null;
    }
    get(id) {
        const row = this.db.prepare(`SELECT * FROM blackbox_rules WHERE id = ?`).get(id);
        return row ? rowToRule(row) : null;
    }
    insert(draft) {
        const ts = this.now();
        const id = newId();
        this.db.prepare(`INSERT INTO blackbox_rules
         (id, domain, description, when_json, output_json, confidence, state, source,
          approvals, rejections, shadow_agreements, shadow_conflicts, proposals, fingerprint,
          priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, ?, ?, ?, ?)`).run(id, draft.domain, draft.description, JSON.stringify(draft.when), JSON.stringify(draft.output ?? null), draft.confidence ?? 0.7, draft.state ?? 'candidate', draft.source ?? 'manual', ruleFingerprint(draft.when, draft.output ?? null), draft.priority ?? 0, ts, ts);
        return this.get(id);
    }
    update(id, patch) {
        const cur = this.get(id);
        if (!cur)
            return null;
        const next = { ...cur, ...patch };
        this.db.prepare(`UPDATE blackbox_rules SET
         state = ?, approvals = ?, rejections = ?,
         shadow_agreements = ?, shadow_conflicts = ?, proposals = ?,
         confidence = ?, priority = ?, description = ?, updated_at = ?
       WHERE id = ?`).run(next.state, next.approvals, next.rejections, next.shadowAgreements, next.shadowConflicts, next.proposals, next.confidence, next.priority, next.description, this.now(), id);
        return this.get(id);
    }
}
function rowToDecision(r) {
    return {
        id: r.id, domain: r.domain,
        input: r.input_json ? JSON.parse(r.input_json) : null,
        features: (r.features_json ? JSON.parse(r.features_json) : {}),
        output: r.output_json ? JSON.parse(r.output_json) : null,
        source: r.source,
        ruleId: r.rule_id,
        confidence: r.confidence, rationale: r.rationale,
        status: r.status,
        verdict: r.verdict,
        shadow: r.shadow_json ? JSON.parse(r.shadow_json) : [],
        createdAt: r.created_at, reviewedAt: r.reviewed_at,
    };
}
export class SqliteDecisionLedger {
    db;
    constructor(db) {
        this.db = db;
    }
    record(rec) {
        const info = this.db.prepare(`INSERT INTO blackbox_decisions
         (domain, input_json, features_json, output_json, source, rule_id,
          confidence, rationale, status, verdict, shadow_json, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`).run(rec.domain, JSON.stringify(rec.input ?? null), JSON.stringify(rec.features ?? {}), JSON.stringify(rec.output ?? null), rec.source, rec.ruleId, rec.confidence, rec.rationale, rec.status, JSON.stringify(rec.shadow ?? []), rec.createdAt);
        return Number(info.lastInsertRowid);
    }
    get(id) {
        const row = this.db.prepare(`SELECT * FROM blackbox_decisions WHERE id = ?`).get(id);
        return row ? rowToDecision(row) : null;
    }
    setVerdict(id, verdict, reviewedAt) {
        this.db.prepare(`UPDATE blackbox_decisions SET verdict = ?, reviewed_at = ? WHERE id = ?`)
            .run(verdict, reviewedAt, id);
    }
    listPending(domain, limit = 50) {
        const rows = domain
            ? this.db.prepare(`SELECT * FROM blackbox_decisions WHERE status='pending_review' AND verdict IS NULL AND domain=?
           ORDER BY created_at DESC LIMIT ?`).all(domain, limit)
            : this.db.prepare(`SELECT * FROM blackbox_decisions WHERE status='pending_review' AND verdict IS NULL
           ORDER BY created_at DESC LIMIT ?`).all(limit);
        return rows.map(rowToDecision);
    }
    listRecent(domain, limit) {
        const rows = this.db.prepare(`SELECT * FROM blackbox_decisions WHERE domain = ? ORDER BY id DESC LIMIT ?`).all(domain, limit);
        return rows.map(rowToDecision);
    }
}
//# sourceMappingURL=store-sqlite.js.map