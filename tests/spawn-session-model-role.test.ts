/**
 * 委託を通らないセッション起動 (POST /v1/admin/spawn-session) も、 model の役割名を
 * role map でモデル ID へ解決してから起動する (spec/feature/model-role-map.md MRM-TPL-07)。
 * 役割名のまま `--model astra` を渡すと Codex が model_not_found で止まる。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../src/control/spawner.js";
import { INITIAL_ROLE_MODELS } from "../src/model-catalog/role-policy.js";
import { makeTestApp } from "./helpers/test-app.js";

type Env = ReturnType<typeof makeTestApp>;

function spawnSession(env: Env, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(env.app.request("/v1/admin/spawn-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function modelArg(request: SpawnRequest | undefined): string | undefined {
  const args = request?.args ?? [];
  const index = args.indexOf("--model");
  return index >= 0 ? args[index + 1] : undefined;
}

describe("spawn-session model role resolution (MRM-TPL-07)", () => {
  let env: Env;
  let spawnCalls: SpawnRequest[];

  beforeEach(() => {
    spawnCalls = [];
    env = makeTestApp({
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 321, command: ["wt.exe", request.provider] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
  }, 30_000);

  it("resolves a role-named template model (astra) to the model id for a plain template session", async () => {
    const template = env.delegation.findTemplateByCallName("astra-mid");
    expect(template?.model).toBe("astra");

    const response = await spawnSession(env, { template: "astra-mid", cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    expect(modelArg(spawnCalls[0])).toBe(INITIAL_ROLE_MODELS.astra);
  });

  it("resolves a role name given directly with a provider", async () => {
    const response = await spawnSession(env, { provider: "codex", model: "astra", cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(modelArg(spawnCalls[0])).toBe(INITIAL_ROLE_MODELS.astra);
  });

  it("keeps an explicit model id unchanged", async () => {
    const response = await spawnSession(env, { provider: "codex", model: "gpt-6.2-sol", cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(modelArg(spawnCalls[0])).toBe("gpt-6.2-sol");
  });

  it("refuses a role name of another family instead of launching with it", async () => {
    const response = await spawnSession(env, { provider: "codex", model: "opus", cwd: env.logsDir });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "delegation_model_role_unresolved:opus (provider codex)" });
    expect(spawnCalls).toEqual([]);
  });
});
