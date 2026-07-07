import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFileBlackBox, BlackboxJsonFile, JsonFileRuleStore, JsonFileDecisionLedger } from './store-jsonfile.js';
import type { Condition } from './types.js';

const COND: Condition = { op: 'cmp', feature: 'x', cmp: '>=', value: 1 };

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'bb-file-')), 'blackbox.json');
}

describe('JSON ファイルストア', () => {
  it('rules / ledger の round-trip とインスタンス跨ぎの永続', () => {
    const path = tmpPath();
    const file = new BlackboxJsonFile(path);
    const store = new JsonFileRuleStore(file);
    const rule = store.insert({ domain: 'd', description: 'r', when: COND, output: { y: 1 } });
    expect(store.findByFingerprint('d', rule.fingerprint)?.id).toBe(rule.id);
    store.update(rule.id, { state: 'trial' });

    const ledger = new JsonFileDecisionLedger(file);
    const id = ledger.record({
      domain: 'd', input: null, features: { x: 2 }, output: { y: 1 },
      source: 'rule', ruleId: rule.id, confidence: 0.7, rationale: 't',
      status: 'pending_review', shadow: [], createdAt: '2026-07-02T00:00:00.000Z',
    });
    expect(ledger.listPending('d')).toHaveLength(1);

    // 別インスタンスで開き直しても読める (write-through 永続)
    const reopened = new JsonFileRuleStore(new BlackboxJsonFile(path));
    expect(reopened.get(rule.id)?.state).toBe('trial');
    const reopenedLedger = new JsonFileDecisionLedger(new BlackboxJsonFile(path));
    expect(reopenedLedger.get(id)?.features).toEqual({ x: 2 });
  });

  it('makeFileBlackBox で学習ループが回る (提案→影昇格→trial 発火)', async () => {
    const bb = makeFileBlackBox(tmpPath());
    const counter = { calls: 0 };
    for (let i = 0; i < 4; i++) {
      await bb.engine.decide('d', {}, { x: 5 }, async () => {
        counter.calls += 1;
        return {
          output: { y: 1 }, confidence: 0.9, rationale: 't',
          proposedRule: { description: 'x>=1 は y=1', when: COND, output: { y: 1 } },
        };
      });
    }
    expect(bb.rules.listByDomain('d')[0].state).toBe('trial');
    expect(counter.calls).toBe(4);
    const { decision } = await bb.engine.decide('d', {}, { x: 5 }, async () => {
      throw new Error('LLM は呼ばれないはず');
    });
    expect(decision.source).toBe('rule');
    expect(bb.stats('d').ruleStates.trial).toBe(1);
  });

  it('ledger は maxDecisions で丸められる', () => {
    const bb = makeFileBlackBox(tmpPath(), { maxDecisions: 3 });
    for (let i = 0; i < 5; i++) {
      bb.ledger.record({
        domain: 'd', input: null, features: {}, output: null,
        source: 'llm', ruleId: null, confidence: 0.5, rationale: 't',
        status: 'auto', shadow: [], createdAt: '2026-07-02T00:00:00.000Z',
      });
    }
    expect(bb.ledger.listRecent('d', 100)).toHaveLength(3);
  });

  it('壊れた JSON は空状態として扱う (throw しない)', () => {
    const path = tmpPath();
    const file = new BlackboxJsonFile(path);
    file.save({ rules: [], decisions: [], seq: 0 });
    writeFileSync(path, '{broken', 'utf8');
    expect(new JsonFileRuleStore(new BlackboxJsonFile(path)).listByDomain('d')).toEqual([]);
  });
});
