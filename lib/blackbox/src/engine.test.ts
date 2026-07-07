import { describe, expect, it } from 'vitest';
import { BlackBoxEngine, type EngineOptions } from './engine.js';
import { MemoryDecisionLedger, MemoryRuleStore } from './store-memory.js';
import type { Condition, FeatureMap, LlmFallback, LlmJudgement } from './types.js';

const COND_RAIN: Condition = { op: 'cmp', feature: 'peakAgreement', cmp: '>=', value: 0.6 };
const RAINY: FeatureMap = { peakAgreement: 0.8 };
const DRY: FeatureMap = { peakAgreement: 0.1 };

function makeEngine(opts: EngineOptions = {}) {
  const rules = new MemoryRuleStore();
  const ledger = new MemoryDecisionLedger();
  const engine = new BlackBoxEngine(rules, ledger, opts);
  return { engine, rules, ledger };
}

/** proposedRule 付きで {rain:true} を返す LLM フォールバック。呼び出し回数を数える。 */
function rainLlm(counter: { calls: number }, judgement?: Partial<LlmJudgement>): LlmFallback {
  return async () => {
    counter.calls += 1;
    return {
      output: { rain: true },
      confidence: 0.9,
      rationale: 'テスト用判定',
      proposedRule: {
        description: '一致率 0.6 以上は雨',
        when: COND_RAIN,
        output: { rain: true },
        confidence: 0.8,
      },
      ...judgement,
    };
  };
}

