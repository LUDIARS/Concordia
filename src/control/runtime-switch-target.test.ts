import { afterEach, describe, expect, it } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { applyRuntimeModelReview } from "../model-review/runtime-switch.js";
import { resolveLictorTarget } from "./lictor-proxy.js";
import { resolveRuntimeSwitchTarget, SATELLES_SIDECAR_PORT_KEY } from "./runtime-switch-target.js";

/**
 * Satelles (codex-sdk) のセッションは lictor_port を持たず satelles_sidecar_port を
 * 公開する。 effort 変更 (runtime-switch) だけがそれを辿り、 Lictor 専用の操作
 * (resolveLictorTarget) は従来どおり Satelles を対象にしない。
 */
function repoWith(metadata: Record<string, unknown> | null, status = "active") {
  const merged: Array<Record<string, unknown>> = [];
  const row = {
    id: "s1", status, provider: "codex-sdk",
    metadata: metadata === null ? null : JSON.stringify(metadata),
  };
  const repo = {
    findSession: (id: string) => (id === "s1" ? row : null),
    mergeMetadata: (_id: string, patch: Record<string, unknown>) => { merged.push(patch); },
  } as unknown as SessionsRepo;
  return { repo, merged };
}

describe("resolveRuntimeSwitchTarget", () => {
  it("Lictor セッションは従来どおり lictor_port を使う", () => {
    const { repo } = repoWith({ lictor_port: 4100, [SATELLES_SIDECAR_PORT_KEY]: 4200 });
    expect(resolveRuntimeSwitchTarget(repo, "s1")).toEqual({ sessionId: "s1", port: 4100 });
  });

  it("Satelles セッションは satelles_sidecar_port に届き、 Lictor 専用の解決は変わらない", () => {
    const { repo } = repoWith({ wrapped_by: "satelles", [SATELLES_SIDECAR_PORT_KEY]: 4200 });
    expect(resolveRuntimeSwitchTarget(repo, "s1")).toEqual({ sessionId: "s1", port: 4200 });
    expect("error" in resolveLictorTarget(repo, "s1")).toBe(true);
  });

  it("ポート未公開 / 不正値 / 非 active は理由付きで拒否する", () => {
    expect("error" in resolveRuntimeSwitchTarget(repoWith({ wrapped_by: "satelles" }).repo, "s1")).toBe(true);
    expect("error" in resolveRuntimeSwitchTarget(repoWith({ [SATELLES_SIDECAR_PORT_KEY]: "4200" }).repo, "s1")).toBe(true);
    expect("error" in resolveRuntimeSwitchTarget(repoWith({ [SATELLES_SIDECAR_PORT_KEY]: 70000 }).repo, "s1")).toBe(true);
    expect("error" in resolveRuntimeSwitchTarget(repoWith({ [SATELLES_SIDECAR_PORT_KEY]: 4200 }, "ended").repo, "s1")).toBe(true);
    expect("error" in resolveRuntimeSwitchTarget(repoWith(null).repo, "s1")).toBe(true);
  });
});

describe("applyRuntimeModelReview (Satelles)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("Satelles sidecar の /v1/runtime/model-effort へ Lictor と同じ body を送り、 成功で metadata を更新する", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, message: "次のターンから適用します" }), { status: 200 });
    }) as typeof fetch;
    const { repo, merged } = repoWith({ wrapped_by: "satelles", [SATELLES_SIDECAR_PORT_KEY]: 4200 });

    const result = await applyRuntimeModelReview(repo, { sessionId: "s1", model: "gpt-5.5", effort: "high" });

    expect(result).toEqual({ ok: true, message: "次のターンから適用します" });
    expect(calls).toEqual([{ url: "http://127.0.0.1:4200/v1/runtime/model-effort", body: { model: "gpt-5.5", effort: "high" } }]);
    expect(merged).toEqual([{ model: "gpt-5.5", effort: "high" }]);
  });

  it("sidecar の 400 は metadata を変えずに理由を返す", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_effort" }), { status: 400 })) as typeof fetch;
    const { repo, merged } = repoWith({ [SATELLES_SIDECAR_PORT_KEY]: 4200 });
    const result = await applyRuntimeModelReview(repo, { sessionId: "s1", model: "gpt-5.5", effort: "max" });
    expect(result).toEqual({ ok: false, message: "invalid_effort" });
    expect(merged).toEqual([]);
  });
});
