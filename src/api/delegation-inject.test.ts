/**
 * `/v1/delegation/runs/:id/inject` の接続確認ガード裏取り。
 *
 * session.inject は /ws に接続中の WS client (Lictor 側の pty 書き込み口) にしか
 * 届かない (api/ws.ts の target_session_id フィルタ)。 session 行はあっても
 * ws_clients===0 (未接続/切断中) の間に inject すると届く相手が無く、 静かに
 * 消えてしまう。 このテストは、 その状態で無条件 ok:true を返さないことを
 * 実 DB (in-memory) で検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { delegationRouter } from "./delegation.js";
import type { DelegationService } from "../delegation/service.js";

function makeApp() {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const sessions = new SessionsRepo(db);
  // このルートの対象ハンドラ (/runs/:id/inject) は deps.service を使わないため、
  // 型合わせのためだけの空スタブでよい。
  const service = {} as DelegationService;
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({ repo, service, sessions }));
  return { app, repo, sessions };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, any>;

function seedRunWithChildSession(
  ctx: ReturnType<typeof makeApp>,
  opts: { runId: string; sessionId: string; wsClients: number },
): void {
  ctx.sessions.insertSession({
    id: opts.sessionId,
    provider: "claude-code",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: null,
    branch: null,
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
  for (let i = 0; i < opts.wsClients; i++) ctx.sessions.incrementWsClients(opts.sessionId);
  ctx.repo.createRun({
    id: opts.runId,
    template_id: null,
    call_name: "impl",
    target_provider: "claude",
    parent_session_id: null,
    child_session_id: opts.sessionId,
    args: {},
    rendered_prompt: "prompt",
    prompt_file_path: "E:/tmp/prompt.md",
    spawn_pid: 123,
    spawn_command: ["lictor", "claude"],
    triggered_by: null,
    status: "spawned",
  });
}

describe("/v1/delegation/runs/:id/inject", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => { ctx = makeApp(); });

  it("ws_clients=0 (未接続) の間は inject を成功扱いにせず 409 を返す", async () => {
    seedRunWithChildSession(ctx, { runId: "run-disconnected", sessionId: "sess-disconnected", wsClients: 0 });
    const res = await post(ctx.app, "/v1/delegation/runs/run-disconnected/inject", { text: "continue" });
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error).toBe("child_session_not_connected");
  });

  it("ws_clients>0 (接続済み) なら通常どおり inject を成功させる", async () => {
    seedRunWithChildSession(ctx, { runId: "run-connected", sessionId: "sess-connected", wsClients: 1 });
    const res = await post(ctx.app, "/v1/delegation/runs/run-connected/inject", { text: "continue" });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.target_session_id).toBe("sess-connected");
  });

  it("child_session_id 自体が存在しない run は従来どおり 404", async () => {
    ctx.repo.createRun({
      id: "run-no-child",
      template_id: null,
      call_name: "impl",
      target_provider: "claude",
      parent_session_id: null,
      child_session_id: "missing-session",
      args: {},
      rendered_prompt: "prompt",
      prompt_file_path: "E:/tmp/prompt.md",
      spawn_pid: 123,
      spawn_command: ["lictor", "claude"],
      triggered_by: null,
      status: "spawned",
    });
    const res = await post(ctx.app, "/v1/delegation/runs/run-no-child/inject", { text: "continue" });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error).toBe("child_session_not_found");
  });
});
