/**
 * 部署で起動するセッションへ渡す「対話の前提データ」を用意するユースケース (application)。
 *
 * 順序: 部署のユースケースを引く → 同じ会社の有効な訂正を新しい順に引く →
 * (使う設定なら) 依頼者メモを引き、 未登録なら空のメモ行を作る → (事前ヒアリングを使う
 * 設定で 4 項目が揃っていれば) 技術レベル・役職を依頼者メモの既定値として保存し、
 * ヒアリングを記録する → ブロックを組み立てる。
 * 依頼者メモとヒアリングの中身はここで返すブロックにだけ入れ、 ログへは出さない
 * (CC-DLG-INV-04 / CC-CONSULT-INV-05)。
 *
 * @implements spec/feature/dialogue-context.md §5 / §7
 * @implements SPEC-DLG-STARTUP
 * @implements SPEC-DLG-PROFILES
 * @implements SPEC-CONSULT-INTAKE
 */

import type { ConsultationIntakeInput, ConsultIntakeSource } from "../db/consultation-intakes-repo.js";
import type { CorrectionRow } from "../db/use-case-corrections-repo.js";
import type { RequesterIdentity, RequesterProfileFields, RequesterProfileRow } from "../db/requester-profiles-repo.js";
import type { UseCaseRow } from "../db/use-cases-repo.js";
import { USE_CASE_FORMATS } from "./formats.js";
import { isConsultIntakeComplete, type ConsultIntake } from "./intake.js";
import { buildDialogueStartupBlock, MAX_LAUNCH_CORRECTIONS } from "./startup-block.js";

export interface LaunchContextPorts {
  useCase(id: string): UseCaseRow | null;
  corrections(useCaseId: string, subsidiaryId: string | null, limit: number): CorrectionRow[];
  ensureRequester(identity: RequesterIdentity, displayName: string): RequesterProfileRow;
  /** 事前ヒアリングの技術レベル・役職を依頼者メモの既定値として保存する (tech-consultation.md §3)。 */
  saveRequesterDefaults?(identity: RequesterIdentity, fields: Pick<RequesterProfileFields, "skill_level" | "role_title">): void;
  /** 相談ごとのヒアリングを記録する。 */
  recordIntake?(input: ConsultationIntakeInput): void;
}

export interface LaunchContextInput {
  department: { id?: string; name: string; subsidiary_id: string | null; use_case_id: string | null };
  requester: { platform: "discord" | "slack"; userId: string; displayName: string } | null;
  /** 受付で揃えた事前ヒアリング。 ユースケースが使わない設定なら無視する。 */
  intake?: { values: ConsultIntake; source: ConsultIntakeSource; channelId: string | null } | null;
}

export interface LaunchContext {
  /** 初回指示へ並べるブロック。 ユースケースが無ければ null。 */
  block: string | null;
  /** ハーネスで編集を止めるか (read-only のユースケース)。 */
  readOnly: boolean;
}

export function buildLaunchContext(ports: LaunchContextPorts, input: LaunchContextInput): LaunchContext {
  // 依頼者は、 ユースケースの有無にかかわらず会社ごとのメモ一覧に載せる (誰が依頼したか分かるように)。
  const identity: RequesterIdentity | null = input.requester
    ? {
        subsidiary_id: input.department.subsidiary_id,
        platform: input.requester.platform,
        platform_user_id: input.requester.userId,
      }
    : null;
  let requester = identity && input.requester ? ports.ensureRequester(identity, input.requester.displayName) : null;
  const useCase = input.department.use_case_id ? ports.useCase(input.department.use_case_id) : null;
  if (!useCase || useCase.archived_at !== null) return { block: null, readOnly: false };

  const intake = useCase.intake_enabled === 1 && input.intake && isConsultIntakeComplete(input.intake.values)
    ? input.intake
    : null;
  if (intake && identity) {
    const defaults = nonEmpty({ skill_level: intake.values.skill_level, role_title: intake.values.role_title });
    if (Object.keys(defaults).length > 0) ports.saveRequesterDefaults?.(identity, defaults);
    if (input.department.id) {
      ports.recordIntake?.({
        ...intake.values,
        subsidiary_id: identity.subsidiary_id,
        department_id: input.department.id,
        use_case_id: useCase.id,
        platform: identity.platform,
        platform_user_id: identity.platform_user_id,
        channel_id: intake.channelId,
        source: intake.source,
      });
    }
    // 保存直後の値でブロックを組む (技術レベルが依頼者メモ側にも並ぶため)。
    requester = requester && input.requester ? ports.ensureRequester(identity, input.requester.displayName) : requester;
  }

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
    intake: intake?.values ?? null,
  });
  return { block, readOnly: useCase.work_mode === "read-only" };
}

function nonEmpty<T extends Record<string, string>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim())) as Partial<T>;
}
