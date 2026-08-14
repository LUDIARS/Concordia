import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { ModelReviewOutcome, ModelReviewPort } from "../model-review/contracts.js";
import { ensureSessionContract } from "./lifecycle.js";
import { ModelReviewContractAdapter } from "./model-review-adapter.js";
import { parseContractMetadata } from "./schema.js";
import { patchContractHuman } from "./store.js";

function insertSession(sessions: SessionsRepo, id: string, metadata: Record<string, unknown> | null): void {
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
    metadata: metadata ? JSON.stringify(metadata) : null,
    active_repos: [],
  });
}

function reviewPort(outcome: ModelReviewOutcome): ModelReviewPort & { review: ReturnType<typeof vi.fn> } {
  return { review: vi.fn().mockResolvedValue(outcome) };
}

const PROPOSAL: ModelReviewOutcome = {
  status: "proposal",
  currentModel: null,
  currentEffort: null,
  proposedModel: "gpt-5.3-codex",
  proposedEffort: "high",
  rationale: "Genius の蓄積判断に基づく候補です。",
  geniusCardIds: ["card-1"],
};

describe("ensureSessionContract (model-review absorption)", () => {
  it("records the absorbed review as llm decisions and applies them to the runtime", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    insertSession(sessions, "s-absorb", null);
    const port = reviewPort(PROPOSAL);
    const apply = vi.fn().mockResolvedValue({ ok: true, message: "switched" });

    await ensureSessionContract(
      sessions,
      "s-absorb",
      "small fix",
      "discord:1",
      undefined,
      new ModelReviewContractAdapter(port, "codex"),
      undefined,
      undefined,
      apply,
    );

    const contract = parseContractMetadata(sessions.findSession("s-absorb")?.metadata ?? null);
    expect(contract?.model).toMatchObject({ value: "gpt-5.3-codex", decided_by: "llm" });
    expect(contract?.effort).toMatchObject({ value: "high", decided_by: "llm" });
    // 旧 applyRuntimeModelReview 相当の切替が契約経由で呼ばれる (runtime 反映)。
    expect(apply).toHaveBeenCalledWith({ sessionId: "s-absorb", model: "gpt-5.3-codex", effort: "high" });
  });

  it("keeps fields unresolved (not current-value fallbacks) on a Genius miss", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    insertSession(sessions, "s-miss", null);
    const apply = vi.fn();

    await ensureSessionContract(
      sessions,
      "s-miss",
      "small fix",
      "discord:1",
      undefined,
      new ModelReviewContractAdapter(reviewPort({ status: "miss", reason: "genius-no-hit" }), "codex"),
      undefined,
      undefined,
      apply,
    );

    const contract = parseContractMetadata(sessions.findSession("s-miss")?.metadata ?? null);
    expect(contract?.model).toBeNull();
    expect(contract?.effort).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("re-reviews reported runtime model/effort and applies a different proposal", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    insertSession(sessions, "s-seeded", { model: "gpt-5-codex", effort_level: "medium" });
    const port = reviewPort(PROPOSAL);
    const apply = vi.fn().mockResolvedValue({ ok: true, message: "switched" });

    await ensureSessionContract(
      sessions,
      "s-seeded",
      "small fix",
      "discord:1",
      undefined,
      new ModelReviewContractAdapter(port, "codex"),
      undefined,
      undefined,
      apply,
    );

    const contract = parseContractMetadata(sessions.findSession("s-seeded")?.metadata ?? null);
    expect(contract?.model).toMatchObject({ value: "gpt-5.3-codex", decided_by: "llm" });
    expect(contract?.effort).toMatchObject({ value: "high", decided_by: "llm" });
    expect(port.review).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "spawn",
      currentModel: "gpt-5-codex",
      currentEffort: "medium",
    }));
    expect(apply).toHaveBeenCalledWith({ sessionId: "s-seeded", model: "gpt-5.3-codex", effort: "high" });
  });

  it("preserves human overrides across task-change re-evaluation", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    insertSession(sessions, "s-human", null);
    const port = reviewPort(PROPOSAL);

    await ensureSessionContract(sessions, "s-human", "small fix", "discord:1", undefined, new ModelReviewContractAdapter(port, "codex"));
    patchContractHuman(sessions, "s-human", { effort: "low" }, "人間指定の effort を維持する");

    await ensureSessionContract(sessions, "s-human", "another task", "discord:1", undefined, new ModelReviewContractAdapter(port, "codex"));

    const contract = parseContractMetadata(sessions.findSession("s-human")?.metadata ?? null);
    // human 上書きは task-change の seed / LLM 再判定で消えない。
    expect(contract?.effort).toMatchObject({ value: "low", decided_by: "human" });
    // model は human 決定ではないので LLM tier が再度埋める。
    expect(contract?.model).toMatchObject({ value: "gpt-5.3-codex", decided_by: "llm" });
    // 2 回目の review は effort が human 確定済みでも model が未決なので呼ばれる。
    expect(port.review).toHaveBeenCalledTimes(2);
  });
});
