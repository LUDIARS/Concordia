import { contract } from './ontime-runtime.js'; /* augur-inject:import:5f170f54 */
import augurContract_0a36a124 from './consult-end-word.contract.js'; /* augur-inject:contract-predicate:3f67fce1 */
/**
 * 相談窓口での一言の「終了」を終了の指示として読む (spec/feature/tech-consultation.md §6.1、
 * spec/feature/session-end-request.md)。
 *
 * 2026-10-03 neco 指示:「『終了』でセッション終了します」「これは相談窓口で終了と言われたら終了するという意味です」。
 * 一言の「終了」は相談のセッションでだけ拾う。 相談以外で拾うと、 作業の途中で誤って終わらせる損害の方が大きい
 * (呼び出し側が相談の部署かを判定してから使う)。 発言全体がこの形のときだけ受け、 打ち消しや文中の「終了」は受けない。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

const CONSULT_END_WORD = /^(?:終了(?:です|します)?|終わり(?:です)?|おわり)[。.!！]*$/;

/** 発言全体が相談の終了の一言 (「終了」「終了です」「終了します」「終わり」「おわり」「終わりです」) か。 */
export function detectsConsultEndWord(text: string): boolean {
  const normalized = text.replace(/[\s　]+/g, "");
  return CONSULT_END_WORD.test(normalized);
}
// @ts-expect-error augur-inject
detectsConsultEndWord = contract(detectsConsultEndWord, { ...augurContract_0a36a124, contractId: 'consult-log-C-1', mode: 'observe', sample: 1, where: 'src/consultation/consult-end-word.ts:15', rule: 'contract-wrap', id: '0a36a124' }); /* augur-inject:contract-wrap:0a36a124 */
