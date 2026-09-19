import { Hono } from "hono";
import { z } from "zod";
import type { ImplementationToolsService } from "../implementation-tools/service.js";

const SessionSchema = z.object({ session_id: z.string().min(1) });
const ReviewSchema = SessionSchema.extend({ fast_lane: z.boolean().optional() });
const CommitSchema = SessionSchema.extend({
  message: z.string().min(1).max(8_000),
  paths: z.array(z.string().min(1)).max(200).optional(),
});
const BindSchema = SessionSchema.extend({ cwd: z.string().min(1), task: z.string().min(1).max(1_000) });
const ServiceSchema = SessionSchema.extend({
  service_code: z.string().min(1).max(64),
  action: z.enum(["start", "stop", "restart"]),
  note: z.string().max(500).optional(),
});

export function implementationToolsRouter(deps: { tools: ImplementationToolsService; requestPolicyRefresh: (id: string) => void }): Hono {
  const app = new Hono();
  app.post("/bind", async (c) => {
    const parsed = BindSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      const result = await deps.tools.bind({
        sessionId: parsed.data.session_id,
        cwd: parsed.data.cwd,
        task: parsed.data.task,
      });
      deps.requestPolicyRefresh(parsed.data.session_id);
      return c.json(result);
    } catch {
      return c.json({ error: "implementation_bind_failed" }, 409);
    }
  });
  app.post("/service", async (c) => {
    const parsed = ServiceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      return c.json(await deps.tools.controlService({
        sessionId: parsed.data.session_id,
        serviceCode: parsed.data.service_code,
        action: parsed.data.action,
        note: parsed.data.note,
      }));
    } catch {
      return c.json({ error: "implementation_service_failed" }, 409);
    }
  });
  app.post("/review", async (c) => {
    const parsed = ReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      const result = await deps.tools.submitReview(parsed.data.session_id, {
        fastLane: parsed.data.fast_lane === true,
      });
      if (!result.submitted && !("resubmitted" in result) && result.reason === "error") {
        return c.json({ submitted: false, reason: "error" });
      }
      return c.json(result);
    } catch {
      return c.json({ error: "implementation_review_failed" }, 409);
    }
  });
  // 作業範囲のコミット。 判定は委託 run と同じ guard (spec/feature/work-submission.md §4)。
  app.post("/commit", async (c) => {
    const parsed = CommitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      const result = await deps.tools.commitWork({
        sessionId: parsed.data.session_id,
        message: parsed.data.message,
        ...(parsed.data.paths ? { paths: parsed.data.paths } : {}),
      });
      return c.json(result, result.ok ? 200 : 409);
    } catch {
      return c.json({ error: "implementation_commit_failed" }, 409);
    }
  });
  // 経路に沿った提出。 経路の判定は submission-route.ts の 1 箇所だけが持つ。
  app.post("/submit", async (c) => {
    const parsed = ReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      return c.json(await deps.tools.submitWork(parsed.data.session_id, {
        fastLane: parsed.data.fast_lane === true,
      }));
    } catch {
      return c.json({ error: "implementation_submit_failed" }, 409);
    }
  });
  // フックと外部ツール向けの読み取り。 session id を要らない。
  app.get("/submission-route", (c) => {
    const repo = c.req.query("repo")?.trim();
    if (!repo) return c.json({ error: "repo_required" }, 400);
    return c.json(deps.tools.routeForRepo(repo));
  });

  return app;
}
