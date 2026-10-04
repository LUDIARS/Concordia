/**
 * Discord の `/bug` を Cc の受付 API へつなぐ adapter (spec/feature/bug-bounty.md §3 §4)。
 *
 * 報告・公開名・取り下げはどれも Cc の API (`/v1/bounty/...`) を通す。 Bot は台帳を直接書かない
 * (状態の所有者は受付 use case)。 操作者は Discord のユーザー id と、 この Bot の会社で渡す。
 * API の応答の形はここで確かめ、 読めない応答を成功として扱わない。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-REPORTER
 */

import { bountyProjectsInScope, type BountyProject } from "../bounty/project-scope.js";
import type { BountyApiResult, BountyFlowDeps, BountyReceiptView } from "./bounty-flow.js";

export interface BountyWiringDeps {
  /** この Bot (論理 runtime) の会社。 本社なら null。 */
  runtimeSubsidiaryId: string | null;
  /** Cc の API を呼ぶ (callConcordia)。 失敗は `{ error }` を返す。 */
  callConcordia(method: "POST", path: string, body: unknown): Promise<unknown>;
  registeredProjects(): ReadonlyArray<BountyProject>;
  /** この会社の関係プロジェクト。 本社は null (制限なし)。 */
  companyProjects(): readonly string[] | null;
  publicNameOf(userId: string): string | null;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

const UNREADABLE_RESPONSE = "unreadable_response";

export function createBountyFlowDeps(deps: BountyWiringDeps): BountyFlowDeps {
  const actor = (userId: string) => ({ user_id: userId, subsidiary_id: deps.runtimeSubsidiaryId });
  return {
    runtimeSubsidiaryId: deps.runtimeSubsidiaryId,
    submit: async ({ clientKey, userId, guildId, channelId, values }) => {
      const result = await deps.callConcordia("POST", "/v1/bounty/reports", {
        platform: "discord",
        actor: actor(userId),
        client_key: clientKey,
        project: values.project ? values.project : null,
        what_happened: values.what_happened,
        repro_steps: values.repro_steps,
        // 空は「今の設定のまま」。 匿名へ戻すのは `/bug name`。
        ...(values.public_name ? { public_name: values.public_name } : {}),
        reply_to: { ...(guildId ? { guild_id: guildId } : {}), ...(channelId ? { channel_id: channelId } : {}) },
      });
      const receipt = readReceipt(result);
      if (!receipt.ok) return receipt;
      return { ok: true, receipt: receipt.receipt, created: (result as { created?: unknown }).created === true };
    },
    setPublicName: async ({ userId, publicName }) => {
      const result = await deps.callConcordia("POST", "/v1/bounty/reporters/public-name", {
        platform: "discord",
        actor: actor(userId),
        public_name: publicName,
      });
      const failure = readError(result);
      if (failure) return { ok: false, error: failure };
      const display = (result as { display?: unknown }).display;
      return typeof display === "string" ? { ok: true, display } : { ok: false, error: UNREADABLE_RESPONSE };
    },
    withdraw: async ({ reportId, userId }) => {
      const result = await deps.callConcordia("POST", `/v1/bounty/reports/${encodeURIComponent(reportId)}/withdraw`, {
        platform: "discord",
        actor: actor(userId),
      });
      return readReceipt(result);
    },
    projects: () => bountyProjectsInScope(deps.registeredProjects(), deps.companyProjects()),
    currentPublicName: (userId) => deps.publicNameOf(userId),
    log: deps.log,
  };
}

function readError(result: unknown): string | null {
  if (!result || typeof result !== "object") return UNREADABLE_RESPONSE;
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function readReceipt(result: unknown): BountyApiResult<{ receipt: BountyReceiptView }> {
  const failure = readError(result);
  if (failure) return { ok: false, error: failure };
  const body = result as Partial<BountyReceiptView>;
  if (typeof body.report_id !== "string" || typeof body.status !== "string" || typeof body.reporter !== "string") {
    return { ok: false, error: UNREADABLE_RESPONSE };
  }
  return {
    ok: true,
    receipt: {
      report_id: body.report_id,
      status: body.status,
      project: typeof body.project === "string" ? body.project : null,
      missing: Array.isArray(body.missing) ? body.missing.filter((item): item is string => typeof item === "string") : [],
      reporter: body.reporter,
      has_recipient: body.has_recipient === true,
    },
  };
}
