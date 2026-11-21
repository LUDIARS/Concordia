/**
 * `/v1/instructions` — 外部エージェント (Muse) 向けの HTTP ポーリング指令ブリッジ
 * (spec/feature/agent-instructions-bridge.md)。
 *
 *   POST /v1/instructions            登録 (loopback のみ。公開経由は 403)
 *   GET  /v1/instructions            ポーリング (公開経由は CF Access 検証済みのみ)
 *   POST /v1/instructions/:id/ack    受領確認
 *   POST /v1/instructions/:id/result 結果報告
 *   GET  /v1/instructions/:id        状態確認 (loopback のみ)
 *
 * 公開ホストの SSO と応答キャッシュより前に登録する (buildApp)。 ここで返した応答は後続へ進まない。
 * エラーは `{ error: { code, message } }`。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 受け口
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { InstructionAccessGate } from "../agent-instructions/public-access.js";
import { INSTRUCTION_ID_PATTERN } from "../agent-instructions/instruction-policy.js";
import { parseAck, parsePollQuery, parseRegister, parseResult, type RequestError } from "../agent-instructions/instruction-requests.js";
import type { InstructionService } from "../agent-instructions/instruction-service.js";

export const AGENT_INSTRUCTIONS_PATH = "/v1/instructions";
/** 本文の上限。 params 8000 / detail 16000 バイトに JSON の余白を足す。 */
export const AGENT_INSTRUCTIONS_MAX_BODY_BYTES = 64 * 1024;

export interface AgentInstructionsDeps {
  service: InstructionService;
  access: InstructionAccessGate;
  log?: { info: (detail: Record<string, unknown>, message: string) => void; warn: (detail: Record<string, unknown>, message: string) => void };
}

type Status = 400 | 403 | 404 | 409 | 413 | 500;

function fail(c: Context, status: Status, error: RequestError): Response {
  c.header("cache-control", "no-store");
  return c.json({ error }, status);
}

async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) return { ok: false };
  try { return { ok: true, body: await c.req.json() }; } catch { return { ok: false }; }
}

const NOT_JSON: RequestError = { code: "invalid_body", message: "本文は Content-Type: application/json の JSON オブジェクトで送ってください" };
const NOT_FOUND: RequestError = { code: "not_found", message: "その指令はありません。 id と agent を確かめてください" };
const LOCAL_ONLY: RequestError = { code: "local_only", message: "この操作は Concordia の自宅側 (loopback) からだけ使えます" };
const ACCESS_REQUIRED: RequestError = { code: "access_required", message: "Cloudflare Access のサービストークン (CF-Access-Client-Id / CF-Access-Client-Secret) を付けて公開ホスト経由で呼んでください" };

