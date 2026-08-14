import type { Hono } from "hono";
import { z } from "zod";
import { CONTRACT_FIELDS, parseContractMetadata } from "../../contract/schema.js";
import { patchContractHuman } from "../../contract/store.js";
import type { SessionsApiDeps } from "./deps.js";

const PatchSchema = z.object({ patch: z.record(z.unknown()), rationale: z.string().min(1).max(4000) });
export function registerContractRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.get("/:id/contract", (c) => { const row = deps.repo.findSession(c.req.param("id")); if (!row) return c.json({ error: "not_found" }, 404); return c.json({ contract: parseContractMetadata(row.metadata) }); });
  app.patch("/:id/contract", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    // mode は承認フローつきの専用経路 (POST /:id/contract/mode-switch) のみ。 汎用 patch での
    // 無承認降格 (plan→vibes) を封じる (plan-gate §5: 封鎖を開ける方向は常に人間)。
    if ("mode" in parsed.data.patch) return c.json({ error: "mode_switch_required", detail: "use POST /v1/sessions/:id/contract/mode-switch" }, 400);
    const patch = Object.fromEntries(Object.entries(parsed.data.patch).filter(([field]) => (CONTRACT_FIELDS as string[]).includes(field)));
    try { const contract = patchContractHuman(deps.repo, c.req.param("id"), patch, parsed.data.rationale); return contract ? c.json({ contract }) : c.json({ error: "contract_not_found" }, 404); }
    catch (error) { return c.json({ error: "invalid_contract_patch", detail: (error as Error).message }, 400); }
  });
}
