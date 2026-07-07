// JSON ファイル実装の RuleStore / DecisionLedger。
//
// SQLite を持たない (持ちたくない) 利用者向け: ルールと判断 ledger を 1 つの
// JSON ファイルに write-through 永続化する。CLI / ゲームサーバのターン粒度なら十分軽い。
// node:fs に依存するため root バレル (index.ts) からは export せず、
// サブパス `@ludiars/blackbox/file` からのみ import する (ブラウザ利用を壊さない)。
//
// 由来: Famulus src/switcher/blackbox-store.ts の一般化 (初出はそちら)。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  DecisionLedger, DecisionRecord, Rule, RuleDraft, RulePatch, RuleStore,
} from './types.js';
import { ruleFingerprint } from './fingerprint.js';
import { BlackBoxEngine, type EngineOptions } from './engine.js';
import { domainStats } from './stats.js';
import type { BlackBox } from './index.js';

interface FileState {
  rules: Rule[];
  decisions: DecisionRecord[];
  seq: number;
}

export interface JsonFileStoreOptions {
  /** ledger に保持する直近判断数 (肥大防止)。既定 1000。ルールは丸めない。 */
  maxDecisions?: number;
  /** 時刻源 (テスト用)。 */
  now?: () => string;
}

function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `bb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** rules / decisions を 1 つの JSON に共載する共有ファイル。 */
export class BlackboxJsonFile {
  constructor(private readonly path: string) {}

  load(): FileState {
    if (!existsSync(this.path)) return { rules: [], decisions: [], seq: 0 };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileState>;
      return {
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
      };
    } catch {
      return { rules: [], decisions: [], seq: 0 };
    }
  }

  save(state: FileState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
}

export class JsonFileRuleStore implements RuleStore {
  private readonly now: () => string;

  constructor(private readonly file: BlackboxJsonFile, opts: JsonFileStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  listByDomain(domain: string): Rule[] {
    return this.file.load().rules
      .filter((r) => r.domain === domain)
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }

  findByFingerprint(domain: string, fingerprint: string): Rule | null {
    return this.file.load().rules.find((r) => r.domain === domain && r.fingerprint === fingerprint) ?? null;
  }

  get(id: string): Rule | null {
    return this.file.load().rules.find((r) => r.id === id) ?? null;
  }

  insert(draft: RuleDraft): Rule {
    const state = this.file.load();
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
    state.rules.push(rule);
    this.file.save(state);
    return { ...rule };
  }

  update(id: string, patch: RulePatch): Rule | null {
    const state = this.file.load();
    const idx = state.rules.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const next: Rule = { ...state.rules[idx], ...patch, updatedAt: this.now() };
    state.rules[idx] = next;
    this.file.save(state);
    return { ...next };
  }
}

export class JsonFileDecisionLedger implements DecisionLedger {
  private readonly maxDecisions: number;

  constructor(private readonly file: BlackboxJsonFile, opts: JsonFileStoreOptions = {}) {
    this.maxDecisions = opts.maxDecisions ?? 1000;
  }

  record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number {
    const state = this.file.load();
    const id = ++state.seq;
    state.decisions.push({ ...rec, id, verdict: null, reviewedAt: null });
    if (state.decisions.length > this.maxDecisions) {
      state.decisions = state.decisions.slice(-this.maxDecisions);
    }
    this.file.save(state);
    return id;
  }

  get(id: number): DecisionRecord | null {
    return this.file.load().decisions.find((d) => d.id === id) ?? null;
  }

  setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void {
    const state = this.file.load();
    const rec = state.decisions.find((d) => d.id === id);
    if (rec) {
      rec.verdict = verdict;
      rec.reviewedAt = reviewedAt;
      this.file.save(state);
    }
  }

  listPending(domain?: string, limit = 50): DecisionRecord[] {
    return this.file.load().decisions
      .filter((d) => d.status === 'pending_review' && d.verdict === null && (!domain || d.domain === domain))
      .slice(-limit)
      .reverse();
  }

  listRecent(domain: string, limit: number): DecisionRecord[] {
    return this.file.load().decisions
      .filter((d) => d.domain === domain)
      .slice(-limit)
      .reverse();
  }
}

/** JSON ファイルで束ねた blackbox を 1 つ作る (CLI / ゲームサーバ向け)。 */
export function makeFileBlackBox(
  path: string,
  opts: EngineOptions & JsonFileStoreOptions = {},
): BlackBox {
  const file = new BlackboxJsonFile(path);
  const rules = new JsonFileRuleStore(file, opts);
  const ledger = new JsonFileDecisionLedger(file, opts);
  const engine = new BlackBoxEngine(rules, ledger, opts);
  return {
    engine, rules, ledger,
    stats: (domain, window = 100) =>
      domainStats(domain, ledger.listRecent(domain, window), rules.listByDomain(domain)),
  };
}
