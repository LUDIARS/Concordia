// @spec ハーネス信頼性の実装境界
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionMessagesRepo } from "../db/session-messages-repo.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { eventBus } from "../events.js";
import { ReliabilityStore } from "../harness/reliability/store.js";
import { ReliabilityHookService } from "../harness/reliability/hook-service.js";
import { PromptAdvisor } from "../harness/reliability/advisor.js";
import { GUIDANCE_REVISION } from "../harness/reliability/guidance.js";
import { redactSecrets } from "../shared/redact-secrets.js";
import { configurationAdvice } from "../harness/reliability/config-advisory.js";
import { readAcceptanceManifest } from "../delegation/acceptance-manifest.js";
import { inspectCodeAcceptance } from "../harness/reliability/code-acceptance.js";
import { contractMetrics } from "../harness/reliability/ontime-metrics.js";

const HookSchema = z.object({
  event: z.enum(["pre-compact", "post-compact", "resume-compact", "tool-result", "prompt"]),
  event_id: z.string().min(1).max(256), trigger: z.string().max(50).optional(),
  tool: z.string().max(256).optional(), failed: z.boolean().optional(), status: z.number().int().optional(),
  code: z.string().max(256).optional(), message: z.string().max(16000).optional(), prompt: z.string().max(16000).optional(),
});

