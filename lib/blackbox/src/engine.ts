// 成長型ブラックボックスの中核アルゴリズム。
//
// decide():        live ルール (trial/auto) 優先 → 無ければ LLM フォールバック。
//                  どちらの経路でも candidate ルールを影評価し、教師 (auto ルール /
//                  LLM の出力) との一致・衝突を蓄積する。全判断を ledger に記録。
// recordVerdict(): 人間の OK/NG。 trial ルールの昇格 / 撤回に加え、 LLM 判断への NG は
//                  その判断を教師にした影評価を反転する (誤った教師で育てない)。
//
// 永続化と LLM は注入された interface 越しにのみ触る。

import type {
  Decision, DecisionLedger, FeatureMap, LlmFallback,
  Rule, RuleDraft, RuleStore, ShadowEval,
} from './types.js';
import { evaluate, describeCondition } from './condition.js';
import { ruleFingerprint, sameOutput } from './fingerprint.js';
import { DEFAULT_THRESHOLDS, isLive, shadowPatch, verdictPatch, type Thresholds } from './lifecycle.js';

export interface EngineOptions extends Partial<Thresholds> {
  /**
   * LLM 由来の判断も pending_review としてレビューキューに載せるか (既定 true)。
   * false にすると旧 Memoria 実装と同じく LLM 判断は auto 扱いで採点対象外になる。
   */
  reviewLlmDecisions?: boolean;
  /** 時刻源 (テスト / ゲームのゲーム内時間用に差し替え可)。 */
  now?: () => string;
}

export class BlackBoxEngine {
  private readonly t: Thresholds;
  private readonly reviewLlm: boolean;
  private readonly now: () => string;

