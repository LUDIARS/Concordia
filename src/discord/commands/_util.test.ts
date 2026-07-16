import { afterEach, describe, expect, it, vi } from "vitest";
import { callConcordia } from "./_util.js";

describe("callConcordia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a non-2xx API message as the actionable Discord error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ ok: false, message: "ビルドに失敗: spawn EINVAL" }),
    })));

    await expect(callConcordia("http://concordia", "POST", "/v1/confirm/start")).resolves.toEqual({
      error: "ビルドに失敗: spawn EINVAL",
    });
  });

  it("keeps the existing error field precedence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_body", message: "ignored" }),
    })));

    await expect(callConcordia("http://concordia", "POST", "/v1/confirm/start")).resolves.toEqual({
      error: "invalid_body",
    });
  });
});
