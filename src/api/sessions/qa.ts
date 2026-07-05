import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, SESSION_END_DONE_TIMEOUT_MS, pendingSessionEndExits, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, serializePersonaForResponse, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";

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
    // 起因者 (直近で指示した人間) を session_events の inject source から後追い解決し、
    // Discord 側で @メンションして気付かせる (複数名同時利用での取りこぼし防止)。
    const requester = lastHumanRequester(deps.repo.recentEvents(id, 50));
    eventBus.emit({
      type: "question.posted",
      target_session_id: id,
      question_id: row.id,
      question: row.question,
      options: parsed.data.options,
      multi_select: parsed.data.multi_select === true,
      requester_platform: requester?.platform,
      requester_user_id: requester?.userId,
      ts,
    });
    return c.json({ ok: true, question_id: row.id, ts });
  });

app.post("/:id/answer-question", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = AnswerQuestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const row = deps.channelDirectory.findById(parsed.data.question_id);
    if (!row || row.session_id !== id) return c.json({ error: "not_found" }, 404);
    if (row.answered_at !== null) return c.json({ error: "already_answered" }, 409);
    const options = row.options;

    // 回答 3 形態を answer_text に正規化する (Lictor はこの text をそのまま pty へ注入):
    //   - other_text : 自由文をそのまま
    //   - answer_indices : 各 label を ", " 結合 (複数選択)
    //   - answer_index : 単一 label
    let answerText: string;
    let answerIndex = -1; // picker fallback 用 (Other は -1)
    if (parsed.data.other_text !== undefined) {
      answerText = parsed.data.other_text;
      deps.channelDirectory.markAnsweredOther(row.id, answerText);
    } else if (parsed.data.answer_indices !== undefined) {
      const idxs = parsed.data.answer_indices;
      const labels = idxs.map((i) => options[i]?.label);
      if (labels.some((l) => !l)) return c.json({ error: "answer_index_out_of_range" }, 400);
      answerText = labels.join(", ");
      answerIndex = idxs[0];
      deps.channelDirectory.markAnsweredMulti(row.id, idxs, answerText);
    } else {
      const single = parsed.data.answer_index!;
      const label = options[single]?.label;
      if (!label) return c.json({ error: "answer_index_out_of_range" }, 400);
      answerText = label;
      answerIndex = single;
      deps.channelDirectory.markAnswered(row.id, single, answerText);
    }

    const ts = nowSec();
    eventBus.emit({
      type: "question.answered",
      target_session_id: id,
      question_id: row.id,
      answer_index: answerIndex,
      answer_text: answerText,
      ts,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "question_answered",
      payload: { question_id: row.id, answer_index: answerIndex, answer_text: answerText },
    });
    // 旧「起動時ブランチ選択」の回答処理は廃止 (起動フローはゴール起点に刷新)。
    // 通常の AskUserQuestion 回答として answer_text を返すだけ。
    return c.json({ ok: true, answer_text: answerText });
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
