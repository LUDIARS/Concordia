import type { SessionsRepo } from "../db/sessions-repo.js";
import { fetchFromLictor, resolveLictorTarget } from "../control/lictor-proxy.js";
import type { RuntimeModelReviewApplyResult } from "./contracts.js";

export async function applyRuntimeModelReview(
  sessions: SessionsRepo,
  input: { sessionId: string; model: string; effort: string },
): Promise<RuntimeModelReviewApplyResult> {
  const target = resolveLictorTarget(sessions, input.sessionId);
  if ("error" in target) return { ok: false, message: `切替できません: ${target.error}` };
  try {
    const response = await fetchFromLictor(target.port, "/v1/runtime/model-effort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.model, effort: input.effort }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (!response.ok) {
      return { ok: false, message: body.message ?? body.error ?? `切替に失敗しました (${response.status})` };
    }
    sessions.mergeMetadata(input.sessionId, { model: input.model, effort: input.effort });
    return {
      ok: true,
      message: body.message ?? `model=${input.model}, effort=${input.effort} へ切り替えました。`,
    };
  } catch (error) {
    return { ok: false, message: `Lictorへの切替要求に失敗しました: ${(error as Error).message}` };
  }
}
