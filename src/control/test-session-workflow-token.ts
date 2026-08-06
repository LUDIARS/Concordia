/** Test Forum session にだけ Revisor workflow token を委譲する spawn 境界。 */
import type { RevisorConfigRepo } from "../db/revisor-config-repo.js";
import { resolveRevisorWorkflowToken } from "../pr/revisor-config.js";
import type { SecretBox } from "../shared/secret-box.js";

export const TEST_SESSION_REVISOR_TOKEN_ENV = "CONCORDIA_REVISOR_WORKFLOW_TOKEN";

export type TestSessionWorkflowEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string };

/**
 * 通常 session には秘密を増やさず、test_surface_id 付き spawn だけへ token を渡す。
 * 値は呼び出しごとに DB 優先で解決するため、設定画面からの更新に再起動は不要。
 */
export function resolveTestSessionWorkflowEnv(
  testSurfaceId: number | null,
  config: RevisorConfigRepo | undefined,
  secretBox: SecretBox | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): TestSessionWorkflowEnvResult {
  if (testSurfaceId === null) return { ok: true, env: {} };
  if (!config || !secretBox) {
    return { ok: false, error: "Revisor workflow token storage is unavailable" };
  }
  const token = resolveRevisorWorkflowToken(config, secretBox, processEnv);
  if (!token) {
    return { ok: false, error: "Revisor workflow token is not configured" };
  }
  return { ok: true, env: { [TEST_SESSION_REVISOR_TOKEN_ENV]: token } };
}