  constructor(
    private readonly rules: RuleStore,
    private readonly ledger: DecisionLedger,
    opts: EngineOptions = {},
  ) {
    this.t = {
      autoPromote: opts.autoPromote ?? DEFAULT_THRESHOLDS.autoPromote,
      autoRetract: opts.autoRetract ?? DEFAULT_THRESHOLDS.autoRetract,
      shadowPromote: opts.shadowPromote ?? DEFAULT_THRESHOLDS.shadowPromote,
      shadowConflictLimit: opts.shadowConflictLimit ?? DEFAULT_THRESHOLDS.shadowConflictLimit,
    };
    this.reviewLlm = opts.reviewLlmDecisions ?? true;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** domain の live ルールを priority 降順で評価し最初のヒットを返す。 */
  private firstLiveMatch(rules: Rule[], features: FeatureMap): Rule | null {
    const live = rules
      .filter((r) => isLive(r.state))
      .sort((a, b) => b.priority - a.priority);
    for (const r of live) {
      if (evaluate(r.when, features)) return r;
    }
    return null;
  }

  /**
   * domain の判断を下す。 結果は ledger に記録され decisionId が付与される。
   * 戻り値の decisionId で後から recordVerdict できる。
   */
  async decide<I, O>(
    domain: string,
    input: I,
    features: FeatureMap,
    llmFallback: LlmFallback<I, O>,
  ): Promise<{ decision: Decision<O>; decisionId: number }> {
    const all = this.rules.listByDomain(domain);
    const hit = this.firstLiveMatch(all, features);

    if (hit) {
      const trusted = hit.state === 'auto';
      // 教師にできるのは卒業済み (auto) ルールの出力のみ。 trial の出力はまだ検証中。
      const shadow = trusted ? this.runShadow(all, features, hit.output) : [];
      const decision: Decision<O> = {
        output: hit.output as O,
        source: 'rule',
        ruleId: hit.id,
        confidence: hit.confidence,
        rationale: trusted
          ? `ルール「${hit.description}」で判定 (${describeCondition(hit.when)})`
          : `ルール「${hit.description}」で先に判定しました — OK/NG をお願いします (承認 ${hit.approvals}/${this.t.autoPromote})`,
        status: trusted ? 'auto' : 'pending_review',
      };
      const decisionId = this.ledger.record({
        domain, input, features,
        output: decision.output, source: 'rule', ruleId: hit.id,
        confidence: decision.confidence, rationale: decision.rationale,
        status: decision.status, shadow, createdAt: this.now(),
      });
      return { decision, decisionId };
    }

    // ルール無し → LLM に判断させる。 撤回済みルールを知らせて再提案を防ぐ。
    const retiredRules = all
      .filter((r) => r.state === 'retired')
      .map((r) => ({ description: r.description, whenText: describeCondition(r.when) }));
    const j = await llmFallback(input, features, { domain, retiredRules });

    const proposedId = j.proposedRule ? this.propose(domain, j.proposedRule) : null;
    // 影評価: 既存 candidate を LLM の出力 (教師) と突合。 いま提案されたばかりの
    // ルールは自分の出力と一致するのが自明なので除外する。
    const fresh = proposedId ? this.rules.listByDomain(domain) : all;
    const shadow = this.runShadow(fresh, features, j.output, proposedId);

    const decision: Decision<O> = {
      output: j.output,
      source: 'llm',
      confidence: j.confidence,
      rationale: `LLM が判定: ${j.rationale}`,
      status: this.reviewLlm ? 'pending_review' : 'auto',
    };
    const decisionId = this.ledger.record({
      domain, input, features,
      output: decision.output, source: 'llm', ruleId: null,
      confidence: decision.confidence, rationale: decision.rationale,
      status: decision.status, shadow, createdAt: this.now(),
    });
    return { decision, decisionId };
  }

  /** LLM 提案を candidate として登録する。 同一指紋は proposals++ にマージ、 撤回済みは黙殺。 */
  private propose(domain: string, proposal: Omit<RuleDraft, 'domain' | 'state' | 'source'>): string | null {
    const fingerprint = ruleFingerprint(proposal.when, proposal.output);
    const existing = this.rules.findByFingerprint(domain, fingerprint);
    if (existing) {
      if (existing.state === 'retired') return null;
      this.rules.update(existing.id, {
        proposals: existing.proposals + 1,
        confidence: Math.max(existing.confidence, proposal.confidence ?? 0),
      });
      return null;
    }
    try {
      const rule = this.rules.insert({
        ...proposal, domain, source: 'llm', state: 'candidate',
      });
      return rule.id;
    } catch {
      return null; // 候補登録の失敗は判断本体を止めない
    }
  }

  /** candidate ルールを教師出力と突合し、 カウンタ更新 + 昇格/間引きまで進める。 */
  private runShadow(
    rules: Rule[], features: FeatureMap, teacherOutput: unknown, excludeId: string | null = null,
  ): ShadowEval[] {
    const evals: ShadowEval[] = [];
    for (const r of rules) {
      if (r.state !== 'candidate' || r.id === excludeId) continue;
      if (!evaluate(r.when, features)) continue;
      const agreed = sameOutput(r.output, teacherOutput);
      evals.push({ ruleId: r.id, agreed });
      const patch = shadowPatch(r, agreed ? { agreements: 1 } : { conflicts: 1 }, this.t);
      if (patch) this.rules.update(r.id, patch);
    }
    return evals;
  }

  /**
   * 人間の OK/NG を記録する。
   * - ルール由来 OK → approvals++ (trial は閾値到達で auto = 卒業)
   * - ルール由来 NG → rejections++ (閾値到達で retired = 自己修復)
   * - LLM 由来 NG → 教師が誤っていたので、 その判断での影評価を反転する
   */
  recordVerdict(decisionId: number, verdict: 'ok' | 'ng'): { ok: boolean; ruleUpdated?: Rule } {
    const rec = this.ledger.get(decisionId);
    if (!rec) return { ok: false };
    this.ledger.setVerdict(decisionId, verdict, this.now());

    if (rec.source === 'rule' && rec.ruleId) {
      const rule = this.rules.get(rec.ruleId);
      if (!rule) return { ok: true };
      const updated = this.rules.update(rule.id, verdictPatch(rule, verdict, this.t));
      return { ok: true, ruleUpdated: updated ?? undefined };
    }

    if (rec.source === 'llm' && verdict === 'ng') {
      for (const ev of rec.shadow) {
        const rule = this.rules.get(ev.ruleId);
        if (!rule || rule.state !== 'candidate') continue;
        // 教師 (LLM) が NG → 一致は誤った加点だったので衝突へ振り替え。
        // 不一致は「実は正しかったかもしれない」ので減点だけ取り消す (加点はしない)。
        const patch = shadowPatch(
          rule,
          ev.agreed ? { agreements: -1, conflicts: 1 } : { conflicts: -1 },
          this.t,
        );
        if (patch) this.rules.update(ev.ruleId, patch);
      }
    }
    return { ok: true };
  }

  /** 手動 / 採掘でルールを追加する。 manual は trial から始まる (人間直書きでも実地検証は踏む)。 */
  addRule(draft: RuleDraft): Rule {
    // draft.state が undefined のキー付きで来ても既定を潰さないよう明示的に解決する。
    const state = draft.state ?? (draft.source === 'seed' ? 'auto' : 'trial');
    return this.rules.insert({ ...draft, state });
  }

  /** ルールの状態を手動で変更する (UI からの昇格 / 撤回 / 復活)。 */
  setRuleState(id: string, state: Rule['state']): Rule | null {
    return this.rules.update(id, { state });
  }

  listRules(domain: string): Rule[] {
    return this.rules.listByDomain(domain);
  }
}
