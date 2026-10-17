import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SecretBox } from "../shared/secret-box.js";
import { VillaClient } from "../villa/client.js";
import { createFederationRuntime, type FederationRuntime } from "./runtime.js";
import { startFederationListener } from "./hq-listener.js";
import { parseFederationFrame, type FederationEgressDelivery } from "./protocol.js";
import { createRemoteThreadRegistry } from "./remote-thread-registry.js";
import { SqliteSettingsStore } from "../admin/settings-store.js";
import { hqEchoUsername, toAnswerBody, toEgressQuestion } from "./remote-question.js";

describe("SPEC-FED-SITE-FORUM-PARITY: site question relay shapes", () => {
  it("normalizes old and new option forms within protocol limits", () => {
    expect(toEgressQuestion({
      question_id: 7, question: "  どれ？ ", options: ["A案", { label: "B案", description: "説明" }, { label: " " }], multi_select: true,
    })).toEqual({ question_id: 7, prompt: "どれ？", options: [{ label: "A案" }, { label: "B案", description: "説明" }], multi_select: true });
    const long = toEgressQuestion({ question_id: 1, question: "q", options: Array.from({ length: 30 }, (_, i) => `x${i}`.repeat(60)) });
    expect(long?.options).toHaveLength(25);
    expect(Array.from(long!.options[0]!.label)).toHaveLength(100);
  });

  it("does not relay plan approvals or empty questions", () => {
    expect(toEgressQuestion({ kind: "plan_approval", question_id: 1, question: "承認", options: [] })).toBeNull();
    expect(toEgressQuestion({ question_id: 1, question: "  ", options: [] })).toBeNull();
    expect(toEgressQuestion({ question_id: 0, question: "q", options: [] })).toBeNull();
  });

  it("answers single picks by index and several picks as a multi answer", () => {
    expect(toAnswerBody(3, [1])).toEqual({ question_id: 3, answer_index: 1 });
    expect(toAnswerBody(3, [0, 2])).toEqual({ question_id: 3, answer_indices: [0, 2] });
  });

  it("labels HQ replies shown on the site surface", () => {
    expect(hqEchoUsername("neco")).toBe("neco (本社)");
    expect(hqEchoUsername(" ")).toBe("本社の利用者 (本社)");
  });
});

describe("SPEC-FED-SITE-FORUM-PARITY: mention only on the launching side", () => {
  it("mentions the HQ requester only when the site asks and HQ launched the thread", async () => {
    const { requesterMentionFor } = await import("./remote-thread-registry.js");
    const hqLaunched = { guildId: "1", siteId: "melpot", at: 1, requesterId: "905235114026467350" };
    const mirrored = { guildId: "1", siteId: "melpot", at: 1 };
    expect(requesterMentionFor(hqLaunched, { mention_requester: true })).toBe("905235114026467350");
    expect(requesterMentionFor(hqLaunched, {})).toBeUndefined();
    expect(requesterMentionFor(mirrored, { mention_requester: true })).toBeUndefined();
    expect(requesterMentionFor(null, { mention_requester: true })).toBeUndefined();
  });
});

// Exercise the actual runtime callback without opening a listener or contacting Discord/Villa.
vi.mock("./hq-listener.js", () => ({
  startFederationListener: vi.fn(async () => ({
    port: 12345, enqueue: vi.fn(), disconnect: vi.fn(), sendConfigUpdate: vi.fn(), send: vi.fn(), close: vi.fn(),
  })),
}));

describe("CC-FED-EGRESS-MENTION-01: HQ owns executor mention IDs", () => {
  const guildId = "111111111111111111";
  const channelId = "222222222222222222";
  const requesterId = "333333333333333333";
  const forgedId = "444444444444444444";
  let runtime: FederationRuntime | undefined;
  let db: ReturnType<typeof makeTestDb> | undefined;

  afterEach(() => {
    runtime?.stop();
    db?.close();
    runtime = undefined;
    db = undefined;
    vi.clearAllMocks();
  });

  it.each([
    { name: "no mention request", mention: undefined, thread: "requester", expected: undefined },
    { name: "explicitly disabled mention", mention: false, thread: "requester", expected: undefined },
    { name: "HQ requester replaces site ID", mention: true, thread: "requester", expected: requesterId },
    { name: "mirrored thread has no requester", mention: true, thread: "mirror", expected: undefined },
    { name: "department delivery has no thread", mention: true, thread: "none", expected: undefined },
  ])("$name", async ({ mention, thread, expected }) => {
    db = makeTestDb();
    const settings = new SqliteSettingsStore(db);
    if (thread !== "none") {
      createRemoteThreadRegistry(settings, "federation.hq.remote_threads").record(channelId, {
        guildId, siteId: "site-a", at: 1, ...(thread === "requester" ? { requesterId } : {}),
      });
    }
    runtime = createFederationRuntime({
      db, secretBox: new SecretBox(Buffer.alloc(32, 9)), version: "test", settings,
      env: {
        listenEnabled: true, listenHost: "127.0.0.1", listenPort: 12345,
        hqUrl: null, siteId: null, siteToken: null, outboxMaxRows: 100, outboxTtlSec: 3600, allowAnyRemote: false,
      },
      villaClient: new VillaClient({ fetchImpl: async () => new Response(JSON.stringify({ state: { pcs: [] } })) }),
    });
    runtime.apiDeps.sites.create({ siteId: "site-a" });
    runtime.apiDeps.sites.setDepartments("site-a", [guildId]);
    const executor = vi.fn(async (_request: FederationEgressDelivery) => ({ ok: true }));
    runtime.setEgressExecutor(executor);
    await runtime.startRoles();
    const handler = vi.mocked(startFederationListener).mock.calls.at(-1)?.[0].handleEgressRequest;
    expect(handler).toBeTypeOf("function");

    const parsed = parseFederationFrame({
      v: 1, type: "egress-request", request_id: "request-1", guild_id: guildId, channel_id: channelId,
      text: "question", mention_user_id: forgedId, ...(mention === undefined ? {} : { mention_requester: mention }),
      future_field: "keep-compatible", username: "Site assistant",
    });
    if (!parsed.ok || parsed.frame.type !== "egress-request") throw new Error("egress fixture must parse");
    const request = parsed.frame;
    expect(request.mention_user_id).toBe(forgedId); // passthrough remains compatible.
    await expect(handler!("site-a", request)).resolves.toEqual({ ok: true });
    expect(executor).toHaveBeenCalledTimes(1);
    const delivery = executor.mock.calls[0]![0];
    const { mention_user_id: _forged, ...rest } = request;
    expect(delivery).toEqual({ ...rest, ...(expected ? { mention_user_id: expected } : {}) });
    expect(Object.hasOwn(delivery, "mention_user_id")).toBe(expected !== undefined);
    expect(request.mention_user_id).toBe(forgedId); // The parsed frame is not mutated.
  });
});
