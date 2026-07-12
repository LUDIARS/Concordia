import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, SESSION_END_DONE_TIMEOUT_MS, pendingSessionEndExits, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, serializePersonaForResponse, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";

export function registerRelayRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/:id/transcript-frame", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = TranscriptFrameSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = nowSec();
    if (session.status === "active") deps.repo.updateHeartbeat(id, ts);
    const discordRow = deps.channelDirectory.findSessionChannel(id);
    const activeRelayTarget = session.status === "active" && discordRow?.status === "active";

    // 永続化: 失敗してもログ流通は止めず、 続けて WS broadcast に進む
    // (永続化失敗は dispatcher / 監視への副作用が無いため安全)
    let persisted = false;
    try {
      persisted = deps.transcriptLogs.insert({
        session_id: id,
        seq: parsed.data.seq,
        ts,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
      });
    } catch (err) {
      log.warn(
        { session_id: id, seq: parsed.data.seq, err: (err as Error).message },
        "transcript_logs insert failed; falling back to WS-only broadcast",
      );
    }

    // ユーザ指示テキスト (kind="text" + payload.role="user") を構造化ログに残す.
    // Lictor → Concordia 転送経路の「いま何を頼まれて動いているか」 を後追いできるようにする目的.
    if (!activeRelayTarget) {
      logInactiveTranscriptPost(id, parsed.data.seq, parsed.data.kind, {
        sessionStatus: session.status,
        discordStatus: discordRow?.status ?? null,
        persisted,
      });
      return c.json({ ok: true, persisted, inactive: true });
    }

    if (parsed.data.kind === "text") {
      const p = parsed.data.payload as { role?: unknown; text?: unknown } | null;
      if (p && p.role === "user" && typeof p.text === "string") {
        const fullLen = p.text.length;
        const preview = p.text.length > PROMPT_LOG_PREVIEW_CHARS
          ? p.text.slice(0, PROMPT_LOG_PREVIEW_CHARS) + "…"
          : p.text;
        log.info(
          { session_id: id, seq: parsed.data.seq, length: fullLen, text: preview },
          "user prompt forwarded via transcript",
        );
      }
    }
    eventBus.emit({
      type: "transcript.frame",
      target_session_id: id,
      seq: parsed.data.seq,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
      ts,
    });
    return c.json({ ok: true, persisted });
  });

app.get("/:id/discord-channels", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const row = deps.channelDirectory.findSessionChannel(id);
    const meta = deps.channelDirectory.listMetaChannels();
    return c.json({
      ok: true,
      session_channel_id: row?.channel_id ?? null,
      session_channel_status: row?.status ?? null,
      meta_channels: meta,
    });
  });

app.get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    const q = c.req.query();
    const sinceId = q.since_id ? Number(q.since_id) : undefined;
    const hasSince = Number.isFinite(sinceId);
    const total = deps.transcriptLogs.countBySession(id);
    if (!deps.repo.findSession(id) && total === 0) {
      return c.json({ error: "not_found" }, 404);
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    // tail は opt-in. 数千 frame あるセッションを開いたとき先頭(起動直後の raw)ではなく
    // 直近を見せたい viewer が ?tail=1 を付ける. since_id 指定時は前方ページングなので無効.
    const tail = !hasSince && (q.tail === "1" || q.tail === "true");
    const entries = deps.transcriptLogs.listBySession(id, {
      since_id: hasSince ? sinceId : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      tail,
    });
    return c.json({
      session_id: id,
      total,
      entries,
      // 連続 pull したい client 向けに、 次回 since_id に使える highest id を返す.
      next_since_id: entries.length > 0 ? entries[entries.length - 1].id : sinceId ?? 0,
    });
  });

app.get("/:id/fs/read", async (c) => {
    const target = resolveLictorTarget(deps.repo, c.req.param("id"));
    if ("error" in target) return c.json({ error: target.error }, 404);
    return proxyGet(c, target.port, `/v1/fs/read?${c.req.url.split("?")[1] ?? ""}`);
  });

app.get("/:id/fs/list", async (c) => {
    const target = resolveLictorTarget(deps.repo, c.req.param("id"));
    if ("error" in target) return c.json({ error: target.error }, 404);
    return proxyGet(c, target.port, `/v1/fs/list?${c.req.url.split("?")[1] ?? ""}`);
  });

app.get("/:id/fs/grep", async (c) => {
    const target = resolveLictorTarget(deps.repo, c.req.param("id"));
    if ("error" in target) return c.json({ error: target.error }, 404);
    return proxyGet(c, target.port, `/v1/fs/grep?${c.req.url.split("?")[1] ?? ""}`);
  });

app.post("/:id/inject", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = InjectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = nowSec();
    const src = parsed.data.source ?? null;
    // 人間メッセージ (source="discord:<uid>:…" / "slack:<uid>:…") なら入力者を
    // participants レジストリに登録し、発言者名を session.inject に載せて
    // 相手プラットフォームのミラーで「誰の発言か」を出せるようにする。
    // /enter 等の制御 inject (source 例 "discord-enter") はコロン区切りでないため除外。
    let authorLabel: string | null = null;
    // 複数名同時利用に備え、人間 inject は本文に「誰の指示か」を前置して AI に起因者を
    // 明示する。AskUserQuestion の @メンションは後追いで source(=uid 埋め込み) を読む。
    let injectText = parsed.data.text;
    const sourceInfo = parseInjectSource(src);
    if (sourceInfo.platform && sourceInfo.userId && parsed.data.author_label) {
      const row = deps.participants.upsert({
        platform: sourceInfo.platform,
        platform_user_id: sourceInfo.userId,
        display_name: parsed.data.author_label,
      });
      authorLabel = row.display_name;
      injectText = prefixRequesterTag(authorLabel, parsed.data.text);
    }
    eventBus.emit({
      type: "session.inject",
      target_session_id: id,
      text: injectText,
      source: src,
      author_label: authorLabel,
      ts,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "inject",
      payload: { text: injectText, source: src },
    });
    return c.json({ ok: true, ts });
  });
}
