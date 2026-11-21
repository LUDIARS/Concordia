/**
 * /v1/control — 管制セッションの API (loopback 認可の内側)。
 *
 * - GET  /v1/control/status        設定・保持者・管制セッションの生死
 * - GET  /v1/control/board         進捗ボード全件
 * - GET  /v1/control/merge-playtest-returns  マージ後の帰還受付履歴
 * - POST /v1/control/instructions  管制セッションからの追加指示
 *
 * @implements spec/feature/control-session.md — API / 6. ON / OFF / CC-CTL-INV-06
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ControlBoardRowWithLink } from "../control-session/session-link.js";
import type { ControlHolder } from "../control-session/holder-store.js";
import type { DispatchResult, InstructionOrigin } from "../control-session/instruction-dispatch.js";
import type { ExternalBridgeReader } from "../control-session/external-bridge-status.js";
import type { MergeReturnRecord } from "../conflux/merge-return-repository.js";

const InstructionSchema = z.object({
  from_session_id: z.string().min(1),
  targets: z.array(z.string().min(1)).min(1).max(50),
  text: z.string().trim().min(1).max(4000),
});

export interface ControlSessionApiDeps {
  isEnabled(): boolean;
  holder(): ControlHolder | null;
  currentControlSessionId(): string | null;
  boardRows(): ControlBoardRowWithLink[];
  externalBridges?: ExternalBridgeReader;
  mergeReturns?: () => (MergeReturnRecord & { build_status: string | null })[];
  dispatch(input: { targets: string[]; text: string; origin: InstructionOrigin }): Promise<DispatchResult>;
}

export function controlSessionRouter(deps: ControlSessionApiDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const holder = deps.holder();
    return c.json({
      enabled: deps.isEnabled(),
      generation: holder?.generation ?? null,
      spawned_at: holder?.spawned_at ?? null,
      control_session_id: deps.isEnabled() ? deps.currentControlSessionId() : null,
    });
  });

  app.get("/board", (c) => {
    if (!deps.isEnabled()) return c.json({ error: "control_disabled" }, 409);
    return c.json({ items: deps.boardRows(), external_bridges: deps.externalBridges?.() ?? [] });
  });

  app.get("/merge-playtest-returns", (c) => c.json({ items: deps.mergeReturns?.() ?? [] }));

  app.post("/instructions", async (c) => {
    if (!deps.isEnabled()) return c.json({ error: "control_disabled" }, 409);
    const parsed = InstructionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", detail: parsed.error.issues.map((i) => i.message) }, 400);
    const controlId = deps.currentControlSessionId();
    const holder = deps.holder();
    // 追加指示は現在の管制セッションからだけ受け付ける (CC-CTL-INV-06)。
    if (!controlId || !holder || parsed.data.from_session_id !== controlId) {
      return c.json({ error: "not_control_session" }, 403);
    }
    const result = await deps.dispatch({
      targets: parsed.data.targets.filter((id) => id !== controlId),
      text: parsed.data.text,
      origin: { kind: "control", generation: holder.generation },
    });
    return c.json(result);
  });

  return app;
}
