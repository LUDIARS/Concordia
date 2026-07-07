// 成長型ブラックボックス — ドメイン非依存の中核型。
//
// このパッケージはランタイム依存ゼロ (Node 組込みすら engine/condition では使わない)。
// 永続化 (RuleStore / DecisionLedger) と LLM (LlmFallback) は利用側が注入する。
// 由来: Memoria server/blackbox/ を共通ライブラリ化 + 学習ループ再設計 (DESIGN.md)。

/** 判断の入力をフラット化した特徴量。 ルールはこの map だけを見る。 */
export type FeatureValue = number | string | boolean;
export type FeatureMap = Record<string, FeatureValue>;

/** 直列化可能な述語 AST。 コードでなくデータなので DB 保存・LLM 生成が可能。 */
export type Condition =
  | { op: 'cmp'; feature: string; cmp: CmpOp; value: FeatureValue }
  | { op: 'in'; feature: string; values: Array<string | number> }
  | { op: 'and'; clauses: Condition[] }
  | { op: 'or'; clauses: Condition[] }
  | { op: 'not'; clause: Condition };

export type CmpOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/**
 * ルールのライフサイクル。
 *
 *   candidate — LLM 提案直後。発火しないが影 (shadow) で毎判断と突合され、
 *               一致が閾値に達すると trial へ自動昇格 (LLM が教師)。
 *   trial     — 実際に発火するが毎回 pending_review で人間の OK/NG を受ける。
 *   auto      — 卒業。LLM も人間確認も不要で即決。
 *   retired   — 撤回。発火せず、同一内容の再提案もブロックされる。
 */
export type RuleState = 'candidate' | 'trial' | 'auto' | 'retired';

/** ルール = 「条件が成立したらこの output を返す」 を表すデータ。 */
export interface Rule {
  id: string;
  domain: string;
  description: string;
  when: Condition;
  /** 条件成立時の判断結果 (JSON 直列化可能な任意値)。 */
  output: unknown;
  confidence: number;          // 0..1
  state: RuleState;
  source: 'llm' | 'manual' | 'seed';
  approvals: number;           // 人間が OK した回数 (trial → auto の信頼蓄積)
  rejections: number;          // NG にした回数 (閾値到達で retired)
  shadowAgreements: number;    // candidate が教師 (LLM/auto ルール) と一致した回数
  shadowConflicts: number;     // candidate が教師と食い違った回数
  proposals: number;           // 同一内容 (fingerprint) が LLM から提案された回数
  /** when + output の正規化ハッシュ。重複提案のマージと撤回後の再提案ブロックに使う。 */
  fingerprint: string;
  priority: number;            // 同 domain 内の適用順 (大きいほど先)
  createdAt: string;
  updatedAt: string;
}

/** ルールを作るための入力 (id / fingerprint / 監査列はストアが補完)。 */
export interface RuleDraft {
  domain: string;
  description: string;
  when: Condition;
  output: unknown;
  confidence?: number;
  state?: RuleState;
  source?: Rule['source'];
  priority?: number;
}

/** 判断の結果 + 来歴。 */
export interface Decision<O = unknown> {
  output: O;
  source: 'rule' | 'llm';
  ruleId?: string;
  confidence: number;
  rationale: string;
  /** 人間の OK/NG 待ちなら pending_review (trial ルール由来、および設定次第で LLM 由来)。 */
  status: 'auto' | 'pending_review';
}

/** 1 判断で candidate ルールを影評価した結果 (verdict 反転に使うため ledger に残す)。 */
export interface ShadowEval {
  ruleId: string;
  /** 条件が成立し、かつ output が教師と一致したか。 */
  agreed: boolean;
}

/** ledger に残る 1 判断のレコード (永続化された Decision + 入力)。 */
export interface DecisionRecord {
  id: number;
  domain: string;
  input: unknown;
  features: FeatureMap;
  output: unknown;
  source: 'rule' | 'llm';
  ruleId: string | null;
  confidence: number;
  rationale: string;
  status: 'auto' | 'pending_review';
  verdict: 'ok' | 'ng' | null;
  shadow: ShadowEval[];
  createdAt: string;
  reviewedAt: string | null;
}

/** LLM フォールバックに渡す文脈。撤回済みルールを知らせて同じ失敗の再提案を防ぐ。 */
export interface LlmContext {
  domain: string;
  retiredRules: Array<{ description: string; whenText: string }>;
}

/**
 * LLM フォールバックの戻り値。 LLM は判断結果に加えて、
 * 「この判断はルール化可能」 なら Condition 形式のルール候補を返せる。
 */
export interface LlmJudgement<O = unknown> {
  output: O;
  confidence: number;
  rationale: string;
  /** ルール化可能なら候補を返す。candidate として登録され影評価で信頼を積む。 */
  proposedRule?: Omit<RuleDraft, 'domain' | 'state' | 'source'>;
}

/** raw 入力から LLM 判断を得る関数 (利用側で自前の LLM 呼び出しを束ねて注入)。 */
export type LlmFallback<I = unknown, O = unknown> =
  (input: I, features: FeatureMap, context: LlmContext) => Promise<LlmJudgement<O>>;

/** ルールの永続化境界。 実装は store-memory / store-sqlite、または利用側の自前実装。 */
export interface RuleStore {
  listByDomain(domain: string): Rule[];
  findByFingerprint(domain: string, fingerprint: string): Rule | null;
  insert(draft: RuleDraft): Rule;
  update(id: string, patch: RulePatch): Rule | null;
  get(id: string): Rule | null;
}

export type RulePatch = Partial<Pick<Rule,
  'state' | 'approvals' | 'rejections' | 'shadowAgreements' | 'shadowConflicts'
  | 'proposals' | 'confidence' | 'priority' | 'description'>>;

/** 判断 ledger の永続化境界。 */
export interface DecisionLedger {
  record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number;
  get(id: number): DecisionRecord | null;
  setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void;
  /** レビュー待ちキュー: pending_review でまだ verdict が無い判断。 */
  listPending(domain?: string, limit?: number): DecisionRecord[];
  /** 直近の判断 (新しい順)。卒業メトリクス (ルール被覆率) の算出に使う。 */
  listRecent(domain: string, limit: number): DecisionRecord[];
}
