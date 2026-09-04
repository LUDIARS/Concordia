/**
 * `GET /v1/modules` の契約。
 *
 * 「いま何が止まっているのか」を 1 コールで見るための読み取り面なので、
 * mode / 担当プロセス / degraded_note / 不一致がすべて 1 度で返ることを固定する。
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { modulesRouter } from "./modules.js";

function makeApp(startedEmbedded: string[], env: NodeJS.ProcessEnv = {}): Hono {
  return new Hono().route("/v1/modules", modulesRouter({
    wiring: () => ({ startedEmbedded }),
    env,
  }));
}

describe("GET /v1/modules", () => {
  it("全モジュールの mode・担当プロセス・health・degraded_note を返す", async () => {
    const app = makeApp(["core", "chat", "cost", "workflow"]);
    const res = await app.request("/v1/modules");

    expect(res.status).toBe(200);
    const body = await res.json() as { modules: Array<Record<string, unknown>> };
    expect(body.modules.length).toBeGreaterThan(0);
    const core = body.modules.find((m) => m.name === "core");
    expect(core).toMatchObject({
      mode: "embedded",
      excubitor_code: "concordia",
      health_path: "/health",
    });
    expect(String(core?.degraded_note).length).toBeGreaterThan(10);
  });

  it("環境変数で off にしたモジュールが off として出る", async () => {
    // 台帳がモードを読み直さず、既存の readChatMode を通っていることの確認でもある。
    const app = makeApp(["core", "cost", "workflow"], { CONCORDIA_CHAT_MODE: "off" });
    const res = await app.request("/v1/modules");

    const body = await res.json() as { modules: Array<{ name: string; mode: string }> };
    expect(body.modules.find((m) => m.name === "chat")?.mode).toBe("off");
  });

  it("台帳と実配線が食い違えば mismatches に出る", async () => {
    // off にした覚えが無いのに起動していない、が最も気づきにくい。
    const app = makeApp(["core", "cost", "workflow"]);
    const res = await app.request("/v1/modules");

    const body = await res.json() as { modules: Array<{ name: string; mismatches: string[] }> };
    expect(body.modules.find((m) => m.name === "chat")?.mismatches).toEqual([
      "embedded と解決されたが backend 内で起動していない",
    ]);
  });

  it("一致していれば mismatches は空配列", async () => {
    const app = makeApp(["core", "chat", "cost", "workflow"]);
    const res = await app.request("/v1/modules");

    const body = await res.json() as { modules: Array<{ mismatches: string[] }> };
    for (const module of body.modules) expect(module.mismatches).toEqual([]);
  });
});
