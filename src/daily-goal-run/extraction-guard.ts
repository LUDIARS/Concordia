/**
 * 読み取った項目が投稿本文に根拠を持つかを検査する (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 読み取りは投稿に書かれていることだけを拾う / CC-DG-INV-04 / CC-DG-INV-09
 *
 * 各項目の引用 (quotes) が本文 (正規化後) の部分文字列であるときだけ採用する。 根拠の無い項目は
 * 欠けとして捨てる。 許可は根拠のある可だけを残し、 それ以外は不可。 Actio task ID は本文に
 * そのまま書かれているものだけ。
 */

import { PERMISSION_KEYS, type ExtractedGoal, type GoalPermissions } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:d669afd2 */
import augurContract_1b2b1378 from './guard-extraction.contract.js'; /* augur-inject:contract-predicate:43eae24f */

export function normalizeForQuote(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export interface GuardedExtraction {
  extracted: ExtractedGoal;
  /** 根拠が無く捨てた項目 (例 `goalText` / `acceptance.1` / `permissions.merge`)。 */
  dropped: string[];
}

export function guardExtraction(text: string, raw: ExtractedGoal): GuardedExtraction {
  const body = normalizeForQuote(text);
  const grounded = (quote: string | undefined): boolean => {
    const value = normalizeForQuote(quote ?? "");
    return value.length > 0 && body.includes(value);
  };
  const dropped: string[] = [];
  const quotes: Record<string, string> = {};
  const keep = (field: string, value: string | undefined): string | undefined => {
    if (!value?.trim()) return undefined;
    if (!grounded(raw.quotes[field])) { dropped.push(field); return undefined; }
    quotes[field] = raw.quotes[field]!;
    return value.trim();
  };
  const project = keep("project", raw.project);
  const goalText = keep("goalText", raw.goalText);
  const acceptance: string[] = [];
  raw.acceptance.forEach((item, index) => {
    if (!item.trim()) return;
    if (!grounded(raw.quotes[`acceptance.${index}`])) { dropped.push(`acceptance.${index}`); return; }
    quotes[`acceptance.${acceptance.length}`] = raw.quotes[`acceptance.${index}`]!;
    acceptance.push(item.trim());
  });
  const permissions: GoalPermissions = { merge: false, test: false, service: false, deploy: false };
  for (const key of PERMISSION_KEYS) {
    if (!raw.permissions[key]) continue;
    if (grounded(raw.quotes[`permissions.${key}`])) {
      permissions[key] = true;
      quotes[`permissions.${key}`] = raw.quotes[`permissions.${key}`]!;
    } else dropped.push(`permissions.${key}`);
  }
  const actioTaskIds = [...new Set(raw.actioTaskIds.map((id) => id.trim().replace(/^actio:/i, "")).filter(Boolean))]
    .filter((id) => {
      if (body.includes(id)) return true;
      dropped.push(`actio:${id}`);
      return false;
    });
  return {
    extracted: { ...(project ? { project } : {}), ...(goalText ? { goalText } : {}), acceptance, permissions, actioTaskIds, quotes },
    dropped,
  };
}
// @ts-expect-error augur-inject
guardExtraction = contract(guardExtraction, { ...augurContract_1b2b1378, contractId: 'dg-C-11', mode: 'observe', sample: 1, where: 'src/daily-goal-run/extraction-guard.ts:23', rule: 'contract-wrap', id: '1b2b1378' }); /* augur-inject:contract-wrap:1b2b1378 */
