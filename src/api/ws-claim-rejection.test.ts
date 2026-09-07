import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { attachWsServer, type WsHandle } from "./ws.js";

/**
 * claim 拒否の観測可能な振る舞いを、 実際の WS サーバごしに固定する。
 *
 * 単体テスト (ws-enrollment.test.ts) は verdict の値までしか見ない。 拒否理由を
 * 分けた目的は 「クライアントが close reason を読んで諦められること」 なので、
 * close code/reason が実際に配線されているかはここで確かめる必要がある。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function repoWith(rows: Record<string, { metadata: string | null }>): SessionsRepo {
  return {
    findSession: (id: string) => rows[id] ?? null,
    incrementWsClients: () => 1,
    decrementWsClients: () => 0,
  } as unknown as SessionsRepo;
}

async function startWs(repo: SessionsRepo): Promise<string> {
  const httpServer: Server = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const handle: WsHandle = attachWsServer(httpServer, "/ws", repo);
  cleanups.push(() => {
    handle.close();
    httpServer.close();
  });
  const { port } = httpServer.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws`;
}

/** close の code/reason を待つ。 */
function closeInfo(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("ws claim rejection", () => {
  it("存在しない session id は 1008 / unknown session id で閉じる", async () => {
    const url = await startWs(repoWith({}));
    const ws = new WebSocket(`${url}?session=not-a-session-id`);
    cleanups.push(() => { try { ws.terminate(); } catch { /* ignore */ } });

    expect(await closeInfo(ws)).toEqual({ code: 1008, reason: "unknown session id" });
  });

  it("秘密が合わない claim は 1008 / invalid session enrollment で閉じる", async () => {
    const url = await startWs(repoWith({
      s1: { metadata: JSON.stringify({ concordia_spawn_id: "spawn-secret" }) },
    }));
    const ws = new WebSocket(`${url}?session=s1&enrollment=wrong-secret`);
    cleanups.push(() => { try { ws.terminate(); } catch { /* ignore */ } });

    expect(await closeInfo(ws)).toEqual({ code: 1008, reason: "invalid session enrollment" });
  });

  it("2 つの拒否理由は互いに区別できる (同じ文言に潰れていない)", async () => {
    const url = await startWs(repoWith({
      s1: { metadata: JSON.stringify({ concordia_spawn_id: "spawn-secret" }) },
    }));
    const unknown = new WebSocket(`${url}?session=nope`);
    const mismatch = new WebSocket(`${url}?session=s1&enrollment=wrong`);
    cleanups.push(() => { try { unknown.terminate(); } catch { /* ignore */ } });
    cleanups.push(() => { try { mismatch.terminate(); } catch { /* ignore */ } });

    const [a, b] = await Promise.all([closeInfo(unknown), closeInfo(mismatch)]);
    expect(a.reason).not.toBe(b.reason);
  });

  it("正当な claim は拒否されない", async () => {
    const url = await startWs(repoWith({
      s1: { metadata: JSON.stringify({ concordia_spawn_id: "spawn-secret" }) },
    }));
    const ws = new WebSocket(`${url}?session=s1&enrollment=spawn-secret`);
    cleanups.push(() => { try { ws.terminate(); } catch { /* ignore */ } });

    const hello = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(String(data)));
      ws.on("close", (code, reason) => reject(new Error(`closed ${code} ${reason.toString()}`)));
    });
    expect(JSON.parse(hello)).toMatchObject({ session_id: "s1" });
  });

  it("拒否された接続が続いてもサーバは生き続ける", async () => {
    // 拒否経路は早期 return するため、 per-socket の 'error' ハンドラを付け忘れると
    // close 直後の ECONNRESET 等で EventEmitter が throw し、 プロセスごと死ぬ
    // (wss の 'error' は server 用で socket を拾わない)。 廃止した agent-client は
    // まさにこの経路を毎秒叩いていたので、 拒否の連打で壊れないことを固定する。
    const url = await startWs(repoWith({
      s1: { metadata: JSON.stringify({ concordia_spawn_id: "spawn-secret" }) },
    }));

    for (let i = 0; i < 5; i += 1) {
      const rejected = new WebSocket(`${url}?session=missing-${i}`);
      cleanups.push(() => { try { rejected.terminate(); } catch { /* ignore */ } });
      // 拒否は open を待たずに来ることがある。 どちらの順序でも進めるよう、
      // close を待ちつつ open した場合だけ abort 気味に切って socket error を誘う。
      rejected.on("open", () => { try { rejected.terminate(); } catch { /* ignore */ } });
      rejected.on("error", () => { /* 切断由来の client 側 error は無視 */ });
      await closeInfo(rejected);
    }

    // 連打のあとでも正当な claim を受け付けられる = サーバが生きている。
    const ok = new WebSocket(`${url}?session=s1&enrollment=spawn-secret`);
    cleanups.push(() => { try { ok.terminate(); } catch { /* ignore */ } });
    const hello = await new Promise<string>((resolve, reject) => {
      ok.on("message", (data) => resolve(String(data)));
      ok.on("close", (code, reason) => reject(new Error(`closed ${code} ${reason.toString()}`)));
    });
    expect(JSON.parse(hello)).toMatchObject({ type: "hello", session_id: "s1" });
  });
});
