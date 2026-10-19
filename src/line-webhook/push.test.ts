import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LineChannelSecretStore } from "./channel-secrets.js";
import { createLinePushSender } from "./push-client.js";
import { PushLedger, PUSH_RATE_LIMIT, PUSH_RATE_WINDOW_MS, PUSH_REQUEST_MEMO_MS, takePushSlot } from "./push-limits.js";
import { selectPushTalks } from "./push-recipients.js";
import { parsePushRequest } from "./push-request.js";
import { derivePushRetryKey } from "./push-retry-key.js";
import {
  clearPushToken,
  hashPushToken,
  issuePushToken,
  matchPushToken,
  readPushEnabled,
  readPushTokenHash,
  setPushEnabled,
} from "./push-token.js";

/** テスト値 (実物ではない)。 */
const TOKEN = "example-push-token";

function memoryStore(): LineChannelSecretStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: (key) => rows.get(key) ?? null,
    set: (key, value) => { rows.set(key, value); },
    delete: (key) => { rows.delete(key); },
  };
}

describe("parsePushRequest", () => {
  it("requestId と text だけの messages (1〜3 件) を受ける", () => {
    expect(parsePushRequest({ requestId: "req-1", messages: [{ text: "おてつだい 1 つ" }] }))
      .toEqual({ requestId: "req-1", texts: ["おてつだい 1 つ"] });
    expect(parsePushRequest({ requestId: "a".repeat(64), messages: [{ text: "1" }, { text: "2" }, { text: "x".repeat(1000) }] }))
      .toEqual({ requestId: "a".repeat(64), texts: ["1", "2", "x".repeat(1000)] });
  });

  it("形違いは null (境界: 0 件・4 件・1001 字・空 text・requestId 65 字 / 空白入り・未知のキー)", () => {
    const ok = { requestId: "req-1", messages: [{ text: "a" }] };
    expect(parsePushRequest(null)).toBeNull();
    expect(parsePushRequest([ok])).toBeNull();
    expect(parsePushRequest({ ...ok, messages: [] })).toBeNull();
    expect(parsePushRequest({ ...ok, messages: [{ text: "1" }, { text: "2" }, { text: "3" }, { text: "4" }] })).toBeNull();
    expect(parsePushRequest({ ...ok, messages: [{ text: "x".repeat(1001) }] })).toBeNull();
    expect(parsePushRequest({ ...ok, messages: [{ text: "   " }] })).toBeNull();
    expect(parsePushRequest({ ...ok, messages: [{ type: "text", text: "a" }] })).toBeNull();
    expect(parsePushRequest({ ...ok, messages: ["a"] })).toBeNull();
    expect(parsePushRequest({ ...ok, requestId: "" })).toBeNull();
    expect(parsePushRequest({ ...ok, requestId: "a".repeat(65) })).toBeNull();
    expect(parsePushRequest({ ...ok, requestId: "req 1" })).toBeNull();
    expect(parsePushRequest({ ...ok, requestId: 1 })).toBeNull();
    expect(parsePushRequest({ ...ok, to: "U0" })).toBeNull();
  });
});

describe("push トークン", () => {
  it("Bearer のトークンのハッシュが保存した値と一致するときだけ true", () => {
    const hash = hashPushToken(TOKEN);
    expect(hash).toBe(createHash("sha256").update(TOKEN).digest("hex"));
    expect(matchPushToken(hash, `Bearer ${TOKEN}`)).toBe(true);
    expect(matchPushToken(hash, "Bearer other-token")).toBe(false);
    expect(matchPushToken(hash, TOKEN)).toBe(false);
    expect(matchPushToken(hash, `Basic ${TOKEN}`)).toBe(false);
    expect(matchPushToken(hash, undefined)).toBe(false);
    expect(matchPushToken(null, `Bearer ${TOKEN}`)).toBe(false);
    expect(matchPushToken("not-a-hash", `Bearer ${TOKEN}`)).toBe(false);
  });

  it("発行は平文を返してハッシュだけを保存し、 発行し直すと前のトークンは通らない", () => {
    const store = memoryStore();
    const first = issuePushToken(store, "mf");
    expect(readPushTokenHash(store, "mf")).toBe(hashPushToken(first));
    expect([...store.rows.values()]).not.toContain(first);
    const second = issuePushToken(store, "mf");
    expect(second).not.toBe(first);
    expect(matchPushToken(readPushTokenHash(store, "mf"), `Bearer ${first}`)).toBe(false);
    expect(matchPushToken(readPushTokenHash(store, "mf"), `Bearer ${second}`)).toBe(true);
    clearPushToken(store, "mf");
    expect(readPushTokenHash(store, "mf")).toBeNull();
  });

  it("pushEnabled は既定で無効、 切り替えられる。 復号できない値は未設定扱い", () => {
    const store = memoryStore();
    expect(readPushEnabled(store, "mf")).toBe(false);
    setPushEnabled(store, "mf", true);
    expect(readPushEnabled(store, "mf")).toBe(true);
    setPushEnabled(store, "mf", false);
    expect(readPushEnabled(store, "mf")).toBe(false);
    const broken: LineChannelSecretStore = { get: () => { throw new Error("decrypt failed"); }, set: () => undefined, delete: () => undefined };
    expect(readPushTokenHash(broken, "mf")).toBeNull();
    expect(readPushEnabled(broken, "mf")).toBe(false);
  });
});

