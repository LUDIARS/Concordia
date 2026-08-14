import { describe, expect, it, vi } from "vitest";
import { CONTEXT_COMPACT_PREFIX, handleContextCompactButton } from "./context.js";

function makeInteraction(customId: string) {
  return {
    customId,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

function makeDeps(input: {
  session?: unknown;
  response?: { ok: boolean; status?: number; body?: unknown };
}) {
  const fetchImpl = vi.fn(async () => ({
    ok: input.response?.ok ?? true,
    status: input.response?.status ?? 200,
    json: async () => input.response?.body ?? {},
  }));
  return {
    sessionsRepo: { findSession: vi.fn((_id: string) => input.session ?? null) },
    concordiaUrl: "http://127.0.0.1:11111/",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    fetchMock: fetchImpl,
  };
}

describe("handleContextCompactButton", () => {
  it("セッション不明なら ephemeral エラー応答のみで API を呼ばない", async () => {
    const interaction = makeInteraction(`${CONTEXT_COMPACT_PREFIX}missing`);
    const deps = makeDeps({ session: null });
    await handleContextCompactButton(interaction as any, deps);
    expect(interaction.reply).toHaveBeenCalledWith({ content: "対象セッションが見つかりません。", ephemeral: true });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it("compact API を POST し成功を ephemeral で返す (末尾スラッシュは正規化)", async () => {
    const interaction = makeInteraction(`${CONTEXT_COMPACT_PREFIX}session-1`);
    const deps = makeDeps({ session: { id: "session-1" }, response: { ok: true } });
    await handleContextCompactButton(interaction as any, deps);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(deps.fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11111/v1/sessions/session-1/compact",
      { method: "POST" },
    );
    expect(interaction.followUp).toHaveBeenCalledWith({ content: "✅ コンパクション完了。", ephemeral: true });
  });

  it("API 失敗は error / status を含む失敗メッセージで返す", async () => {
    const interaction = makeInteraction(`${CONTEXT_COMPACT_PREFIX}session-1`);
    const deps = makeDeps({ session: { id: "session-1" }, response: { ok: false, status: 503, body: { error: "busy" } } });
    await handleContextCompactButton(interaction as any, deps);
    expect(interaction.followUp).toHaveBeenCalledWith({ content: "⚠️ 失敗: busy", ephemeral: true });

    const noBody = makeInteraction(`${CONTEXT_COMPACT_PREFIX}session-1`);
    const depsNoBody = makeDeps({ session: { id: "session-1" }, response: { ok: false, status: 500, body: {} } });
    await handleContextCompactButton(noBody as any, depsNoBody);
    expect(noBody.followUp).toHaveBeenCalledWith({ content: "⚠️ 失敗: 500", ephemeral: true });
  });
});