describe('BlackBoxEngine 学習ループ', () => {
  it('ルール無し → LLM 判断 + candidate 登録 (発火はしない)', async () => {
    const { engine, rules } = makeEngine();
    const counter = { calls: 0 };
    const { decision } = await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(decision.source).toBe('llm');
    expect(counter.calls).toBe(1);
    const all = rules.listByDomain('d');
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe('candidate');
    // candidate は発火しない: 次の判断も LLM に行く
    await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(counter.calls).toBe(2);
  });

  it('同一内容の再提案は proposals++ にマージされ重複行を作らない', async () => {
    const { engine, rules } = makeEngine();
    const counter = { calls: 0 };
    await engine.decide('d', {}, RAINY, rainLlm(counter));
    await engine.decide('d', {}, RAINY, rainLlm(counter));
    await engine.decide('d', {}, RAINY, rainLlm(counter));
    const all = rules.listByDomain('d');
    expect(all).toHaveLength(1);
    expect(all[0].proposals).toBe(3);
  });

  it('影の一致が閾値に達すると candidate → trial に昇格し発火が始まる', async () => {
    const { engine, rules } = makeEngine({ shadowPromote: 3 });
    const counter = { calls: 0 };
    // 1 回目: 提案 (自明一致は除外)。2〜4 回目: 影一致が 3 回積まれ trial へ。
    for (let i = 0; i < 4; i++) await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(rules.listByDomain('d')[0].state).toBe('trial');
    expect(counter.calls).toBe(4);
    // trial は発火する: 5 回目は LLM を呼ばず pending_review
    const { decision } = await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(counter.calls).toBe(4);
    expect(decision.source).toBe('rule');
    expect(decision.status).toBe('pending_review');
  });

  it('影の衝突が閾値に達すると candidate は retired に間引かれる', async () => {
    const { engine, rules } = makeEngine({ shadowConflictLimit: 2 });
    const counter = { calls: 0 };
    await engine.decide('d', {}, RAINY, rainLlm(counter)); // 提案
    const dissent = rainLlm(counter, { output: { rain: false }, proposedRule: undefined });
    await engine.decide('d', {}, RAINY, dissent); // 衝突 1
    await engine.decide('d', {}, RAINY, dissent); // 衝突 2 → retired
    expect(rules.listByDomain('d')[0].state).toBe('retired');
  });

  it('trial ルールに OK×3 で auto (卒業)、以後は即決', async () => {
    const { engine, rules, ledger } = makeEngine();
    const rule = engine.addRule({
      domain: 'd', description: 'テスト', when: COND_RAIN, output: { rain: true },
    });
    expect(rule.state).toBe('trial');
    const counter = { calls: 0 };
    for (let i = 0; i < 3; i++) {
      const { decision, decisionId } = await engine.decide('d', {}, RAINY, rainLlm(counter));
      expect(decision.status).toBe('pending_review');
      engine.recordVerdict(decisionId, 'ok');
    }
    expect(rules.get(rule.id)!.state).toBe('auto');
    const { decision } = await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(decision.status).toBe('auto');
    expect(counter.calls).toBe(0);
    expect(ledger.listPending('d')).toHaveLength(0);
  });

  it('trial ルールに NG×3 で retired し、同一指紋の再提案はブロックされる', async () => {
    const { engine, rules } = makeEngine();
    const rule = engine.addRule({
      domain: 'd', description: 'テスト', when: COND_RAIN, output: { rain: true },
    });
    const counter = { calls: 0 };
    for (let i = 0; i < 3; i++) {
      const { decisionId } = await engine.decide('d', {}, RAINY, rainLlm(counter));
      engine.recordVerdict(decisionId, 'ng');
    }
    expect(rules.get(rule.id)!.state).toBe('retired');
    // retired 後は LLM に戻る。同じ内容を提案されても復活せず、撤回情報が context に載る
    let seenRetired = 0;
    const llm: LlmFallback = async (_i, _f, ctx) => {
      seenRetired = ctx.retiredRules.length;
      counter.calls += 1;
      return {
        output: { rain: true }, confidence: 0.9, rationale: 't',
        proposedRule: { description: '再提案', when: COND_RAIN, output: { rain: true } },
      };
    };
    await engine.decide('d', {}, RAINY, llm);
    expect(seenRetired).toBe(1);
    expect(rules.listByDomain('d')).toHaveLength(1); // 再挿入されていない
  });

  it('LLM 判断への NG は影評価を反転する (誤った教師で育てない)', async () => {
    const { engine, rules, ledger } = makeEngine();
    const counter = { calls: 0 };
    await engine.decide('d', {}, RAINY, rainLlm(counter)); // 提案 → candidate
    const { decisionId } = await engine.decide('d', {}, RAINY, rainLlm(counter)); // 影一致 1
    let rule = rules.listByDomain('d')[0];
    expect(rule.shadowAgreements).toBe(1);
    // 人間が「LLM のこの判断は間違い」と NG → 一致は衝突へ振り替え
    engine.recordVerdict(decisionId, 'ng');
    rule = rules.listByDomain('d')[0];
    expect(rule.shadowAgreements).toBe(0);
    expect(rule.shadowConflicts).toBe(1);
    expect(ledger.get(decisionId)!.verdict).toBe('ng');
  });

  it('LLM 判断は既定で pending_review としてレビューキューに載る', async () => {
    const { engine, ledger } = makeEngine();
    const counter = { calls: 0 };
    await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(ledger.listPending('d')).toHaveLength(1);
  });

  it('reviewLlmDecisions:false なら旧挙動 (LLM 判断は auto)', async () => {
    const { engine, ledger } = makeEngine({ reviewLlmDecisions: false });
    const counter = { calls: 0 };
    const { decision } = await engine.decide('d', {}, RAINY, rainLlm(counter));
    expect(decision.status).toBe('auto');
    expect(ledger.listPending('d')).toHaveLength(0);
  });

  it('addRule は state:undefined のキーが来ても manual→trial / seed→auto の既定を保つ', () => {
    const { engine } = makeEngine();
    const manual = engine.addRule({
      domain: 'd', description: 'm', when: COND_RAIN, output: { rain: true },
      state: undefined, source: 'manual',
    });
    expect(manual.state).toBe('trial');
    const seed = engine.addRule({
      domain: 'd2', description: 's', when: COND_RAIN, output: { rain: true },
      state: undefined, source: 'seed',
    });
    expect(seed.state).toBe('auto');
  });

  it('条件が成立しない判断では影評価は動かない', async () => {
    const { engine, rules } = makeEngine();
    const counter = { calls: 0 };
    await engine.decide('d', {}, RAINY, rainLlm(counter)); // 提案
    await engine.decide('d', {}, DRY, rainLlm(counter, { output: { rain: false }, proposedRule: undefined }));
    const rule = rules.listByDomain('d')[0];
    expect(rule.shadowAgreements).toBe(0);
    expect(rule.shadowConflicts).toBe(0);
  });
});