describe("selectPushTalks", () => {
  it("そのチャネルでそのサービスがふだんの相手のトークだけを重複なく返す", () => {
    const links = [
      { channel: "ludiars", talkId: "C1", service: "mf", isDefault: true },
      { channel: "ludiars", talkId: "C2", service: "mf", isDefault: false },
      { channel: "ludiars", talkId: "C3", service: "mm", isDefault: true },
      { channel: "other", talkId: "C4", service: "mf", isDefault: true },
      { channel: "ludiars", talkId: "U5", service: "mf", isDefault: true },
      { channel: "ludiars", talkId: "C1", service: "mf", isDefault: true },
    ];
    expect(selectPushTalks(links, "ludiars", "mf")).toEqual(["C1", "U5"]);
    expect(selectPushTalks(links, "ludiars", "none")).toEqual([]);
  });
});

describe("derivePushRetryKey", () => {
  it("UUID の形で、 同じ 4 つ組なら同じ・どれかが違えば別の値", () => {
    const key = derivePushRetryKey("ludiars", "mf", "req-1", "C1");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivePushRetryKey("ludiars", "mf", "req-1", "C1")).toBe(key);
    expect(derivePushRetryKey("ludiars", "mf", "req-1", "C2")).not.toBe(key);
    expect(derivePushRetryKey("ludiars", "mf", "req-2", "C1")).not.toBe(key);
    expect(derivePushRetryKey("ludiars", "mm", "req-1", "C1")).not.toBe(key);
    expect(derivePushRetryKey("other", "mf", "req-1", "C1")).not.toBe(key);
  });
});

describe("takePushSlot / PushLedger", () => {
  it("1 分 10 件まで。 1 分経てば枠が戻る", () => {
    let history: number[] = [];
    for (let i = 0; i < PUSH_RATE_LIMIT; i++) {
      const slot = takePushSlot(history, 1000 + i);
      expect(slot.allowed).toBe(true);
      history = slot.history;
    }
    expect(takePushSlot(history, 2000)).toEqual({ allowed: false, history });
    const later = takePushSlot(history, 1000 + PUSH_RATE_WINDOW_MS);
    expect(later.allowed).toBe(true);
    expect(later.history).toHaveLength(PUSH_RATE_LIMIT);
  });

  it("枠はサービスごと、 requestId の結果は 24 時間覚える", async () => {
    const ledger = new PushLedger();
    for (let i = 0; i < PUSH_RATE_LIMIT; i++) expect(ledger.take("mf", 0)).toBe(true);
    expect(ledger.take("mf", 0)).toBe(false);
    expect(ledger.take("mm", 0)).toBe(true);
    ledger.remember("k", 0, Promise.resolve({ sent: 1, failed: 0 }));
    expect(await ledger.recall("k", PUSH_REQUEST_MEMO_MS - 1)).toEqual({ sent: 1, failed: 0 });
    expect(ledger.recall("k", PUSH_REQUEST_MEMO_MS)).toBeNull();
  });
});

describe("createLinePushSender", () => {
  it("push API に Retry-Key 付きで text を送り、 409 は送れている扱い・429 は失敗", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    const send = createLinePushSender({ url: "http://line.example.test/push", fetchImpl });
    const request = { accessToken: "example-access-token", to: "C1", texts: ["a", "b"], retryKey: "k-1" };
    expect(await send(request)).toEqual({ ok: true });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("http://line.example.test/push");
    expect(headers.authorization).toBe("Bearer example-access-token");
    expect(headers["x-line-retry-key"]).toBe("k-1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      to: "C1", messages: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    });
    status = 409;
    expect(await send(request)).toEqual({ ok: true });
    status = 429;
    expect(await send(request)).toEqual({ ok: false, status: 429 });
    expect(calls).toHaveLength(3);
    const failing = createLinePushSender({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await failing(request)).toEqual({ ok: false, status: null });
  });
});
