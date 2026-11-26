import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HubDiscordService } from "./discord-service.js";
import { HubSprintService } from "./sprint-service.js";
import { HubCalliopeService } from "./calliope-service.js";
import { HubSpecDraftService } from "./spec-draft-service.js";
import { HubMelpomeneService } from "./melpomene-service.js";
import { MelpomeneHttpEndpoint, httpError } from "./melpomene-http.js";
import { createMethodHandlers, dispatchMethod } from "./method-router.js";
import { HubAuthenticator } from "./authenticate.js";
import { GeoGuard } from "./geo-guard.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { GlabUnityTokenService } from "./token-service.js";
import { openGlabUnityHubDb, SqliteGlabUnityStore } from "../adapters/sqlite-store.js";
import type { MethodContext } from "./method-context.js";
import type { ChannelAccess, DiscordGateway, IssuePort, PraeformaSpecPort } from "./ports.js";
import { HubError } from "../domain/protocol.js";
import { formatToken, hashToken } from "../domain/token-policy.js";

const NOW = new Date("2026-11-26T00:00:00.000Z");
const clock = { now: () => NOW };
const CHANNEL = "123456789012345678";

function context(userId = "111111111111111111"): MethodContext & { subscribed: Set<string> } {
  const subscribed = new Set<string>();
  const plain = formatToken(randomBytes(32));
  return {
    subscribed,
    identity: {
      token: {
        id: "tok-1", tokenHash: hashToken(plain), displayPrefix: plain.slice(0, 12), discordUserId: userId, guildId: "g",
        label: "pc", createdAt: NOW.toISOString(), expiresAt: "2026-12-26T00:00:00.000Z", lastUsedAt: null, revokedAt: null,
      },
      member: { discordUserId: userId, displayName: "neco", avatarUrl: null },
    },
    subscriptions: { subscribe: (id) => { subscribed.add(id); }, unsubscribe: (id) => { subscribed.delete(id); } },
  };
}

function gateway(access: ChannelAccess | null): DiscordGateway & { posts: unknown[] } {
  const posts: unknown[] = [];
  return {
    posts,
    member: async () => ({ discordUserId: "111111111111111111", displayName: "neco", avatarUrl: null }),
    listChannels: async () => [
      { id: CHANNEL, name: "general", parentId: null, kind: "text" },
      { id: "223456789012345678", name: "secret", parentId: null, kind: "text" },
    ],
    access: async (_user, channelId) => (channelId === CHANNEL ? access : { view: false, readHistory: false, send: false, react: false }),
    listMessages: async () => [{ id: "m", authorName: "a", content: "c", createdAt: "t", attachments: [] }],
    postAs: async (member, channelId, input) => { posts.push({ member: member.displayName, channelId, ...input }); return { messageId: "posted" }; },
    react: async () => undefined,
    uploadLogs: async (input) => input.files.map((file) => ({ name: file.name, url: `https://cdn.example/${file.name}` })),
    onMessage: () => () => undefined,
    onMemberLeave: () => () => undefined,
  };
}

const full: ChannelAccess = { view: true, readHistory: true, send: true, react: true };

