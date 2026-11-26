import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { resolveGlabUnityHubConfig } from "./hub-config.js";
import { gunzipRequest, HUB_WS_PATH, originOf, upgradeProblem, websocketAccept } from "./portus-server.js";
import { loadPortus } from "./portus-loader.js";
import { NotionBoardClient } from "./notion-boards.js";
import { PraeformaSpecClient } from "./praeforma-specs.js";
import { BreviariumClient } from "./breviarium-client.js";
import { GhCliIssues } from "./github-cli.js";
import { ActioSprintClient } from "./actio-sprints.js";
import { LoopbackServiceHttp } from "./service-http.js";
import { CalliopeMaterials, OneShotCalliopeWriter } from "./calliope-adapters.js";
import { enqueueGlabSpecDraft, resetSharedGlabUnityStore, sharedGlabUnityStore } from "./module-store.js";
import { toMessageSummary, unityPrefixed } from "./discord-gateway.js";
import type { IncomingMessage } from "node:http";

describe("設定", () => {
  it("設定例 (concordia.config.example.json) の glabUnityHub 節が読める", () => {
    const example = JSON.parse(readFileSync(join(process.cwd(), "concordia.config.example.json"), "utf8")) as { glabUnityHub: Record<string, unknown> };
    // `$comment` のような注釈キーは読み飛ばす (コピーしてそのまま使えること)。
    const config = resolveGlabUnityHubConfig(example.glabUnityHub, {}, "/srv/concordia");
    expect(config.geoPolicy).toBe("block");
    expect(config.allowedCountries).toEqual(["JP"]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.notionBoards[0]?.credentialKey).toBe("GLAB");
    expect(config.dbPath.replace(/\\/g, "/")).toBe("/srv/concordia/glab-unity-hub.sqlite");
  });

  it("env が上書きし、 既定は JP / block", () => {
    const config = resolveGlabUnityHubConfig({}, {
      GLAB_UNITY_HUB_GUILD_ID: "222222222222222222", GLAB_UNITY_HUB_PORT: "11115",
      GLAB_UNITY_HUB_ALLOWED_COUNTRIES: "JP,KR", GLAB_UNITY_HUB_GEO_POLICY: "monitor",
    }, "/x");
    expect(config).toMatchObject({ guildId: "222222222222222222", port: 11115, allowedCountries: ["JP", "KR"], geoPolicy: "monitor" });
    expect(resolveGlabUnityHubConfig({}, {}, "/x")).toMatchObject({ guildId: null, port: null, geoPolicy: "block", allowedCountries: ["JP"] });
    expect(() => resolveGlabUnityHubConfig({ unknownKey: 1 }, {}, "/x")).toThrow();
  });
});

