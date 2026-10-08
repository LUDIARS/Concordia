/** Consultation command input port; independent of command registration. */
import type { ConsultFlowDeps } from "./consult-flow.js";
import type { ConsultIntakeDefaults } from "../dialogue/intake.js";
export interface ConsultCommandDeps extends ConsultFlowDeps {
  /** この Bot の会社でプライベート相談を受け付ける稼働中の部署 (補完用)。 */
  privateDepartments(): ReadonlyArray<{ id: string; name: string }>;
  /** モーダルの既定値 (依頼者メモの技術レベル・役職)。 */
  requesterDefaults(userId: string): ConsultIntakeDefaults | null;
}