export function harnessReliabilityRouter(deps: {
  repo: SessionsRepo; messages: SessionMessagesRepo; questions: DiscordPendingQuestionsRepo;
  projectCodes: ProjectCodesRepo; chat: ChatRepo; run?: RunClaudeFn;
}): Hono {
  const app = new Hono();
  const store = new ReliabilityStore(deps.repo);
  const notify = (id: string, text: string, commonSystem = false): number => {
    const session = deps.repo.findSession(id);
    if (!session) throw new Error("session not found");
    // The common SYSTEM surface is headquarters-only; do not cross team boundaries.
    if (session.team_id) throw new Error("Scoped advisory delivery is not configured for this team");
    const message = deps.chat.insert({ channel: "system", session_id: commonSystem ? null : id,
      author_label: "Concordia advisory", text, in_reply_to: null, is_actionable: false,
      metadata: JSON.stringify({ kind: "harness_advisory", source_session_id: id, delivery: "unconfirmed" }) });
    eventBus.emit({ type: "chat.posted", message_id: message.id, channel: message.channel,
      session_id: message.session_id, author_label: message.author_label, ts: message.ts, is_actionable: false });
    return message.id;
  };
  const advisor = new PromptAdvisor({ store, now: Date.now,
    run: deps.run ?? (async () => ({ ok: false, stdout: "", stderr: "Classifier unavailable" })),
    notify: (id, text) => notify(id, text, true) });
  const service = new ReliabilityHookService({ sessions: deps.repo, messages: deps.messages, store,
    acceptanceManifest: readAcceptanceManifest,
    pendingQuestions: (id) => deps.questions.listUnanswered(id).map((question) => ({ id: question.id, question: question.question })),
    notify, now: Date.now, random: Math.random,
    assess: (id, sampleId) => { void advisor.assess(id, sampleId).catch(() => {
      // A failed persistence boundary must not become an unhandled rejection.
      console.error("[harness-reliability] advisory persistence failed");
    }); },
  });
  app.use("*", bodyLimit({ maxSize: 65536 }));
  app.use("/:id/*", async (c, next) => {
    if (!deps.repo.findSession(c.req.param("id")!)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  app.get("/:id/status", (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id)!;
    const project = (session.repo_origin ? deps.projectCodes.findByRepoOrigin(session.repo_origin) : null) ?? deps.projectCodes.findByRepoPath(session.repo_path);
    const state = store.read(id);
    const completion = deps.repo.recentEvents(id, 100).find((event) => event.kind === "completion.evidence");
    if (completion) {
      const payload = JSON.parse(completion.payload);
      state.observations.completion = { at: completion.ts * 1000, status: payload.acceptance,
        reason: payload.reason ?? (payload.acceptance === "not_configured" ? "Branch evidence only; no Augur acceptance contract configured" : `Run ${payload.run_id}; checked=${payload.checked}`) };
    }
    return c.json({
      configured: { ddd: project ? !!project.ddd_enabled : null, work_contract: project ? !!project.contract_enabled : null,
        tests_required: project ? !!project.tests_required : null, ontime_tests_required: project ? !!project.ontime_tests_required : null,
        guidance_revision: GUIDANCE_REVISION, classifier: !!deps.run },
      observations: state.observations, mcp: state.mcp,
      ontime: contractMetrics(),
      checkpoint: state.checkpoints.at(-1) ? { id: state.checkpoints.at(-1)!.id, at: state.checkpoints.at(-1)!.at } : null,
      samples: state.samples.map(({ prompt: _prompt, context: _context, user_key: _key, ...sample }) => sample),
      report: state.report ?? null,
      coverage: "未観測は正常を意味しません。MCP監視はクライアントが通知するフック経路のみ。",
    });
  });
  app.get("/:id/checkpoint", (c) => c.json({ checkpoint: store.read(c.req.param("id")).checkpoints.at(-1) ?? null }));
  app.get("/:id/acceptance", async (c) => {
    const session = deps.repo.findSession(c.req.param("id"))!;
    const project = (session.repo_origin ? deps.projectCodes.findByRepoOrigin(session.repo_origin) : null) ?? deps.projectCodes.findByRepoPath(session.repo_path);
    return c.json(await inspectCodeAcceptance(session.repo_path, { ddd: project?.ddd_enabled === 1, contract: project?.contract_enabled === 1,
      testsRequired: project?.tests_required === 1, ontimeTestsRequired: project?.ontime_tests_required === 1 }));
  });
  app.post("/:id/notes", async (c) => {
    const parsed = z.object({ decisions: z.string().max(4000), next_action: z.string().max(2000),
      unresolved: z.string().max(2000), artifacts: z.string().max(2000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_notes" }, 400);
    deps.repo.updateMetadata(c.req.param("id"), (metadata) => ({ ...metadata,
      harness_notes: { ...Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [key, redactSecrets(value)])), at: Date.now() } }));
    return c.json({ ok: true });
  });
  app.post("/:id/config-advisory", async (c) => {
    const parsed = z.object({ provider: z.string().max(40), model: z.string().max(120).optional(), hooks_enabled: z.boolean().optional(),
      hook_trust: z.enum(["trusted", "review_required", "unknown"]).optional(), context_window: z.number().positive().optional(),
      auto_compact_limit: z.number().positive().optional(), hook_events: z.array(z.string().max(60)).max(30).optional(),
      uses_deprecated_codex_hooks: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_configuration_snapshot" }, 400);
    const session = deps.repo.findSession(c.req.param("id"))!;
    if (parsed.data.provider !== session.provider) return c.json({ error: "provider_mismatch" }, 409);
    const advice = configurationAdvice(parsed.data);
    const previous = store.read(session.id).observations.official_config;
    store.update(session.id, (state) => { state.observations.official_config = { at: Date.now(), status: advice.length ? "advisory" : "no_known_mismatch",
      reason: advice.join(" ") || "Only supplied configuration was checked; unreported settings and exact model support remain unknown" }; });
    if (advice.length && previous?.reason !== advice.join(" ")) {
      try { notify(session.id, `公式設定の助言（${GUIDANCE_REVISION}確認）\n${advice.join("\n")}`); }
      catch { store.update(session.id, (state) => { state.observations.notification = { at: Date.now(), status: "failed", reason: "Configuration advisory saved; notification unavailable" }; }); }
    }
    return c.json({ advice, revision: GUIDANCE_REVISION, sources: [session.provider === "claude-code" ? "https://code.claude.com/docs/en/hooks" : "https://learn.chatgpt.com/docs/hooks"] });
  });
  app.post("/:id/hook", async (c) => {
    const parsed = HookSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_hook_event" }, 400);
    try {
      const result = service.handle(c.req.param("id"), parsed.data);
      eventBus.emit({ type: "session.event", session_id: c.req.param("id"), kind: "reliability.observed", ts: Math.floor(Date.now() / 1000) });
      return c.json(result);
    } catch { return c.json({ error: "hook_observation_or_notification_failed" }, 503); }
  });
  app.post("/:id/approach", async (c) => {
    if (deps.repo.findSession(c.req.param("id"))?.team_id) return c.json({ error: "scoped_system_delivery_unavailable" }, 409);
    try { return c.json(await advisor.report(c.req.param("id"))); }
    catch { return c.json({ error: "report_unavailable_or_budget_exhausted", state: store.read(c.req.param("id")).report ?? null }, 409); }
  });
  return app;
}
