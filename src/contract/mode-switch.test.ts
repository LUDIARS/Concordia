import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";
import { ensureSessionContract } from "./lifecycle.js";
import {
  DEMOTION_QUESTION_PREFIX,
  VIBES_PROMOTION_QUESTION,
  VIBES_PROMOTION_OPTIONS,
  promoteContractToPlan,
  requestContractDemotion,
  startModeSwitchAnswers,
} from "./mode-switch.js";
import { parseContractMetadata, type SessionContract } from "./schema.js";

function contractWith(mode: "plan" | "vibes", service: string | null = null): SessionContract {
  const human = <T>(value: T) => ({ value, decided_by: "human" as const, rationale: "test", genius_card_ids: [] });
  return {
    version: 1,
    mode: human(mode),
    team: human(null),
    model: human("codex-cli"),
    effort: human("medium"),
    work_branch: human("feat/x"),
    work_location: human(mode === "vibes" ? "repo-root" : "worktree"),
    scope_dirs: human(["src"]),
    acceptance: human(mode === "vibes" ? "human-ok" : "plan"),
    goal_and_go: human({ enabled: false }),
    continuation: human("requeue"),
    testing_claim: human({ required: mode === "vibes", service }),
    supervisor: human("discord:1"),
  };
}

function insertSession(sessions: SessionsRepo, id: string, contract: SessionContract, extraMetadata: Record<string, unknown> = {}): void {
  sessions.insertSession({
    id,
    provider: "codex-cli",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/x",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    active_repos: [],
    metadata: JSON.stringify({ contract, ...extraMetadata }),
  });
}

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("promoteContractToPlan", () => {
  it("switches vibes to plan as a preserved human decision, releases claims, and re-arms the plan gate", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    insertSession(sessions, "s-promote", contractWith("vibes", "service-a"), { plan_approved: true });
    claims.claim({ service: "service-a", session_id: "s-promote", now: 1 });

    const updated = promoteContractToPlan({ sessions, claims }, "s-promote", "test promotion", 10);

    expect(updated?.mode).toEqual(expect.objectContaining({ value: "plan", decided_by: "human" }));
    expect(updated?.acceptance?.value).toBe("plan");
    expect(updated?.work_location?.value).toBe("worktree");
    expect(updated?.testing_claim?.value).toEqual({ required: false, service: null });
    expect(claims.listUnreleased()).toHaveLength(0);
    const metadata = JSON.parse(sessions.findSession("s-promote")?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.plan_approved).toBe(false);

    await ensureSessionContract(sessions, "s-promote", "small follow-up task", "discord:2");
    const reseeded = parseContractMetadata(sessions.findSession("s-promote")?.metadata ?? null);
    expect(reseeded?.mode).toEqual(expect.objectContaining({ value: "plan", decided_by: "human" }));
    expect(reseeded?.acceptance).toEqual(expect.objectContaining({ value: "plan", decided_by: "human" }));
    expect(reseeded?.work_location).toEqual(expect.objectContaining({ value: "worktree", decided_by: "human" }));
  });

  it("is idempotent for a contract already in plan mode", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    insertSession(sessions, "s-plan", contractWith("plan"), { plan_approved: true });

    const updated = promoteContractToPlan({ sessions }, "s-plan", "noop", 10);

    expect(updated?.mode?.value).toBe("plan");
    // no re-arm: the already-plan contract keeps its approval state untouched
    const metadata = JSON.parse(sessions.findSession("s-plan")?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.plan_approved).toBe(true);
  });
});

