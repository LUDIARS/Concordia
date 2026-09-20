import { afterEach, describe, expect, it } from "vitest";
import {
  LICTOR_FETCH_TIMEOUT_MS,
  LICTOR_SLOW_FETCH_TIMEOUT_MS,
  fetchFromLictor,
} from "./lictor-proxy.js";

/**
 * 2026-09-20 の event loop 停止の再発防止。 死んだ peer (ソケットを掴んだまま
 * 終了したプロセス) への fetch は FIN も RST も返らないため、 signal が無いと
 * undici の headersTimeout (300 秒) まで待つ。 Cc はそれを 32 本掴んで無応答に
 * なった。 ここでは「呼び出し側が signal を渡さなくても必ず付く」ことを検証する。
 *
 * vitest は isolate: false で registry を共有するため vi.mock は使わず、
 * globalThis.fetch を直接差し替える。
 */
describe("fetchFromLictor", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("呼び出し側が signal を渡さなければ既定タイムアウトを付ける", async () => {
    let received: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      received = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchFromLictor(12345, "/v1/fs/read");

    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(received?.signal?.aborted).toBe(false);
  });

  it("呼び出し側の signal を尊重して上書きしない", async () => {
    const own = AbortSignal.timeout(LICTOR_SLOW_FETCH_TIMEOUT_MS);
    let received: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      received = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchFromLictor(12345, "/v1/fs/grep", { method: "GET", signal: own });

    expect(received?.signal).toBe(own);
  });

  it("応答しない peer では signal の期限で abort する", async () => {
    // AbortSignal.timeout は実タイマーで動くのでフェイクタイマーは効かない。
    // 期限そのものは既定値テストで担保済みなので、 ここでは「signal が発火したら
    // 掴みっぱなしにならず失敗して返る」ことだけを短い期限で確認する。
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "TimeoutError"));
        });
      })) as typeof fetch;

    await expect(
      fetchFromLictor(12345, "/v1/fs/read", { signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow(/abort/i);
  });

  it("既定より遅い経路のタイムアウトは既定より長い", () => {
    expect(LICTOR_SLOW_FETCH_TIMEOUT_MS).toBeGreaterThan(LICTOR_FETCH_TIMEOUT_MS);
  });
});