describe("Portus の待受の補助", () => {
  it("RFC 6455 の accept 値", () => {
    expect(websocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("upgrade 要求を検査する", () => {
    const ok = { method: "GET", url: HUB_WS_PATH, headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } };
    expect(upgradeProblem(ok)).toBeNull();
    expect(upgradeProblem({ ...ok, url: "/other" })).toBe("not found");
    expect(upgradeProblem({ ...ok, headers: { ...ok.headers, "sec-websocket-version": "8" } })).toBe("unsupported websocket version");
  });

  it("CF ヘッダと送信元を海外監視の入力にする", () => {
    expect(originOf({ headers: { "cf-ipcountry": "JP", "cf-connecting-ip": "203.0.113.1" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage))
      .toEqual({ cfCountry: "JP", cfConnectingIp: "203.0.113.1", remoteAddress: "127.0.0.1" });
  });

  it("gzip の本文を展開し、 長さ・符号化ヘッダを外す", async () => {
    const raw = new PassThrough() as unknown as IncomingMessage;
    Object.assign(raw, { headers: { "content-encoding": "gzip", "content-length": "10", authorization: "Bearer x" }, method: "POST", url: "/v1/glab-unity/melpomene/reports", socket: {} });
    const decoded = gunzipRequest(raw);
    (raw as unknown as PassThrough).end(gzipSync(Buffer.from("{\"title\":\"t\"}")));
    const chunks: Buffer[] = [];
    for await (const chunk of decoded as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("{\"title\":\"t\"}");
    expect(decoded.headers["content-length"]).toBeUndefined();
    expect(decoded.headers["content-encoding"]).toBeUndefined();
    expect(decoded.headers.authorization).toBe("Bearer x");
  });

  it("Portus はパッケージ → GLAB_UNITY_HUB_PORTUS_ROOT の順に探し、 無ければ理由付きで失敗する", async () => {
    const importer = vi.fn(async (specifier: string) => {
      if (specifier.startsWith("@ludiars/")) throw new Error("not installed");
      return specifier.includes("http") ? { createHttpServer: () => null, json: () => null } : { WebSocket: class {} };
    });
    await expect(loadPortus({ GLAB_UNITY_HUB_PORTUS_ROOT: "E:/Document/Ars/Portus" }, importer)).resolves.toHaveProperty("WebSocket");
    await expect(loadPortus({}, async () => { throw new Error("missing"); })).rejects.toThrow(/GLAB_UNITY_HUB_PORTUS_ROOT/);
  });
});

describe("上流クライアント", () => {
  const board = { id: "b", name: "B", dataSourceId: "ds1", credentialKey: "GLAB", properties: { title: "Name", status: "Status", statusType: "status" as const, assignees: null, due: null } };

  it("Notion: 鍵は CC_NOTION_TOKEN_<key>、 他のボードの行は更新しない", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/query")) return new Response(JSON.stringify({ results: [{ id: "p1", properties: { Name: { title: [{ plain_text: "T" }] }, Status: { status: { name: "Todo" } } } }], next_cursor: null }));
      if (path.includes("/pages/p-foreign")) return new Response(JSON.stringify({ parent: { data_source_id: "other" } }));
      return new Response(JSON.stringify({ id: "new", parent: { data_source_id: "ds1" } }));
    });
    const client = new NotionBoardClient([board], { CC_NOTION_TOKEN_GLAB: "secret" }, fetchImpl as unknown as typeof fetch);
    expect((await client.query("b", undefined)).items[0]).toMatchObject({ pageId: "p1", title: "T", status: "Todo" });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: "Bearer secret", "Notion-Version": "2025-09-03" });
    await expect(client.update("b", "p-foreign", { status: "Done" })).rejects.toMatchObject({ code: "not_found" });
    await expect(new NotionBoardClient([board], {}, fetchImpl as unknown as typeof fetch).query("b", undefined)).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("Praeforma / Breviarium: 契約の経路を叩く", async () => {
    const request = vi.fn(async (_service: string, _method: string, path: string, body?: unknown) => {
      if (path.endsWith("/spec-fragments")) return { fragment: { id: "f1", sourceEventId: (body as { sourceEventId: string }).sourceEventId } };
      if (path.endsWith("/reconstructions")) return { proposal: { id: "r1", plan: { changes: [{}, {}] } } };
      if (path.includes("spec-fragments?")) return { items: [{ id: "f1", disposition: { state: "integrated" } }] };
      return { ok: true };
    });
    const praeforma = new PraeformaSpecClient({ request } as never, "https://pf.example/");
    await expect(praeforma.createFragment("pf1", { content: "c", sourceEventId: "e" })).resolves.toEqual({ fragmentId: "f1" });
    await expect(praeforma.requestReconstruction("pf1")).resolves.toEqual({ reconstructionId: "r1", changeCount: 2 });
    expect((await praeforma.fragmentDispositions("pf1")).get("f1")).toBe("integrated");
    expect(praeforma.linkFor("pf1")).toBe("https://pf.example/projects/pf1/specs");
    const breviarium = new BreviariumClient({ request } as never);
    await breviarium.projectOverview("CC");
    expect(request).toHaveBeenLastCalledWith("breviarium", "GET", "/api/projects/CC/overview");
  });

  it("兄弟サービスのポートは catalog から引き、 書き込みに loopback の Origin を付ける", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const http = new LoopbackServiceHttp({ findService: async () => ({ port: null, catalog_snapshot: { port: 3000 } }) } as never, fetchImpl as unknown as typeof fetch);
    await http.request("praeforma", "POST", "/api/x", {});
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/x");
    expect(init.headers).toMatchObject({ origin: "http://127.0.0.1:3000" });
    await expect(new LoopbackServiceHttp({ findService: async () => null } as never, fetchImpl as unknown as typeof fetch).request("breviarium", "GET", "/"))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("gh: 起票は本文ファイル経由で URL を返し、 PR コメントと差分を取る", async () => {
    const runner = { run: vi.fn(async (args: readonly string[]) => (args[0] === "issue" ? "https://github.com/LUDIARS/CookieClicker/issues/9\n" : "diff")) };
    const gh = new GhCliIssues(runner);
    await expect(gh.createIssue({ repo: "LUDIARS/CookieClicker", title: "t", body: "本文", labels: ["bug"] })).resolves.toBe("https://github.com/LUDIARS/CookieClicker/issues/9");
    expect(runner.run.mock.calls[0]![0]).toEqual(expect.arrayContaining(["--body-file", "--label", "bug"]));
    await gh.commentOnPullRequest("LUDIARS/CookieClicker", 7, "c");
    expect(runner.run.mock.calls[1]![0].slice(0, 3)).toEqual(["pr", "comment", "7"]);
    await expect(gh.createIssue({ repo: "bad repo", title: "t", body: "b", labels: [] })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("Actio: 集計とスプリントのタスクを既存の Actio 連携で読む", async () => {
    const binding = { repoPath: "E:/x", project: "CC", projectId: "pid", ownerId: "actio-local", authMode: "loopback" as const, subsidiaryId: null, teamId: null };
    const request = vi.fn(async (_binding: unknown, _method: string, path: string) => {
      if (path.includes("/sprints")) return { project: "CC", generatedAt: "2026-11-26T00:00:00.000Z", teams: [] };
      if (path.startsWith("/api/tasks?")) return { tasks: [{ id: "t1", title: "x", status: "open", assigneeId: "u", deadline: null }], nextCursor: null };
      return { task: { id: "t1", title: "x", status: "open", assigneeId: "u", projectId: "pid" } };
    });
    const client = new ActioSprintClient({ request } as never, (p) => (p === "CC" ? binding : null), ["CC"], "https://actio.example");
    expect((await client.aggregate("CC")).teams).toEqual([]);
    expect(await client.sprintTasks("CC", "s1")).toEqual([{ id: "t1", title: "x", status: "open", assignee: "u", due: null, url: "https://actio.example/tasks/t1" }]);
    expect(String(request.mock.calls[1]![2])).toContain("sprint_id=s1");
    expect(await client.findTask("t1")).toEqual({ project: "CC", assigneeId: "u" });
    await expect(client.aggregate("Other")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("カリオペ: 取れた素材だけ集め、 生成は失敗を null にする", async () => {
    const materials = new CalliopeMaterials({
      projects: [{ code: "CC", name: "CC", repoPath: null, breviariumProject: "CC", actioProject: "CC", praeformaProjectId: null }],
      anatomia: { resolveProjectId: vi.fn(), fetchBusinessDomainView: vi.fn() } as never,
      http: { request: vi.fn(async () => ({ state: "ok" })) },
      clock: { now: () => new Date("2026-11-26T00:00:00.000Z") },
    });
    const collected = await materials.collect("CC");
    expect(collected.map((m) => m.name)).toEqual(["breviarium.overview"]);
    expect(await materials.collect("Unknown")).toEqual([]);
    expect(await new OneShotCalliopeWriter(async () => ({ ok: false, stdout: "" })).write("p")).toBeNull();
    expect(await new OneShotCalliopeWriter(async () => ({ ok: true, stdout: "{}" })).write("p")).toBe("{}");
  });
});

describe("PR フックの受け口 (backend → モジュール DB)", () => {
  it("対象リポの PR だけジョブに積む", () => {
    resetSharedGlabUnityStore();
    const dbPath = join(mkdtempSync(join(tmpdir(), "glab-unity-hub-")), "hub.sqlite");
    const config = resolveGlabUnityHubConfig({ specRepos: [{ repo: "LUDIARS/CookieClicker", project: "CC", praeformaProjectId: "pf1" }] }, { GLAB_UNITY_HUB_DB_PATH: dbPath }, "/x");
    const payload = { action: "synchronize", pull_request: { number: 3, title: "t", html_url: "https://github.com/LUDIARS/CookieClicker/pull/3", head: { sha: "0123456789abcdef" } } };
    expect(enqueueGlabSpecDraft("LUDIARS/CookieClicker", payload, () => config)).toBe(true);
    expect(enqueueGlabSpecDraft("LUDIARS/CookieClicker", payload, () => config)).toBe(false);
    expect(enqueueGlabSpecDraft("LUDIARS/Other", payload, () => config)).toBe(false);
    expect(sharedGlabUnityStore(config).claimJob(new Date().toISOString())).toMatchObject({ number: 3 });
    resetSharedGlabUnityStore();
  });
});

describe("Discord gateway の整形", () => {
  it("Webhook を使えないときの名乗りと、 メッセージの写し", () => {
    expect(unityPrefixed("neco", "hi")).toBe("neco (Unity): hi");
    const summary = toMessageSummary({
      id: "m", content: "c", createdAt: new Date("2026-11-26T00:00:00.000Z"),
      attachments: new Map([["a", { name: "x.png", url: "https://cdn.example/x.png" }]]) as never,
      reference: { messageId: "r" } as never, author: { globalName: null, username: "u" } as never, member: null,
    });
    expect(summary).toEqual({ id: "m", authorName: "u", content: "c", createdAt: "2026-11-26T00:00:00.000Z", attachments: [{ name: "x.png", url: "https://cdn.example/x.png" }], replyTo: "r" });
  });
});
