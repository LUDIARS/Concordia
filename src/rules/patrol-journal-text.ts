import { contract } from './ontime-runtime.js'; /* augur-inject:import:3909a35e */
import augurContract_130a909c from './patrol-journal-text.contract.js'; /* augur-inject:contract-predicate:7b983874 */
/** 外部の発言・LLM出力を日記の構文ではなく1行の文字として載せる。 */
export function journalText(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim()
    .replace(/[&<>"'\\`*_[\]{}#!|~]/g, (char) => `&#${char.charCodeAt(0)};`);
}
// @ts-expect-error augur-inject
journalText = contract(journalText, { ...augurContract_130a909c, contractId: 'journal-boundary-C-1', mode: 'observe', sample: 1, where: 'src/rules/patrol-journal-text.ts:2', rule: 'contract-wrap', id: '130a909c' }); /* augur-inject:contract-wrap:130a909c */
