// インメモリ実装の RuleStore / DecisionLedger。
//
// 用途: テスト、 ゲームランタイム (毎フレーム判断・セーブデータへ自前直列化)、
// 永続化不要なプロトタイプ。 直列化は snapshot()/restore() で利用側が行う。

import type {
  DecisionLedger, DecisionRecord, Rule, RuleDraft, RulePatch, RuleStore,
} from './types.js';
import { ruleFingerprint } from './fingerprint.js';

function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `bb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class MemoryRuleStore implements RuleStore {
  private rules = new Map<string, Rule>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  listByDomain(domain: string): Rule[] {
    return [...this.rules.values()]
      .filter((r) => r.domain === domain)
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }

  findByFingerprint(domain: string, fingerprint: string): Rule | null {
    for (const r of this.rules.values()) {
      if (r.domain === domain && r.fingerprint === fingerprint) return r;
    }
    return null;
  }

  get(id: string): Rule | null {
    return this.rules.get(id) ?? null;
  }

  insert(draft: RuleDraft): Rule {
    const ts = this.now();
    const rule: Rule = {
      id: newId(),
      domain: draft.domain,
      description: draft.description,
      when: draft.when,
      output: draft.output ?? null,
      confidence: draft.confidence ?? 0.7,
      state: draft.state ?? 'candidate',
      source: draft.source ?? 'manual',
      approvals: 0,
      rejections: 0,
      shadowAgreements: 0,
      shadowConflicts: 0,
      proposals: 1,
      fingerprint: ruleFingerprint(draft.when, draft.output ?? null),
      priority: draft.priority ?? 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rules.set(rule.id, rule);
    return { ...rule };
  }

  update(id: string, patch: RulePatch): Rule | null {
    const cur = this.rules.get(id);
    if (!cur) return null;
    const next: Rule = { ...cur, ...patch, updatedAt: this.now() };
    this.rules.set(id, next);
    return { ...next };
  }

  /** 直列化用スナップショット (ゲームのセーブデータ等)。 */
  snapshot(): Rule[] {
    return [...this.rules.values()].map((r) => ({ ...r }));
  }

  restore(rules: Rule[]): void {
    this.rules = new Map(rules.map((r) => [r.id, { ...r }]));
  }
}

export class MemoryDecisionLedger implements DecisionLedger {
  private records: DecisionRecord[] = [];
  private seq = 0;

  record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number {
    const id = ++this.seq;
    this.records.push({ ...rec, id, verdict: null, reviewedAt: null });
    return id;
  }

  get(id: number): DecisionRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.verdict = verdict;
      rec.reviewedAt = reviewedAt;
    }
  }

  listPending(domain?: string, limit = 50): DecisionRecord[] {
    return this.records
      .filter((r) => r.status === 'pending_review' && r.verdict === null && (!domain || r.domain === domain))
      .slice(-limit)
      .reverse();
  }

  listRecent(domain: string, limit: number): DecisionRecord[] {
    return this.records
      .filter((r) => r.domain === domain)
      .slice(-limit)
      .reverse();
  }
}
