import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";
import { answerPendingQuestion, type AnswerQuestionBody } from "../../control/answer-question.js";
import { buildDelegationQuestionRelayText } from "../../delegation/coordination.js";

export function registerQaRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/:id/permission-request", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PermissionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const requester = lastHumanRequester(deps.repo.recentEvents(id, 50));
    eventBus.emit({
      type: "session.permission_request",
      target_session_id: id,
      request_id: parsed.data.request_id,
      tool_name: parsed.data.tool_name,
      tool_input: parsed.data.tool_input,
      requester_platform: requester?.platform,
      requester_user_id: requester?.userId,
      ts: nowSec(),
    });
    return c.json({ ok: true });
  });

app.post("/:id/permission-response", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = PermissionResponseSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return c.json({ error: target.error }, 404);
    let upstream: Response;
    try {
      upstream = await fetchFromLictor(target.port, "/v1/internal/permission-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
    } catch (err) {
      return c.json({ error: `lictor unreachable: ${(err as Error).message}` }, 502);
    }
    const text = await upstream.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return c.json(json as Record<string, unknown>, upstream.status as 200);
  });

app.post("/:id/pending-question", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PendingQuestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = nowSec();
    // 冪等化: 同一 session で同じ question 文の行が既にあれば、 重複投稿せず
    // その question_id をそのまま返す。 AskUserQuestion は picker-open 時 (Lictor の
    // PreToolUse hook) と transcript-tail (回答後) の 2 経路から POST され得るため、
    // 2 度目は Discord カードを増やさず既存に収束させる (resolve は同一 qid で成立)。
    //   - 未回答行: picker が開いている間の再 POST を弾く。
    //   - 最近回答済行: 早期投稿→回答後に transcript-tail が遅れて再 POST してくる
    //     ケースを弾く。 これが無いと「回答したのに未回答カードが新規に生える」事故になる
    //     (回答は既に確定しているのに重複カードのせいで未送信に見える)。
    const existing =
      deps.channelDirectory.findUnansweredByQuestion(id, parsed.data.question) ??
      deps.channelDirectory.findRecentlyAnsweredByQuestion(id, parsed.data.question, ts - 600);
    if (existing) {
      return c.json({ ok: true, question_id: existing.id, ts: existing.ts, deduped: true });
    }
    const row = deps.channelDirectory.insert({
      session_id: id,
      question: parsed.data.question,
      options: parsed.data.options,
      multiSelect: parsed.data.multi_select === true,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "pending_question",
      payload: {
        question_id: row.id,
        question: row.question,
        options: parsed.data.options,
        multi_select: parsed.data.multi_select === true,
      },
    });
    // 委託子セッションなら親 (委託元) を解決する。 子の面が無い/非アクティブでも
    // 質問が「主人不在」で消えないよう、 Discord 面のフォールバック先と親リレーに使う。
    const run = deps.delegation?.findRunByChildSession(id) ?? null;
    const parentSessionId = run?.parent_session_id ?? undefined;
    // 起因者 (直近で指示した人間) を session_events の inject source から後追い解決し、
    // Discord 側で @メンションして気付かせる (複数名同時利用での取りこぼし防止)。
    // 委託子は inject source が delegation:* で人間として解決できないため、 親側の
    // 履歴からもフォールバック解決する (無メンションカードを作らない)。
    const requester = lastHumanRequester(deps.repo.recentEvents(id, 50))
      ?? (parentSessionId ? lastHumanRequester(deps.repo.recentEvents(parentSessionId, 50)) : null);
    eventBus.emit({
      type: "question.posted",
      target_session_id: id,
      question_id: row.id,
      question: row.question,
      options: parsed.data.options,
      multi_select: parsed.data.multi_select === true,
      parent_session_id: parentSessionId,
      delegation_run_id: run?.id,
      requester_platform: requester?.platform,
      requester_user_id: requester?.userId,
      ts,
    });
    // 親セッションへのリレー: 委託元が自分で回答するか、 人間へ ask で引き継ぐ。
    // persona-context の「親に聞け」を実装で裏付ける経路 (これまで API が無かった)。
    if (run?.parent_session_id) {
      const text = buildDelegationQuestionRelayText({
        runId: run.id,
        childSessionId: id,
        questionId: row.id,
        question: row.question,
        options: parsed.data.options.map((o) => (typeof o === "string" ? o : o.label)),
      });
      const source = `delegation:${run.id}:question`;
      deps.repo.appendEvent({ session_id: run.parent_session_id, ts, kind: "inject", payload: { text, source } });
      eventBus.emit({ type: "session.inject", target_session_id: run.parent_session_id, text, source, ts });
    }
    return c.json({ ok: true, question_id: row.id, ts });
  });

app.post("/:id/answer-question", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = AnswerQuestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // 回答確定の実体は control/answer-question.ts (embedded Discord bot と共有)。
    const normalized: AnswerQuestionBody =
      parsed.data.other_text !== undefined
        ? { question_id: parsed.data.question_id, other_text: parsed.data.other_text }
        : parsed.data.answer_indices !== undefined
          ? { question_id: parsed.data.question_id, answer_indices: parsed.data.answer_indices }
          : { question_id: parsed.data.question_id, answer_index: parsed.data.answer_index! };
    const result = answerPendingQuestion(
      { sessions: deps.repo, questions: deps.channelDirectory, now: nowSec },
      id,
      normalized,
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    // 旧「起動時ブランチ選択」の回答処理は廃止 (起動フローはゴール起点に刷新)。
    // 通常の AskUserQuestion 回答として answer_text を返すだけ。
    return c.json({ ok: true, answer_text: result.answer_text });
  });

app.post("/:id/pending-question/:qid/resolve", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const qid = Number(c.req.param("qid"));
    if (!Number.isInteger(qid)) return c.json({ error: "invalid_qid" }, 400);
    const row = deps.channelDirectory.findById(qid);
    if (!row || row.session_id !== id) return c.json({ error: "not_found" }, 404);
    if (row.answered_at !== null) return c.json({ ok: true, already: true });
    deps.channelDirectory.markResolvedLocally(row.id);
    const ts = nowSec();
    eventBus.emit({ type: "question.resolved", target_session_id: id, question_id: row.id, ts });
    deps.repo.appendEvent({ session_id: id, ts, kind: "question_resolved", payload: { question_id: row.id } });
    return c.json({ ok: true });
  });
}
