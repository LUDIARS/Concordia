import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, SESSION_END_DONE_TIMEOUT_MS, pendingSessionEndExits, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";
import { readGoalAndGoStatus, setGoalAndGoEnabled } from "../../control/goal-and-go.js";

export function registerTitleGoalRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/:id/impl-unlock", (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    deps.repo.mergeMetadata(id, { impl_unlocked: true });
    return c.json({ ok: true, session_id: id, impl_unlocked: true });
  });
  app.post("/:id/title", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = TitleSetSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const now = nowSec();
    // current_task も更新する。 Discord は title_renamed の payload からタイトルを読むが、
    // Slack ライブカードは session.current_task を読むため、 ここを書かないと rename が
    // Slack カードに反映されない (📌 がセッション id 先頭8桁のまま固まる)。
    deps.repo.patchSession(id, { current_task: parsed.data.text.slice(0, 200) });
    deps.repo.appendEvent({ session_id: id, ts: now, kind: "title_renamed", payload: { text: parsed.data.text } });
    eventBus.emit({ type: "session.event", session_id: id, kind: "title_renamed", ts: now });
    return c.json({ ok: true, ts: now });
  });

app.post("/:id/title-suggestion", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = TitleSuggestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return c.json({ error: target.error }, 404);
    let upstream: Response;
    try {
      upstream = await fetchFromLictor(target.port, "/v1/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: parsed.data.text }),
      });
    } catch (err) {
      return c.json({ error: `lictor unreachable: ${(err as Error).message}` }, 502);
    }
    // 応答済 title-suggest を retry 対象から外す.
    deps.tasks.markResponded(id, ["title-suggest"]);
    const now = nowSec();
    deps.repo.appendEvent({
      session_id: id,
      ts: now,
      kind: "title_renamed",
      // source: "title-suggestion" を付与し、Discord bot 側でチャンネル名リネームを抑制する。
      // AI の自動タイトル提案はチャンネル名に反映せず topic のみ更新する。
      payload: { text: parsed.data.text, source: "title-suggestion" },
    });
    eventBus.emit({ type: "session.event", session_id: id, kind: "title_renamed", ts: now });
    const text = await upstream.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return c.json(
      { ok: upstream.ok, lictor: json as Record<string, unknown> },
      upstream.status as 200,
    );
  });

app.get("/:id/goal", (c) => {
    const s = deps.repo.findSession(c.req.param("id"));
    if (!s) return c.json({ error: "not_found" }, 404);
    return c.json({ goal: readGoalFromMetadata(s.metadata) });
  });

app.post("/:id/goal", async (c) => {
    const id = c.req.param("id");
    const s = deps.repo.findSession(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = GoalSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const goal = parseGoalInput({ mode: parsed.data.mode, text: parsed.data.text });
    deps.repo.setMetadata(id, mergeGoalIntoMetadata(s.metadata, goal));
    deps.repo.appendEvent({ session_id: id, ts: nowSec(), kind: "goal", payload: { goal } });
    return c.json({ ok: true, goal });
  });

app.get("/:id/goal-and-go", (c) => {
    const session = deps.repo.findSession(c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    return c.json({ goal_and_go: readGoalAndGoStatus(session.metadata) });
  });

app.post("/:id/goal-and-go", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    const metadata = setGoalAndGoEnabled(session.metadata, body.enabled);
    deps.repo.setMetadata(id, metadata);
    const status = readGoalAndGoStatus(metadata);
    deps.repo.appendEvent({
      session_id: id,
      ts: nowSec(),
      kind: "goal_and_go",
      payload: { enabled: status.enabled },
    });
    return c.json({ ok: true, goal_and_go: status });
  });
}
