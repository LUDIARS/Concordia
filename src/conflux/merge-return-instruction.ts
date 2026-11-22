import type { MergeReturnTarget } from "./merge-return-policy.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:539f2f6d */
import augurContract_01bd6f2b from './merge-return-instruction.contract.js'; /* augur-inject:contract-predicate:063607e1 */

export interface MergeReturnInstruction {
  title: string;
  body: string;
  params: Record<string, string>;
}

/**
 * Composes the Muse playtest instruction for a merge return (CC-RET-INV-03 / CC-RET-INV-05).
 * `build: false` means no Conflux build is queued: the agent fetches and builds the commit itself.
 */
export function mergeReturnInstruction(
  target: MergeReturnTarget, dedupeKey: string, build: boolean, repository: string | null,
): MergeReturnInstruction {
  const title = `${target.project_code} マージ後の再試遊`;
  if (build) {
    return {
      title,
      body: `マージされたコミット ${target.merge_commit_sha} を再試遊し、結果を報告してください。試遊に新しいビルドが必要な場合は、ビルド結果を確認してから実行してください。`,
      params: { ...target, dedupe_key: dedupeKey },
    };
  }
  const source = repository ? `${repository} の ${target.branch}` : target.branch;
  return {
    title,
    body: `マージされたコミット ${target.merge_commit_sha} (${source}) を自分の環境で取得・ビルドしてから遊び、感想を result で返してください。Concordia ではビルドしていません。`,
    params: { ...target, ...(repository ? { repository } : {}), dedupe_key: dedupeKey, build: "agent" },
  };
}
// @ts-expect-error augur-inject
mergeReturnInstruction = contract(mergeReturnInstruction, { ...augurContract_01bd6f2b, contractId: 'gen5-return-C-4', mode: 'observe', sample: 1, where: 'src/conflux/merge-return-instruction.ts:13', rule: 'contract-wrap', id: '01bd6f2b' }); /* augur-inject:contract-wrap:01bd6f2b */
