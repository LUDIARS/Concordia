import type { Hono } from "hono";
import { z } from "zod";
import { CONTRACT_FIELDS, parseContractMetadata } from "../../contract/schema.js";
import { patchContractHuman } from "../../contract/store.js";
import type { SessionsApiDeps } from "./deps.js";
import { changeSessionEffort } from "../../contract/effort-change.js";
import { applyRuntimeModelReview } from "../../model-review/runtime-switch.js";
import { eventBus } from "../../events.js";

const PatchSchema = z.object({ patch: z.record(z.unknown()), rationale: z.string().min(1).max(4000) });
const EffortSchema = z.object({
  effort: z.string().trim().min(1).max(16),
  actor: z.enum(["human", "session"]),
  reason: z.string().trim().min(1).max(1000),
  requested_by: z.string().trim().max(200).nullable().optional(),
}).strict();

/** 変更通知はセッションの Discord スレッドへ (session_id 付き system 投稿は egress がスレッドへ送る)。 */
function notifySessionThread(deps: SessionsApiDeps, input: { sessionId: string; text: string }): void {
  const message = deps.chat.insert({
    channel: "system", session_id: input.sessionId, author_label: "Concordia effort",
    text: input.text, in_reply_to: null, is_actionable: false,
  });
  eventBus.emit({ type: "chat.posted", message_id: message.id, channel: message.channel,
    session_id: message.session_id, author_label: message.author_label, ts: message.ts, is_actionable: false });
}

export function registerContractRoutes(app: Hono, deps: SessionsApiDeps): void {
  // effort の途中変更 (spec/feature/effort-movable.md)。 人間とセッション自身の両方が使う。
  app.post("/:id/effort", async (c) => {
    const parsed = EffortSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const result = await changeSessionEffort({
      sessions: deps.repo,
      apply: deps.applyModelEffort ?? ((input) => applyRuntimeModelReview(deps.repo, input)),
      notify: (input) => notifySessionThread(deps, input),
    }, {
      sessionId: c.req.param("id"),
      effort: parsed.data.effort,
      actor: parsed.data.actor,
      reason: parsed.data.reason,
      requestedBy: parsed.data.requested_by ?? null,
    });
    if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
    return c.json(result);
  });
  app.get("/:id/contract", (c) => { const row = deps.repo.findSession(c.req.param("id")); if (!row) return c.json({ error: "not_found" }, 404); return c.json({ contract: parseContractMetadata(row.metadata) }); });
  app.patch("/:id/contract", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const patch = Object.fromEntries(Object.entries(parsed.data.patch).filter(([field]) => (CONTRACT_FIELDS as string[]).includes(field)));
    try { const contract = patchContractHuman(deps.repo, c.req.param("id"), patch, parsed.data.rationale); return contract ? c.json({ contract }) : c.json({ error: "contract_not_found" }, 404); }
    catch (error) { return c.json({ error: "invalid_contract_patch", detail: (error as Error).message }, 400); }
  });
}
