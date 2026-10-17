/**
 * `/consult` コマンドの依存 (spec/feature/tech-consultation.md §4)。
 *
 * `command-port.ts` (コマンド依存の束) がこの型を持ち、 `consult.ts` が `command-port.ts` の
 * コマンド型を使うので、 型を `consult.ts` に置くと循環する。 依存だけをここへ分け、
 * `consult.ts` からも再エクスポートする。
 */
import type { ConsultIntakeDefaults } from "../../dialogue/intake.js";
import type { ConsultFlowDeps } from "../consult-flow.js";
import type { ConsultDriveDeps } from "../consult-drive.js";

export interface ConsultCommandDeps extends ConsultFlowDeps {
  /** この Bot の会社でプライベート相談を受け付ける稼働中の部署 (補完用)。 */
  privateDepartments(): ReadonlyArray<{ id: string; name: string }>;
  /** モーダルの既定値 (依頼者メモの技術レベル・役職)。 */
  requesterDefaults(userId: string): ConsultIntakeDefaults | null;
  /** ファイル受け渡し (tech-consultation.md §6.4)。 未配線なら使えないと返す。 */
  drive?: ConsultDriveDeps;
}
