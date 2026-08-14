import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { parseContractMetadata, type SessionContract } from "../contract/schema.js";
import { contractModeSwitchRouter } from "./contract-mode-switch.js";
import { registerContractRoutes } from "./sessions/contract.js";
import type { SessionsApiDeps } from "./sessions/deps.js";

function contractWith(mode: "plan" | "vibes"): SessionContract {
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
    testing_claim: human({ required: false, service: null }),
    supervisor: human("discord:1"),
  };
}

function setup(mode: "plan" | "vibes") {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const questions = makeDiscordPendingQuestionsRepo(db);
  sessions.insertSession({
    id: "s-1",
    provider: "codex-cli",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/x",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    active_repos: [],
    metadata: JSON.stringify({ contract: contractWith(mode) }),
  });
  return { sessions, questions };
}

describe("contractModeSwitchRouter", () => {
  it("target=vibes (降格) は契約を変更せず承認カード投稿の 202 pending を返す", async () => {
    const { sessions, questions } = setup("plan");
    const app = new Hono().route("/", contractModeSwitchRouter({ sessions, questions }));

    const res = await app.request("/s-1/contract/mode-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "vibes", rationale: "trivial after all" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json() as { pending: boolean; question_id: number };
    expect(body.pending).toBe(true);
    expect(questions.findById(body.question_id)).not.toBeNull();
    // 承認前は plan のまま — 契約はカードの人間回答だけが書き換える
    expect(parseContractMetadata(sessions.findSession("s-1")?.metadata ?? null)?.mode?.value).toBe("plan");
  });

  it("target=plan (昇格) は human tier で即時適用され plan gate が立つ", async () => {
    const { sessions, questions } = setup("vibes");
    const app = new Hono().route("/", contractModeSwitchRouter({ sessions, questions }));

    const res = await app.request("/s-1/contract/mode-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "plan", rationale: "grew too large" }),
    });

    expect(res.status).toBe(200);
    const contract = parseContractMetadata(sessions.findSession("s-1")?.metadata ?? null);
    expect(contract?.mode).toEqual(expect.objectContaining({ value: "plan", decided_by: "human" }));
    const metadata = JSON.parse(sessions.findSession("s-1")?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.plan_approved).toBe(false);
  });
});

describe("PATCH /:id/contract の mode 拒否", () => {
  it("汎用 patch 経由の無承認モード変更を 400 で拒否する", async () => {
    const { sessions } = setup("plan");
    const app = new Hono();
    registerContractRoutes(app, { repo: sessions } as unknown as SessionsApiDeps);

    const res = await app.request("/s-1/contract", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { mode: "vibes" }, rationale: "sneaky demotion" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("mode_switch_required");
    expect(parseContractMetadata(sessions.findSession("s-1")?.metadata ?? null)?.mode?.value).toBe("plan");
  });

  it("mode 以外のフィールドは従来どおり patch できる", async () => {
    const { sessions } = setup("plan");
    const app = new Hono();
    registerContractRoutes(app, { repo: sessions } as unknown as SessionsApiDeps);

    const res = await app.request("/s-1/contract", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { effort: "high" }, rationale: "human bump" }),
    });

    expect(res.status).toBe(200);
    expect(parseContractMetadata(sessions.findSession("s-1")?.metadata ?? null)?.effort?.value).toBe("high");
  });
});
