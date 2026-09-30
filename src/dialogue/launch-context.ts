/**
 * 部署で起動するセッションへ渡す「対話の前提データ」を用意するユースケース (application)。
 *
 * 順序: 部署のユースケースを引く → 同じ会社の有効な訂正を新しい順に引く →
 * (使う設定なら) 依頼者メモを引き、 未登録なら空のメモ行を作る → ブロックを組み立てる。
 * 依頼者メモの中身はここで返すブロックにだけ入れ、 ログへは出さない (CC-DLG-INV-04)。
 *
 * @implements spec/feature/dialogue-context.md §5 / §7
 * @implements SPEC-DLG-STARTUP
 * @implements SPEC-DLG-PROFILES
 */

import type { CorrectionRow } from "../db/use-case-corrections-repo.js";
import type { RequesterIdentity, RequesterProfileRow } from "../db/requester-profiles-repo.js";
import type { UseCaseRow } from "../db/use-cases-repo.js";
import { USE_CASE_FORMATS } from "./formats.js";
import { buildDialogueStartupBlock, MAX_LAUNCH_CORRECTIONS } from "./startup-block.js";

export interface LaunchContextPorts {
  useCase(id: string): UseCaseRow | null;
  corrections(useCaseId: string, subsidiaryId: string | null, limit: number): CorrectionRow[];
  ensureRequester(identity: RequesterIdentity, displayName: string): RequesterProfileRow;
}

export interface LaunchContextInput {
  department: { name: string; subsidiary_id: string | null; use_case_id: string | null };
  requester: { platform: "discord" | "slack"; userId: string; displayName: string } | null;
}

export interface LaunchContext {
  /** 初回指示へ並べるブロック。 ユースケースが無ければ null。 */
  block: string | null;
  /** ハーネスで編集を止めるか (read-only のユースケース)。 */
  readOnly: boolean;
}

export function buildLaunchContext(ports: LaunchContextPorts, input: LaunchContextInput): LaunchContext {
  // 依頼者は、 ユースケースの有無にかかわらず会社ごとのメモ一覧に載せる (誰が依頼したか分かるように)。
  const requester = input.requester
    ? ports.ensureRequester({
        subsidiary_id: input.department.subsidiary_id,
        platform: input.requester.platform,
        platform_user_id: input.requester.userId,
      }, input.requester.displayName)
    : null;
  const useCase = input.department.use_case_id ? ports.useCase(input.department.use_case_id) : null;
  if (!useCase || useCase.archived_at !== null) return { block: null, readOnly: false };
  const corrections = ports.corrections(useCase.id, input.department.subsidiary_id, MAX_LAUNCH_CORRECTIONS);
  const block = buildDialogueStartupBlock({
    departmentName: input.department.name,
    useCase: {
      name: useCase.name,
      formatName: USE_CASE_FORMATS[useCase.format]?.name ?? useCase.format,
      summary: useCase.summary,
      preData: useCase.pre_data,
    },
    corrections,
    requester: useCase.use_requester_profile === 1 && requester
      ? {
          displayName: requester.display_name,
          skillLevel: requester.skill_level,
          activities: requester.activities,
          notes: requester.notes,
        }
      : null,
  });
  return { block, readOnly: useCase.work_mode === "read-only" };
}