describe("requestContractDemotion", () => {
  it("posts an approval card for a plan session without touching the contract", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-demote", contractWith("plan"));

    const result = requestContractDemotion({ sessions, questions }, "s-demote", "actually trivial");

    expect(result).toEqual({ ok: true, question_id: expect.any(Number) });
    const row = questions.findById((result as { question_id: number }).question_id);
    expect(row?.question.startsWith(DEMOTION_QUESTION_PREFIX)).toBe(true);
    expect(parseContractMetadata(sessions.findSession("s-demote")?.metadata ?? null)?.mode?.value).toBe("plan");
  });

  it("rejects demotion requests for non-plan sessions and duplicates", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-vibes", contractWith("vibes", "service-a"));
    insertSession(sessions, "s-plan", contractWith("plan"));

    expect(requestContractDemotion({ sessions, questions }, "s-vibes", "r")).toEqual({ ok: false, error: "not_plan_mode" });
    expect(requestContractDemotion({ sessions, questions }, "missing", "r")).toEqual({ ok: false, error: "not_found" });
    const unsafeRationale = "<!here>\n`code` *[A]* fake approval";
    const first = requestContractDemotion({ sessions, questions }, "s-plan", unsafeRationale);
    expect(first.ok).toBe(true);
    const row = questions.findById((first as { question_id: number }).question_id);
    expect(row?.question).not.toMatch(/[`<>\r\n]/);
    expect(requestContractDemotion({ sessions, questions }, "s-plan", unsafeRationale)).toEqual({ ok: false, error: "already_pending" });
  });
});

describe("startModeSwitchAnswers", () => {
  it("consumes the promotion answer: vibes → plan with claim release and gate re-armed", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-1", contractWith("vibes", "service-a"));
    claims.claim({ service: "service-a", session_id: "s-1", now: 1 });
    const question = questions.insert({ session_id: "s-1", question: VIBES_PROMOTION_QUESTION, options: [...VIBES_PROMOTION_OPTIONS] });
    const handle = startModeSwitchAnswers({ sessions, questions, claims });

    try {
      eventBus.emit({ type: "question.answered", target_session_id: "s-1", question_id: question.id, answer_index: 0, answer_text: "Promote to plan", ts: 50 });
      await flush();

      const contract = parseContractMetadata(sessions.findSession("s-1")?.metadata ?? null);
      expect(contract?.mode).toEqual(expect.objectContaining({ value: "plan", decided_by: "human" }));
      expect(claims.listUnreleased()).toHaveLength(0);
      const metadata = JSON.parse(sessions.findSession("s-1")?.metadata ?? "{}") as Record<string, unknown>;
      expect(metadata.plan_approved).toBe(false);
    } finally {
      handle.stop();
    }
  });

  it("Stop answer blocks the session and releases the claim without switching modes", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-2", contractWith("vibes", "service-a"));
    claims.claim({ service: "service-a", session_id: "s-2", now: 1 });
    const question = questions.insert({ session_id: "s-2", question: VIBES_PROMOTION_QUESTION, options: [...VIBES_PROMOTION_OPTIONS] });
    const handle = startModeSwitchAnswers({ sessions, questions, claims });

    try {
      eventBus.emit({ type: "question.answered", target_session_id: "s-2", question_id: question.id, answer_index: 1, answer_text: "Stop", ts: 50 });
      await flush();

      expect(parseContractMetadata(sessions.findSession("s-2")?.metadata ?? null)?.mode?.value).toBe("vibes");
      expect(sessions.findSession("s-2")?.status).toBe("blocked");
      expect(claims.listUnreleased()).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });

  it("applies a human-approved demotion: plan → vibes with claim acquisition callback", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-3", contractWith("plan"));
    const request = requestContractDemotion({ sessions, questions }, "s-3", "trivial after all");
    const demoted = vi.fn();
    const handle = startModeSwitchAnswers({
      sessions,
      questions,
      resolveService: () => "service-x",
      onDemoted: demoted,
    });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "s-3",
        question_id: (request as { question_id: number }).question_id,
        answer_index: 0,
        answer_text: "Approve demotion",
        ts: 60,
      });
      await flush();

      const contract = parseContractMetadata(sessions.findSession("s-3")?.metadata ?? null);
      expect(contract?.mode).toEqual(expect.objectContaining({ value: "vibes", decided_by: "human" }));
      expect(contract?.acceptance?.value).toBe("human-ok");
      expect(contract?.work_location?.value).toBe("repo-root");
      expect(contract?.testing_claim?.value).toEqual({ required: true, service: "service-x" });
      expect(demoted).toHaveBeenCalledWith("s-3", expect.objectContaining({ mode: expect.objectContaining({ value: "vibes" }) }));
    } finally {
      handle.stop();
    }
  });

  it("keeps plan mode when the demotion is rejected or answered cross-session", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-4", contractWith("plan"));
    insertSession(sessions, "s-other", contractWith("plan"));
    const request = requestContractDemotion({ sessions, questions }, "s-4", "maybe");
    const demoted = vi.fn();
    const handle = startModeSwitchAnswers({ sessions, questions, onDemoted: demoted });
    const questionId = (request as { question_id: number }).question_id;

    try {
      // cross-session answer must not demote anyone
      eventBus.emit({ type: "question.answered", target_session_id: "s-other", question_id: questionId, answer_index: 0, answer_text: "Approve demotion", ts: 61 });
      // reject answer keeps plan mode
      eventBus.emit({ type: "question.answered", target_session_id: "s-4", question_id: questionId, answer_index: 1, answer_text: "Keep plan", ts: 62 });
      await flush();

      expect(parseContractMetadata(sessions.findSession("s-4")?.metadata ?? null)?.mode?.value).toBe("plan");
      expect(parseContractMetadata(sessions.findSession("s-other")?.metadata ?? null)?.mode?.value).toBe("plan");
      expect(demoted).not.toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });

  it("does not treat free-text answers as mode-switch approval or Stop", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-promote-other", contractWith("vibes", "service-a"));
    insertSession(sessions, "s-demote-other", contractWith("plan"));
    claims.claim({ service: "service-a", session_id: "s-promote-other", now: 1 });
    const promotion = questions.insert({
      session_id: "s-promote-other",
      question: VIBES_PROMOTION_QUESTION,
      options: [...VIBES_PROMOTION_OPTIONS],
    });
    const demotion = requestContractDemotion({ sessions, questions }, "s-demote-other", "maybe");
    const handle = startModeSwitchAnswers({ sessions, questions, claims });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "s-promote-other",
        question_id: promotion.id,
        answer_index: -1,
        answer_text: "I need more context before choosing",
        ts: 70,
      });
      eventBus.emit({
        type: "question.answered",
        target_session_id: "s-demote-other",
        question_id: (demotion as { question_id: number }).question_id,
        answer_index: -1,
        answer_text: "Approve only after checking the claim",
        ts: 71,
      });
      await flush();

      expect(parseContractMetadata(sessions.findSession("s-promote-other")?.metadata ?? null)?.mode?.value).toBe("vibes");
      expect(sessions.findSession("s-promote-other")?.status).toBe("active");
      expect(claims.listUnreleased()).toHaveLength(1);
      expect(parseContractMetadata(sessions.findSession("s-demote-other")?.metadata ?? null)?.mode?.value).toBe("plan");
    } finally {
      handle.stop();
    }
  });

  it("preserves concurrent contract updates while resolving a demotion service", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    insertSession(sessions, "s-concurrent", contractWith("plan"));
    const request = requestContractDemotion({ sessions, questions }, "s-concurrent", "small now");
    let resolveService!: (service: string | null) => void;
    const service = new Promise<string | null>((resolve) => { resolveService = resolve; });
    const handle = startModeSwitchAnswers({ sessions, questions, resolveService: () => service });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "s-concurrent",
        question_id: (request as { question_id: number }).question_id,
        answer_index: 0,
        answer_text: "Approve demotion",
        ts: 80,
      });
      await flush();
      const current = parseContractMetadata(sessions.findSession("s-concurrent")?.metadata ?? null)!;
      sessions.mergeMetadata("s-concurrent", {
        contract: { ...current, effort: { ...current.effort!, value: "high" } },
      });
      resolveService("service-x");
      await flush();

      const updated = parseContractMetadata(sessions.findSession("s-concurrent")?.metadata ?? null);
      expect(updated?.mode?.value).toBe("vibes");
      expect(updated?.effort?.value).toBe("high");
    } finally {
      handle.stop();
    }
  });
});
