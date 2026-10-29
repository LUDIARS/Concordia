// @implements spec/feature/line-webhook-relay.md — お知らせの push
// 実 LINE は呼ばない。 push API は fetch の代役、 送り手は LinePushSender の代役で確かめる。
import { describe, expect, it, vi } from "vitest";
import { createLineNoticePusher } from "./notice-push.js";
import { createLinePushSender, LINE_PUSH_API_URL, type LinePushSender } from "./push-client.js";
import { resolveLinePushTalks } from "./push-talks.js";
import type { LineTalkLinkRow } from "./talk-links.js";
import { derivePushRetryKey } from "./push-retry-key.js";
import type { LineNoticePushTarget } from "./push-talks.js";
const linePushRetryKey = (id: string, index: number) => derivePushRetryKey("ludiars", "mf", `discord-notice:${id}`, String(index));

/** テスト値 (実物ではない)。 */
const ACCESS_TOKEN = "example-channel-access-token";
const GROUP_A = "C0000000000000000000000000000000a";
const GROUP_B = "C0000000000000000000000000000000b";

const mf: LineNoticePushTarget = {
  name: "mf", url: "http://192.0.2.10/hook", host: null, enabled: true, channel: "ludiars", keywords: [], pushEnabled: true,
};
const mm: LineNoticePushTarget = { ...mf, name: "mm", url: "http://192.0.2.11/hook" };

function link(overrides: Partial<LineTalkLinkRow>): LineTalkLinkRow {
  return { id: 1, channel: "ludiars", talkId: GROUP_A, service: "mf", isDefault: true, linkedAt: 1, ...overrides };
}


describe("resolveLinePushTalks", () => {
  it("そのサービスをふだんの相手にしている、そのチャネルのトークだけを重複なく返す", () => {
    const links = [
      link({ id: 1, talkId: GROUP_A }),
      link({ id: 2, talkId: GROUP_B }),
      link({ id: 3, talkId: GROUP_A, service: "mm" }),
      link({ id: 4, talkId: "C0000000000000000000000000000000c", isDefault: false }),
      link({ id: 5, talkId: "C0000000000000000000000000000000d", channel: "other" }),
    ];
    expect(resolveLinePushTalks([mf, mm], links, "mf")).toEqual({ kind: "talks", channel: "ludiars", talkIds: [GROUP_A, GROUP_B] });
    expect(resolveLinePushTalks([mf], [], "mf")).toEqual({ kind: "talks", channel: "ludiars", talkIds: [] });
  });

  it("未登録・止まっている・push が無効なサービスには送らない", () => {
    const links = [link({})];
    expect(resolveLinePushTalks([mm], links, "mf")).toEqual({ kind: "skipped", reason: "unknown_service" });
    expect(resolveLinePushTalks([{ ...mf, enabled: false }], links, "mf")).toEqual({ kind: "skipped", reason: "service_disabled" });
    expect(resolveLinePushTalks([{ ...mf, pushEnabled: false }], links, "mf")).toEqual({ kind: "skipped", reason: "push_disabled" });
  });
});

describe("linePushRetryKey", () => {
  it("messageId と番号から決まる UUID で、同じ入力なら同じ・違えば違う", () => {
    const key = linePushRetryKey("423456789012345678", 0);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(linePushRetryKey("423456789012345678", 0)).toBe(key);
    expect(linePushRetryKey("423456789012345678", 1)).not.toBe(key);
    expect(linePushRetryKey("423456789012345679", 0)).not.toBe(key);
  });
});