export function agentInstructionsRouter(deps: AgentInstructionsDeps): Hono {
  const app = new Hono();
  const header = (c: Context) => (name: string) => c.req.header(name);

  /** 公開経由なら CF Access の検証を要求する。 loopback はそのまま通す。 */
  const guard: MiddlewareHandler = async (c, next) => {
    c.header("cache-control", "no-store");
    if (deps.access.origin(header(c)) === "public" && !await deps.access.verifyPublic(header(c))) {
      deps.log?.warn({ method: c.req.method, path: c.req.path }, "agent-instructions public request without verified Access token");
      return fail(c, 403, ACCESS_REQUIRED);
    }
    await next();
  };
  /** 公開経由を検証に関係なく拒否する (登録・状態確認)。 */
  const localOnly: MiddlewareHandler = async (c, next) => {
    if (deps.access.origin(header(c)) === "public") return fail(c, 403, LOCAL_ONLY);
    await next();
  };
  const limit = bodyLimit({
    maxSize: AGENT_INSTRUCTIONS_MAX_BODY_BYTES,
    onError: (c) => fail(c, 413, { code: "too_large", message: `本文は ${AGENT_INSTRUCTIONS_MAX_BODY_BYTES} バイト以内にしてください` }),
  });
  const validId = (c: Context): string | null => {
    const id = c.req.param("id") ?? "";
    return INSTRUCTION_ID_PATTERN.test(id) ? id : null;
  };

  app.use("*", guard);

  app.post("/", localOnly, limit, async (c) => {
    const read = await readJson(c);
    if (!read.ok) return fail(c, 400, NOT_JSON);
    const parsed = parseRegister(read.body);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const instruction = deps.service.register(parsed.value);
    deps.log?.info({ id: instruction.id, agent: parsed.value.agent, type: parsed.value.type }, "agent instruction registered");
    return c.json({ data: { instruction } }, 201);
  });

  app.get("/", (c) => {
    const parsed = parsePollQuery((name) => c.req.query(name));
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const instructions = deps.service.poll(parsed.value.agent, parsed.value.status, parsed.value.limit);
    return c.json({ data: { instructions } }, 200);
  });

  app.post("/:id/ack", limit, async (c) => {
    const id = validId(c);
    if (!id) return fail(c, 404, NOT_FOUND);
    const read = await readJson(c);
    if (!read.ok) return fail(c, 400, NOT_JSON);
    const parsed = parseAck(read.body);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const outcome = deps.service.ack(id, parsed.value.agent);
    if (outcome.kind === "not_found") return fail(c, 404, NOT_FOUND);
    if (outcome.kind === "conflict") {
      return fail(c, 409, { code: "already_finished", message: `この指令は ${outcome.status} で終わっています。 ack は送り直さず次の指令へ進んでください` });
    }
    const duplicate = outcome.kind === "duplicate";
    if (!duplicate) deps.log?.info({ id }, "agent instruction acked");
    return c.json({ duplicate, data: { instruction: { id, status: outcome.status, ackedAt: outcome.ackedAt } } }, duplicate ? 200 : 202);
  });

  app.post("/:id/result", limit, async (c) => {
    const id = validId(c);
    if (!id) return fail(c, 404, NOT_FOUND);
    const read = await readJson(c);
    if (!read.ok) return fail(c, 400, NOT_JSON);
    const parsed = parseResult(read.body);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const outcome = deps.service.recordResult(id, parsed.value);
    if (outcome.kind === "not_found") return fail(c, 404, NOT_FOUND);
    if (outcome.kind === "conflict") {
      return fail(c, 409, { code: "result_conflict", message: `この指令には別の結果 (${outcome.status}) が記録済みです。 同じ結果の再送だけが受け付けられます` });
    }
    const duplicate = outcome.kind === "duplicate";
    if (!duplicate) deps.log?.info({ id, status: outcome.status }, "agent instruction finished");
    return c.json({
      delivered: true,
      failed: false,
      duplicate,
      data: { instruction: { id, status: outcome.status, finishedAt: outcome.finishedAt } },
    }, duplicate ? 200 : 202);
  });

  app.get("/:id", localOnly, (c) => {
    const id = validId(c);
    const instruction = id ? deps.service.get(id) : null;
    if (!instruction) return fail(c, 404, NOT_FOUND);
    return c.json({ data: { instruction } }, 200);
  });

  app.all("*", (c) => fail(c, 404, { code: "not_found", message: "このパスはありません。 /v1/instructions の決められた口だけが使えます" }));
  app.onError((error, c) => {
    deps.log?.warn({ path: c.req.path, error: error instanceof Error ? error.message : String(error) }, "agent-instructions request failed");
    return fail(c, 500, { code: "internal_error", message: "処理できませんでした。 ack / result は同じ内容で再送できます (冪等)。 登録は GET で積まれていないか確かめてから送り直してください" });
  });
  return app;
}

/** buildApp から呼ぶ。 SSO と応答キャッシュより前に置くこと。 */
export function registerAgentInstructionsRoute(app: Hono, deps: AgentInstructionsDeps): void {
  app.route(AGENT_INSTRUCTIONS_PATH, agentInstructionsRouter(deps));
}