describe("discord.* は本人の権限で絞る", () => {
  it("channels.list は閲覧できるものだけ", async () => {
    const service = new HubDiscordService(gateway(full));
    expect((await service.listChannels(context())).channels.map((c) => c.id)).toEqual([CHANNEL]);
  });

  it("送信権限が無ければ投稿は forbidden、 あれば本人名義で投稿", async () => {
    await expect(new HubDiscordService(gateway({ ...full, send: false })).post(context(), { channelId: CHANNEL, content: "x" }))
      .rejects.toMatchObject({ code: "forbidden" });
    const ok = gateway(full);
    await expect(new HubDiscordService(ok).post(context(), { channelId: CHANNEL, content: "x" })).resolves.toEqual({ messageId: "posted" });
    expect(ok.posts).toEqual([{ member: "neco", channelId: CHANNEL, content: "x" }]);
  });

  it("履歴権限が無ければ messages.list と subscribe は forbidden、 GLab 外は not_found", async () => {
    const noHistory = new HubDiscordService(gateway({ ...full, readHistory: false }));
    await expect(noHistory.listMessages(context(), { channelId: CHANNEL })).rejects.toMatchObject({ code: "forbidden" });
    await expect(noHistory.subscribe(context(), { channelId: CHANNEL })).rejects.toMatchObject({ code: "forbidden" });
    await expect(new HubDiscordService(gateway(null)).react(context(), { channelId: CHANNEL, messageId: "1", emoji: "👍" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("subscribe で購読に入り unsubscribe で外れる", async () => {
    const service = new HubDiscordService(gateway(full));
    const ctx = context();
    await service.subscribe(ctx, { channelId: CHANNEL });
    expect(ctx.subscribed.has(CHANNEL)).toBe(true);
    await service.unsubscribe(ctx, { channelId: CHANNEL });
    expect(ctx.subscribed.size).toBe(0);
  });
});

describe("sprint.*", () => {
  const actio = {
    aggregate: vi.fn(async () => ({ project: "CC", generatedAt: NOW.toISOString(), teams: [{ teamId: "t", teamName: "T", activeSprint: {
      id: "s1", name: "S", goal: null, startsOn: "2026-11-20", endsOn: "2026-11-30", tasks: { total: 1, byStatus: {}, project: { total: 1, byStatus: { done: 1 } } } } }] })),
    sprintTasks: vi.fn(async () => [{ id: "t1", title: "x", status: "open", assignee: "actio-alice", due: null, url: null }]),
    findTask: vi.fn(async (taskId: string) => (taskId === "t1" ? { project: "CC", assigneeId: "actio-alice" } : null)),
    setStatus: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn() };
  const service = new HubSprintService({ actio, projects: ["CC"], actioUserOf: (id) => (id === "111111111111111111" ? "actio-alice" : null), audit });

  it("current はスプリントとタスクを返し、 設定外のプロジェクトは not_found", async () => {
    const view = await service.current(context(), { project: "CC" });
    expect(view.sprint?.completedRatio).toBe(1);
    expect(actio.sprintTasks).toHaveBeenCalledWith("CC", "s1");
    await expect(service.current(context(), { project: "Other" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("tasks.update は担当が本人のタスクだけ", async () => {
    await expect(service.updateTask(context(), { taskId: "t1", status: "done" })).resolves.toEqual({ taskId: "t1", status: "done" });
    await expect(service.updateTask(context("999999999999999999"), { taskId: "t1", status: "done" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.updateTask(context(), { taskId: "missing", status: "done" })).rejects.toMatchObject({ code: "not_found" });
    expect(actio.setStatus).toHaveBeenCalledTimes(1);
  });
});

describe("calliope.*", () => {
  const generated = JSON.stringify({ summary: "要約", phase: "α", uxValues: [], domains: [], openQuestions: [] });

  function make(writer: () => Promise<string | null>) {
    const saved = new Map<string, unknown>();
    const events: unknown[] = [];
    const service = new HubCalliopeService({
      store: { load: (p) => (saved.get(p) as never) ?? null, save: (product) => { saved.set(product.project, product); } },
      materials: { collect: async () => [{ name: "repo.spec/ux", fetchedAt: "t", text: "素材" }] },
      writer: { write: writer },
      clock, projects: ["CC"], broadcast: (event, data) => events.push({ event, data }),
    });
    return { service, events, saved };
  }

  it("refresh は非同期で作り、 完了で calliope.updated、 結果は draft:true", async () => {
    const { service, events } = make(async () => generated);
    await expect(service.product(context(), { project: "CC" })).rejects.toMatchObject({ code: "not_found" });
    expect((await service.refresh(context(), { project: "CC" })).accepted).toBe(true);
    await service.pending("CC");
    expect(events).toEqual([{ event: "calliope.updated", data: { project: "CC", generatedAt: NOW.toISOString(), ok: true } }]);
    expect(await service.product(context(), { project: "CC" })).toMatchObject({ draft: true, summary: "要約" });
  });

  it("同一プロジェクトは 1 時間に 1 回まで", async () => {
    const { service } = make(async () => generated);
    await service.refresh(context(), { project: "CC" });
    await service.pending("CC");
    await expect(service.refresh(context(), { project: "CC" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("生成物が契約に合わなければ保存せず失敗を通知する", async () => {
    const { service, events, saved } = make(async () => "not json");
    await service.refresh(context(), { project: "CC" });
    await service.pending("CC");
    expect(saved.size).toBe(0);
    expect(events).toEqual([{ event: "calliope.updated", data: { project: "CC", ok: false } }]);
  });
});

describe("spec.* と PR フック", () => {
  function make() {
    const store = new SqliteGlabUnityStore(openGlabUnityHubDb(":memory:"), clock.now);
    const praeforma: PraeformaSpecPort & { decided: unknown[] } = {
      decided: [],
      createFragment: vi.fn(async () => ({ fragmentId: "f1" })),
      requestReconstruction: vi.fn(async () => ({ reconstructionId: "r1", changeCount: 2 })),
      fragmentDispositions: vi.fn(async () => new Map([["f1", "pending"]])),
      pendingReconstruction: vi.fn(async () => ({ id: "r1", changeCount: 2 })),
      decide: vi.fn(async (_pid, rid, decision) => { praeforma.decided.push({ rid, decision }); }),
      linkFor: () => "https://pf.example/projects/pf1/specs",
    };
    const github: IssuePort & { comments: string[] } = {
      comments: [],
      createIssue: vi.fn(async () => "https://github.com/x/y/issues/1"),
      commentOnPullRequest: vi.fn(async (_repo, _n, body) => { github.comments.push(body); }),
      pullRequestDiff: vi.fn(async () => "+added"),
    };
    const service = new HubSpecDraftService({
      store, praeforma, github, audit: store, clock,
      specRepos: [{ repo: "LUDIARS/CookieClicker", project: "CC", praeformaProjectId: "pf1" }],
    });
    return { store, praeforma, github, service };
  }

  const event = { repo: "LUDIARS/CookieClicker", number: 7, headSha: "abcdef1234567", title: "敵 AI", url: "https://github.com/LUDIARS/CookieClicker/pull/7", draft: false };

  it("積まれた PR から draft の断片を作り、 PR にコメントする (同じ head は 1 回)", async () => {
    const h = make();
    expect(h.store.enqueueJob(event, NOW.toISOString())).toBe(true);
    expect(h.store.enqueueJob(event, NOW.toISOString())).toBe(false);
    expect(await h.service.processNext()).toBe(true);
    expect(await h.service.processNext()).toBe(false);
    expect(h.praeforma.createFragment).toHaveBeenCalledWith("pf1", expect.objectContaining({ sourceEventId: "glab-pr:ludiars/cookieclicker#7@abcdef123456" }));
    expect(h.github.comments[0]).toContain("https://pf.example/projects/pf1/specs");
    const list = await h.service.list(context(), { project: "CC" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: "draft", prUrl: event.url });
  });

  it("spec.review は Praeforma の decide へ中継し本人の操作として記録する", async () => {
    const h = make();
    h.store.enqueueJob(event, NOW.toISOString());
    await h.service.processNext();
    const [item] = (await h.service.list(context(), { project: "CC" })).items;
    await expect(h.service.review(context(), { id: item!.id, decision: "reject", comment: "違う" })).resolves.toEqual({ id: item!.id, status: "rejected" });
    expect(h.praeforma.decided[0]).toMatchObject({ rid: "r1" });
    expect((h.praeforma.decided[0] as { decision: { rejectedChanges: unknown[] } }).decision.rejectedChanges).toHaveLength(2);
    expect(h.store.getDraft(item!.id)?.reviewedBy).toBe("111111111111111111");
    await expect(h.service.review(context(), { id: item!.id, decision: "accept" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(h.service.get(context(), { id: "missing" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Melpomene の受け口", () => {
  function make(options: { members?: boolean } = {}) {
    const store = new SqliteGlabUnityStore(openGlabUnityHubDb(":memory:"), clock.now);
    const tokens = new GlabUnityTokenService({ store, audit: store, clock, glabGuildId: "222222222222222222" });
    const issued = tokens.issue({ discordUserId: "111111111111111111", guildId: "222222222222222222" }, null);
    if (!issued.ok) throw new Error("issue failed");
    const discord = gateway(full);
    const github = { createIssue: vi.fn(async () => "https://github.com/LUDIARS/CookieClicker/issues/3"), commentOnPullRequest: vi.fn(), pullRequestDiff: vi.fn() };
    const melpomene = new HubMelpomeneService({ github, discord, audit: store, allowedRepos: ["LUDIARS/CookieClicker"] });
    const authenticator = new HubAuthenticator({ store, discord: { member: async (id) => (options.members === false ? null : { discordUserId: id, displayName: "neco", avatarUrl: null }) }, clock });
    const geo = new GeoGuard({ allowedCountries: ["JP"], policy: "block", audit: store, notifier: { notify: async () => undefined }, clock });
    const endpoint = new MelpomeneHttpEndpoint({ authenticator, geo, registry: new ConnectionRegistry(), melpomene, audit: store, clock });
    return { endpoint, github, token: issued.token, melpomene };
  }

  const origin = { cfCountry: "JP", cfConnectingIp: "203.0.113.1", remoteAddress: "127.0.0.1" };
  const body = JSON.stringify({ title: "落ちる", body: "手順", category: "crash", priority: "high", labels: ["bug"], repo: "LUDIARS/CookieClicker",
    logs: [{ name: "Player.log", contentBase64: Buffer.from("tail").toString("base64") }] });

  it("Bearer 必須・ログを上げて Issue を作り {issueUrl, logUrls} を返す", async () => {
    const h = make();
    expect((await h.endpoint.handle({ origin, authorization: undefined, bodyText: body })).status).toBe(401);
    const reply = await h.endpoint.handle({ origin, authorization: `Bearer ${h.token}`, bodyText: body });
    expect(reply).toEqual({ status: 201, body: { issueUrl: "https://github.com/LUDIARS/CookieClicker/issues/3", logUrls: ["https://cdn.example/Player.log"] } });
    const issue = (h.github.createIssue.mock.calls[0] as unknown as [{ body: string; labels: string[] }])[0];
    expect(issue.body).toContain("https://cdn.example/Player.log");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("許可外 repo は 403、 海外 (block) は 403、 CF 非経由は 403", async () => {
    const h = make();
    const other = JSON.stringify({ title: "x", body: "y", repo: "LUDIARS/Other" });
    expect((await h.endpoint.handle({ origin, authorization: `Bearer ${h.token}`, bodyText: other })).status).toBe(403);
    expect((await h.endpoint.handle({ origin: { ...origin, cfCountry: "US" }, authorization: `Bearer ${h.token}`, bodyText: body })).status).toBe(403);
    expect((await h.endpoint.handle({ origin: { cfCountry: null, cfConnectingIp: null, remoteAddress: "192.0.2.1" }, authorization: `Bearer ${h.token}`, bodyText: body })).status).toBe(403);
  });

  it("投稿は 1 ユーザー毎分 10 件まで", async () => {
    const h = make();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await h.endpoint.handle({ origin, authorization: `Bearer ${h.token}`, bodyText: body })).status);
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(httpError("upstream_unavailable", "x").status).toBe(502);
  });

  it("WS の melpomene.report はログ無しで起票する", async () => {
    const h = make();
    await expect(h.melpomene.report(context(), { title: "t", body: "b", repo: "LUDIARS/CookieClicker" })).resolves.toMatchObject({ logUrls: [] });
  });
});

describe("メソッドの対応表", () => {
  const handlers = createMethodHandlers({
    discord: new HubDiscordService(gateway(full)),
    sprint: {} as never, calliope: {} as never, spec: {} as never, melpomene: {} as never,
    breviarium: { listProjects: async () => ({ projects: [] }), projectOverview: async (p) => ({ project: p }) },
    notion: { query: async () => ({ items: [], nextCursor: null }), update: async (_b, pageId) => ({ pageId }), create: async () => ({ pageId: "new" }) },
    guildId: "222222222222222222",
    notionBoards: [{ id: "board", name: "ボード" }],
    breviariumProjects: ["CC"],
  });

  it("whoami / capabilities は契約の形", async () => {
    const ctx = context();
    expect(await handlers["hub.whoami"](ctx, {})).toEqual({
      discordUserId: "111111111111111111", displayName: "neco", guildId: "222222222222222222", tokenLabel: "pc", expiresAt: "2026-12-26T00:00:00.000Z",
    });
    const capabilities = await handlers["hub.capabilities"](ctx, {}) as { methods: string[]; notionBoards: unknown[]; breviariumProjects: string[] };
    expect(capabilities.methods).toContain("spec.review");
    expect(capabilities.notionBoards).toEqual([{ id: "board", name: "ボード" }]);
  });

  it("Breviarium はそのまま返し、 許可外のボード・プロジェクトは not_found", async () => {
    expect(await dispatchMethod(handlers, context(), "breviarium.snapshot", { project: "CC" })).toEqual({ ok: true, payload: { project: "CC" } });
    const notFound = await dispatchMethod(handlers, context(), "notion.board.query", { boardId: "other" });
    expect(!notFound.ok && notFound.error.code).toBe("not_found");
    const empty = await dispatchMethod(handlers, context(), "notion.board.update", { boardId: "board", pageId: "p" });
    expect(!empty.ok && empty.error.code).toBe("invalid_request");
  });

  it("未知のメソッドは not_found、 payload 違反は invalid_request、 内部例外は internal", async () => {
    const unknown = await dispatchMethod(handlers, context(), "hub.nope", {});
    expect(!unknown.ok && unknown.error.code).toBe("not_found");
    const bad = await dispatchMethod(handlers, context(), "discord.messages.list", { channelId: "x" });
    expect(!bad.ok && bad.error.code).toBe("invalid_request");
    const broken = await dispatchMethod({ ...handlers, "hub.whoami": async () => { throw new Error("boom"); } }, context(), "hub.whoami", {});
    expect(!broken.ok && broken.error).toEqual(new HubError("internal", "internal error"));
  });
});