describe("createLinePushSender", () => {
  const request = { accessToken: ACCESS_TOKEN, to: GROUP_A, texts: ["バスが遅れています", "朝便"], retryKey: linePushRetryKey("1", 0) };

  it("push API へチャネルアクセストークンと X-Line-Retry-Key を付けて送る", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    expect(await createLinePushSender({ fetchImpl: fetchImpl as typeof fetch })(request)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(LINE_PUSH_API_URL);
    expect(init!.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "x-line-retry-key": request.retryKey,
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      to: GROUP_A, messages: [{ type: "text", text: "バスが遅れています" }, { type: "text", text: "朝便" }],
    });
  });

  it("429 を再送せず応答ストリームを解放する", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, body: { cancel } })) as unknown as typeof fetch;
    expect(await createLinePushSender({ fetchImpl })(request)).toEqual({ ok: false, status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("409 (同じキーで受理済み) は送れたとみなし、429 と接続失敗は status だけを返す", async () => {
    const respond = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await createLinePushSender({ fetchImpl: respond(409) })(request)).toEqual({ ok: true });
    expect(await createLinePushSender({ fetchImpl: respond(429) })(request)).toEqual({ ok: false, status: 429 });
    const broken = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await createLinePushSender({ fetchImpl: broken })(request)).toEqual({ ok: false, status: null });
  });
});

describe("createLineNoticePusher", () => {
  function setup(options: { targets?: LineNoticePushTarget[]; links?: LineTalkLinkRow[]; token?: string | null; send?: LinePushSender } = {}) {
    const send = vi.fn<LinePushSender>(options.send ?? (async () => ({ ok: true })));
    const push = createLineNoticePusher({
      targets: () => options.targets ?? [mf],
      talkLinks: () => options.links ?? [link({ id: 1, talkId: GROUP_A }), link({ id: 2, talkId: GROUP_B })],
      accessToken: () => (options.token === undefined ? ACCESS_TOKEN : options.token),
      send,
    });
    return { push, send };
  }

  it("宛先のトークごとに 1 回ずつ、番号ごとに違う X-Line-Retry-Key で送る", async () => {
    const { push, send } = setup();
    expect(await push({ service: "mf", messageId: "423456789012345678", texts: ["バスが遅れています"] }))
      .toEqual({ kind: "pushed", talks: 2, sent: 2, failedStatuses: [] });
    expect(send.mock.calls.map(([request]) => request)).toEqual([
      { accessToken: ACCESS_TOKEN, to: GROUP_A, texts: ["バスが遅れています"], retryKey: linePushRetryKey("423456789012345678", 0) },
      { accessToken: ACCESS_TOKEN, to: GROUP_B, texts: ["バスが遅れています"], retryKey: linePushRetryKey("423456789012345678", 1) },
    ]);
  });

  it("失敗は再送せず status だけを集計する", async () => {
    const { push, send } = setup({ send: async ({ to }) => (to === GROUP_A ? { ok: false, status: 429 } : { ok: true }) });
    expect(await push({ service: "mf", messageId: "1", texts: ["x"] }))
      .toEqual({ kind: "pushed", talks: 2, sent: 1, failedStatuses: [429] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("同じ送り手でも pushEnabled の停止を次の通知から反映する", async () => {
    let current = mf;
    const send = vi.fn<LinePushSender>(async () => ({ ok: true }));
    const push = createLineNoticePusher({
      targets: () => [current], talkLinks: () => [link({})], accessToken: () => ACCESS_TOKEN, send,
    });
    await push({ service: "mf", messageId: "1", texts: ["x"] });
    current = { ...mf, pushEnabled: false };
    expect(await push({ service: "mf", messageId: "2", texts: ["x"] }))
      .toEqual({ kind: "skipped", reason: "push_disabled" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("トークが無い・push が無効・チャネルアクセストークンが無ければ送らない", async () => {
    const empty = setup({ links: [] });
    expect(await empty.push({ service: "mf", messageId: "1", texts: ["x"] })).toEqual({ kind: "pushed", talks: 0, sent: 0, failedStatuses: [] });
    expect(empty.send).not.toHaveBeenCalled();
    const disabled = setup({ targets: [{ ...mf, pushEnabled: false }] });
    expect(await disabled.push({ service: "mf", messageId: "1", texts: ["x"] })).toEqual({ kind: "skipped", reason: "push_disabled" });
    expect(disabled.send).not.toHaveBeenCalled();
    const noToken = setup({ token: null });
    expect(await noToken.push({ service: "mf", messageId: "1", texts: ["x"] }))
      .toEqual({ kind: "skipped", reason: "channel_access_token_missing" });
    expect(noToken.send).not.toHaveBeenCalled();
  });
});
