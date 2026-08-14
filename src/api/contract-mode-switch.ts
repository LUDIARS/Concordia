/**
 * /v1/sessions/:id/contract/mode-switch — vibes ↔ plan の契約モード切替 API。
 *
 * - target=plan (昇格): 封鎖を閉じる方向なので即時適用 (human tier で記録)。
 * - target=vibes (降格): 封鎖を開ける方向は常に人間 — ここでは承認カードを投稿する
 *   だけで契約は変更しない。 実際の切替は人間の承認回答 (startModeSwitchAnswers) が行う。
 *
 * 汎用 PATCH /v1/sessions/:id/contract は mode を受け付けない (mode_switch_required)。
 * spec/feature/plan-gate.md §5。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { promoteContractToPlan, requestContractDemotion } from "../contract/mode-switch.js";
import type { TeamContractSettings } from "../contract/seed-rules.js";

const BodySchema = z.object({
  target: z.enum(["plan", "vibes"]),
  rationale: z.string().min(1).max(4000),
});

export interface ContractModeSwitchDeps {
  sessions: SessionsRepo;
  questions: DiscordPendingQuestionsRepo;
  claims?: TestingClaimsRepo;
  resolveTeamSettings?: (teamId: string) => TeamContractSettings | null;
}

export function contractModeSwitchRouter(deps: ContractModeSwitchDeps): Hono {
  const app = new Hono();
  app.post("/:id/contract/mode-switch", async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const sessionId = c.req.param("id");
    if (parsed.data.target === "plan") {
      const contract = promoteContractToPlan(deps, sessionId, parsed.data.rationale);
      return contract ? c.json({ contract }) : c.json({ error: "contract_not_found" }, 404);
    }
    // 降格は承認カード経由のみ。 承認なしで契約を書き換える経路はここに存在しない。
    const result = requestContractDemotion(deps, sessionId, parsed.data.rationale);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 409;
      return c.json({ error: result.error }, status);
    }
    return c.json({ pending: true, question_id: result.question_id }, 202);
  });
  return app;
}
