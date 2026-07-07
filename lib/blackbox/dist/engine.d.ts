import type { Decision, DecisionLedger, FeatureMap, LlmFallback, Rule, RuleDraft, RuleStore } from './types.js';
import { type Thresholds } from './lifecycle.js';
export interface EngineOptions extends Partial<Thresholds> {
    /**
     * LLM 由来の判断も pending_review としてレビューキューに載せるか (既定 true)。
     * false にすると旧 Memoria 実装と同じく LLM 判断は auto 扱いで採点対象外になる。
     */
    reviewLlmDecisions?: boolean;
    /** 時刻源 (テスト / ゲームのゲーム内時間用に差し替え可)。 */
    now?: () => string;
}
export declare class BlackBoxEngine {
    private readonly rules;
    private readonly ledger;
    private readonly t;
    private readonly reviewLlm;
    private readonly now;
    constructor(rules: RuleStore, ledger: DecisionLedger, opts?: EngineOptions);
    /** domain の live ルールを priority 降順で評価し最初のヒットを返す。 */
    private firstLiveMatch;
    /**
     * domain の判断を下す。 結果は ledger に記録され decisionId が付与される。
     * 戻り値の decisionId で後から recordVerdict できる。
     */
    decide<I, O>(domain: string, input: I, features: FeatureMap, llmFallback: LlmFallback<I, O>): Promise<{
        decision: Decision<O>;
        decisionId: number;
    }>;
    /** LLM 提案を candidate として登録する。 同一指紋は proposals++ にマージ、 撤回済みは黙殺。 */
    private propose;
    /** candidate ルールを教師出力と突合し、 カウンタ更新 + 昇格/間引きまで進める。 */
    private runShadow;
    /**
     * 人間の OK/NG を記録する。
     * - ルール由来 OK → approvals++ (trial は閾値到達で auto = 卒業)
     * - ルール由来 NG → rejections++ (閾値到達で retired = 自己修復)
     * - LLM 由来 NG → 教師が誤っていたので、 その判断での影評価を反転する
     */
    recordVerdict(decisionId: number, verdict: 'ok' | 'ng'): {
        ok: boolean;
        ruleUpdated?: Rule;
    };
    /** 手動 / 採掘でルールを追加する。 manual は trial から始まる (人間直書きでも実地検証は踏む)。 */
    addRule(draft: RuleDraft): Rule;
    /** ルールの状態を手動で変更する (UI からの昇格 / 撤回 / 復活)。 */
    setRuleState(id: string, state: Rule['state']): Rule | null;
    listRules(domain: string): Rule[];
}
//# sourceMappingURL=engine.d.ts.map