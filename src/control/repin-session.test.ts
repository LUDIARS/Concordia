import { describe, it, expect } from "vitest";
import { repinSession } from "./repin-session.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

/** lictor_port を焼いた active セッション 1 件だけ返す最小の SessionsRepo スタブ。 */
function repoWith(meta: string | null, status = "active"): SessionsRepo {
  return {
    findSession: (id: string) =>
      id === "s1" ? ({ id, status, metadata: meta } as ReturnType<SessionsRepo["findSession"]>) : null,
  } as unknown as SessionsRepo;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("repinSession", () => {
  it("lictor_port を解決して /v1/repin を POST し ok+path を返す", async () => {
    let calledPort = -1;
    let calledPath = "";
    const r = await repinSession(repoWith(JSON.stringify({ lictor_port: 5555 })), "s1", async (port, path) => {
      calledPort = port;
      calledPath = path;
      return jsonResponse(200, { ok: true, path: "C:/x/abc.jsonl" });
    });
    expect(calledPort).toBe(5555);
    expect(calledPath).toBe("/v1/repin");
    expect(r).toEqual({ ok: true, path: "C:/x/abc.jsonl" });
  });

  it("lictor_port 未設定なら error を返す (fetch しない)", async () => {
    let fetched = false;
    const r = await repinSession(repoWith(JSON.stringify({})), "s1", async () => {
      fetched = true;
      return jsonResponse(200, { ok: true });
    });
    expect(fetched).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lictor_port/);
  });

  it("非 active セッションは error", async () => {
    const r = await repinSession(repoWith(JSON.stringify({ lictor_port: 1 }), "ended"), "s1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ended/);
  });

  it("sidecar が 409 (新 transcript 無し) なら ok=false + body.error", async () => {
    const r = await repinSession(repoWith(JSON.stringify({ lictor_port: 1 })), "s1", async () =>
      jsonResponse(409, { ok: false, path: null }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/409|lictor returned/);
  });

  it("ネットワーク例外は error 文字列に畳む (throw しない)", async () => {
    const r = await repinSession(repoWith(JSON.stringify({ lictor_port: 1 })), "s1", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ECONNREFUSED");
  });
});
