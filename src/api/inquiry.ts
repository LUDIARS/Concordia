import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import { eventBus } from "../events.js";
import { CatalogGeniusClient, type GeniusClient } from "../inquiry/genius-client.js";
import { decideInquiry, geniusCategories, isInquiryCategory, type InquiryDecision } from "../inquiry/decision.js";
import { resolveSupervisor } from "../inquiry/supervisor.js";
import { ExcubitorClient } from "../excubitor/client.js";
import { allowAutoInject, type PendingQuestionProbe } from "../control/pending-question-blocker.js";

const RequestSchema = z.object({
  session_id: z.string().min(1),
  category: z.string(),
  context: z.string().min(1),
  options: z.array(z.string()).optional(),
});

interface InquiryRecord {
  inquiry_id: string;
  session_id: string;
  category: string;
  context: string;
  options: string[];
  decision: InquiryDecision;
  instruction: string;
  genius_available: boolean;
  genius_cards: unknown[];
  supervisor: ReturnType<typeof resolveSupervisor>;
}

interface InquiryCacheEntry {
  expires: number;
  record: InquiryRecord;
  /** タスク instruction を session へ送信済みか。block 中の再試行判定に使う。 */
  instructionInjected: boolean;
}

/**
 * `GET /v1/inquiry/:id` は監査の即時参照用で、 正本は session_events の
 * `kind: "inquiry"`。 Cc は常駐プロセスなので、 in-memory 側は上限を切って
 * 古いものから捨てる (無制限に貯めるとメモリが単調増加する)。
 */
const MAX_RETAINED_RECORDS = 500;

export function inquiryRouter(deps: {
  sessions: SessionsRepo;
  config: ConcordiaConfig;
  delegation?: DelegationRepo;
  genius?: GeniusClient;
  now?: () => number;
  /** 未回答の質問があるセッションには自動 inject を返さない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
}): Hono {
  const app = new Hono();
  const records = new Map<string, InquiryRecord>();
  const cache = new Map<string, InquiryCacheEntry>();
  const genius = deps.genius ?? new CatalogGeniusClient(new ExcubitorClient());
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const injectTaskInstruction = (record: InquiryRecord): boolean => {
    if (record.category !== "タスク" || !allowAutoInject({
      probe: deps.hasPendingQuestion,
      sessionId: record.session_id,
      source: "auto:inquiry",
    })) return false;
    const ts = now();
    eventBus.emit({
      type: "session.inject",
      target_session_id: record.session_id,
      text: record.instruction,
      source: "auto:inquiry",
      ts,
    });
    deps.sessions.appendEvent({
      session_id: record.session_id,
      ts,
      kind: "inject",
      payload: { text: record.instruction, source: "auto:inquiry" },
    });
    return true;
  };

  app.post("/", async (c) => {
    const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_inquiry" }, 400);
    const category = parsed.data.category;
    if (!isInquiryCategory(category)) return c.json({ error: "invalid_inquiry" }, 400);
    const input = parsed.data;
    const session = deps.sessions.findSession(input.session_id);
    if (!session) return c.json({ error: "not_found" }, 404);

    // 同一 (session, category) の再送はキャッシュで畳む (spec §3)。
    const key = `${input.session_id}:${category}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      // 最初の問い合わせが未回答質問に block された場合、回答後の再送で一度だけ配信する。
      // この判定なしでは cache expiry まで instruction が永久に未送信になる。
      if (!cached.instructionInjected) {
        cached.instructionInjected = injectTaskInstruction(cached.record);
      }
      return c.json(cached.record);
    }

    const cards = await genius.query({
      text: `[${category}] ${input.context}`,
      categories: geniusCategories(category),
      k: 8,
    });
    const available = cards !== null;
    let decision: InquiryDecision = available
      ? decideInquiry(cards, deps.config.inquiryScoreMin)
      : "self_judge";
    // goal-and-go の上限到達後は、 以後のお伺いを ask_human に固定する
    // (spec §8 — 暴走の最終防波堤。 代行で proceed に流さない)。
    if (category === "タスク" && readGoalAndGoStatus(session.metadata).stopped_reason !== null) {
      decision = "ask_human";
    }

    const runId = readRunId(session.metadata);
    const supervisor = resolveSupervisor({
      delegation: deps.delegation,
      delegationRunId: runId,
      defaultSupervisor: deps.config.defaultSupervisor,
    });
    const record: InquiryRecord = {
      inquiry_id: `inq_${randomUUID().replace(/-/g, "")}`,
      session_id: input.session_id,
      category,
      context: input.context,
      options: input.options ?? [],
      decision,
      instruction: instructionFor(decision),
      genius_available: available,
      genius_cards: cards ?? [],
      supervisor,
    };
    records.set(record.inquiry_id, record);
    while (records.size > MAX_RETAINED_RECORDS) {
      const oldest = records.keys().next();
      if (oldest.done) break;
      records.delete(oldest.value);
    }
    const cacheEntry: InquiryCacheEntry = {
      expires: now() + deps.config.inquiryCacheSec,
      record,
      instructionInjected: false,
    };
    cache.set(key, cacheEntry);
    for (const [cacheKey, entry] of cache) {
      if (entry.expires <= now()) cache.delete(cacheKey);
    }
    deps.sessions.appendEvent({
      session_id: input.session_id,
      ts: now(),
      kind: "inquiry",
      payload: record,
    });
    eventBus.emit({
      type: "inquiry.resolved",
      target_session_id: input.session_id,
      decision,
      supervisor_user_id: supervisor?.user_id ?? null,
      category,
      ts: now(),
    });
    // 作業完了時の自動お伺い (spec §6): タスク カテゴリだけは応答の instruction を
    // そのままセッションへ流す。 auto:inquiry は requester inject ではないので
    // idle の clear 契機にならない。
    // 未回答の質問が残っているセッションへは「進め」を返さない。 record は返すので
    // 呼び出し側は判断結果を読めるが、 pty へは流さない (回答するまで止まる)。
    cacheEntry.instructionInjected = injectTaskInstruction(record);
    return c.json(record);
  });

  app.get("/:id", (c) => {
    const record = records.get(c.req.param("id"));
    return record ? c.json(record) : c.json({ error: "not_found" }, 404);
  });
  return app;
}

function readRunId(metadata: string | null): string | null {
  try {
    const parsed = JSON.parse(metadata ?? "{}") as { delegation_run_id?: unknown };
    return typeof parsed.delegation_run_id === "string" ? parsed.delegation_run_id : null;
  } catch {
    return null;
  }
}

function instructionFor(decision: InquiryDecision): string {
  if (decision === "proceed") {
    return "判断代行の前例に従って、残タスクを確認して次の作業を進めてください。";
  }
  if (decision === "ask_human") {
    return "上長の判断を待ってください。";
  }
  return "判断代行 (Genius) が不在または前例不足です。このセッションの通常判断で進めてください。";
}
