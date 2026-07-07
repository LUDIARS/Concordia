import { describe, expect, it } from 'vitest';
// 静的 import だと vite 5 が node:sqlite を builtin と認識できず解決に失敗する。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
import { BlackBoxEngine } from './engine.js';
import { ensureBlackboxSchema, SqliteDecisionLedger, SqliteRuleStore, type SqliteLike } from './store-sqlite.js';
import { makeSqliteBlackBox } from './index.js';
import type { Condition } from './types.js';

const COND: Condition = { op: 'cmp', feature: 'x', cmp: '>=', value: 1 };

function freshDb(): SqliteLike {
  return new DatabaseSync(':memory:') as unknown as SqliteLike;
}

describe('SqliteRuleStore / SqliteDecisionLedger (node:sqlite)', () => {
  it('insert / get / update / findByFingerprint の round-trip', () => {
    const db = freshDb();
    ensureBlackboxSchema(db);
    const store = new SqliteRuleStore(db);
    const rule = store.insert({ domain: 'd', description: 'r1', when: COND, output: { y: 1 } });
    expect(rule.state).toBe('candidate');
    expect(rule.fingerprint).not.toBe('');
    expect(store.findByFingerprint('d', rule.fingerprint)?.id).toBe(rule.id);
    const updated = store.update(rule.id, { state: 'trial', shadowAgreements: 3 })!;
    expect(updated.state).toBe('trial');
    expect(updated.shadowAgreements).toBe(3);
    expect(store.listByDomain('d')).toHaveLength(1);
  });

  it('ledger の record / verdict / listPending / listRecent + shadow_json 永続化', () => {
    const db = freshDb();
    ensureBlackboxSchema(db);
    const ledger = new SqliteDecisionLedger(db);
    const id = ledger.record({
      domain: 'd', input: { a: 1 }, features: { x: 2 }, output: { y: 1 },
      source: 'llm', ruleId: null, confidence: 0.9, rationale: 't',
      status: 'pending_review', shadow: [{ ruleId: 'r-1', agreed: true }],
      createdAt: '2026-07-02T00:00:00.000Z',
    });
    const rec = ledger.get(id)!;
    expect(rec.shadow).toEqual([{ ruleId: 'r-1', agreed: true }]);
    expect(ledger.listPending('d')).toHaveLength(1);
    ledger.setVerdict(id, 'ok', '2026-07-02T00:01:00.000Z');
    expect(ledger.listPending('d')).toHaveLength(0);
    expect(ledger.listRecent('d', 10)).toHaveLength(1);
  });

  it('engine を SQLite ストアで回しても学習が進む (promote まで)', async () => {
    const bb = makeSqliteBlackBox(freshDb());
    const counter = { calls: 0 };
    for (let i = 0; i < 4; i++) {
      await bb.engine.decide('d', {}, { x: 5 }, async () => {
        counter.calls += 1;
        return {
          output: { y: 1 }, confidence: 0.9, rationale: 't',
          proposedRule: { description: 'x>=1 なら y=1', when: COND, output: { y: 1 } },
        };
      });
    }
    expect(bb.rules.listByDomain('d')[0].state).toBe('trial');
    const stats = bb.stats('d');
    expect(stats.window).toBe(4);
    expect(stats.llmDecisions).toBe(4);
    expect(stats.ruleStates.trial).toBe(1);
  });

  it('Memoria 旧 schema (enabled 列 / state 無し) から追い付き migration できる', () => {
    const db = freshDb();
    // 旧 schema を再現 (Memoria spec/data/blackbox.md v1 相当)
    db.exec(`
      CREATE TABLE blackbox_rules (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, description TEXT NOT NULL,
        when_json TEXT NOT NULL, output_json TEXT NOT NULL,
        confidence REAL NOT NULL, enabled INTEGER NOT NULL,
        source TEXT NOT NULL, approvals INTEGER NOT NULL, rejections INTEGER NOT NULL,
        priority INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE blackbox_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
        input_json TEXT, features_json TEXT, output_json TEXT,
        source TEXT NOT NULL, rule_id TEXT, confidence REAL NOT NULL,
        rationale TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT,
        created_at TEXT NOT NULL, reviewed_at TEXT
      );
    `);
    const when = JSON.stringify(COND);
    const ins = db.prepare(
      `INSERT INTO blackbox_rules VALUES (?, 'd', ?, ?, '{"y":1}', 0.7, ?, 'llm', ?, ?, 0, 't', 't')`,
    );
    ins.run('r-cand', '未承認 LLM 提案', when, 0, 0, 0);        // → candidate
    ins.run('r-trial', '有効化済み', when, 1, 1, 0);            // → trial
    ins.run('r-auto', '承認3回', when, 1, 3, 0);                // → auto
    ins.run('r-retired', 'NG3回', when, 0, 0, 3);               // → retired

    ensureBlackboxSchema(db);
    const store = new SqliteRuleStore(db);
    const byId = new Map(store.listByDomain('d').map((r) => [r.id, r]));
    expect(byId.get('r-cand')!.state).toBe('candidate');
    expect(byId.get('r-trial')!.state).toBe('trial');
    expect(byId.get('r-auto')!.state).toBe('auto');
    expect(byId.get('r-retired')!.state).toBe('retired');
    // fingerprint が全行埋まる (重複内容は同一指紋)
    expect(byId.get('r-cand')!.fingerprint).toBe(byId.get('r-trial')!.fingerprint);
    // 冪等: もう一度呼んでも壊れない
    ensureBlackboxSchema(db);
    expect(store.listByDomain('d')).toHaveLength(4);
  });
});
