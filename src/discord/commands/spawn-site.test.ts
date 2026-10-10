import { describe, expect, it, vi } from "vitest";
import {
  buildSiteSpawnRequest,
  decideSpawnTarget,
  executeSiteSpawn,
  HQ_SPAWN_TARGET,
  siteSpawnFailureMessage,
  siteSpawnInputError,
  spawnTargetMenu,
  type SpawnResponder,
} from "./spawn-site.js";
import type { SpawnSitePort } from "../command-port.js";

const melpot = { siteId: "melpot", name: "MELPOT" };
const gromac = { siteId: "gromac", name: "GROMAC" };
const assigned: Record<string, Array<{ siteId: string; name: string }>> = { Mp: [melpot], Pa: [melpot, gromac] };
const forProject = (project: string) => assigned[project] ?? [];

describe("decideSpawnTarget (2026-10-07 neco: タグ / プロジェクトで自動 / 決まらなければ選択)", () => {
  it("prefers an explicit site", () => {
    expect(decideSpawnTarget({ site: "gromac", project: "Mp", sitesForProject: forProject })).toEqual({ kind: "site", site: "gromac", via: "explicit" });
  });
  it("routes to the only site assigned to the project", () => {
    expect(decideSpawnTarget({ project: "Mp", sitesForProject: forProject })).toEqual({ kind: "site", site: "melpot", via: "project" });
  });
  it("asks when several sites are assigned", () => {
    expect(decideSpawnTarget({ project: "Pa", sitesForProject: forProject })).toEqual({ kind: "choose", candidates: [melpot, gromac] });
  });
  it("stays at HQ for unassigned projects, task-linked spawns, no project, or no federation", () => {
    expect(decideSpawnTarget({ project: "Fg", sitesForProject: forProject })).toEqual({ kind: "hq" });
    expect(decideSpawnTarget({ project: "Mp", task: "12", sitesForProject: forProject })).toEqual({ kind: "hq" });
    expect(decideSpawnTarget({ sitesForProject: forProject })).toEqual({ kind: "hq" });
    expect(decideSpawnTarget({ project: "Mp" })).toEqual({ kind: "hq" });
  });
});

describe("site spawn request", () => {
  it("builds the title from the prompt's first line and carries spawn options", () => {
    expect(buildSiteSpawnRequest({ provider: "claude", inject: false, prompt: "\n  Pagus を起動\n詳細", project: "Pa", effort: "high", branch: "main" }))
      .toEqual({ title: "Pagus を起動", body: "\n  Pagus を起動\n詳細", options: { provider: "claude", project: "Pa", effort: "high", branch: "main" } });
    expect(buildSiteSpawnRequest({ template: "opus-mid", inject: true, cwd: "D:/LUDIARS/Pagus", effort: "bogus" }))
      .toEqual({ title: "opus-mid D:/LUDIARS/Pagus", body: "", options: { template: "opus-mid", inject_prompt: true, cwd: "D:/LUDIARS/Pagus" } });
  });
  it("requires provider/template and a project or cwd for provider spawns", () => {
    expect(siteSpawnInputError({ inject: false, project: "Pa" })).toContain("provider");
    expect(siteSpawnInputError({ provider: "claude", inject: false })).toContain("project");
    expect(siteSpawnInputError({ provider: "claude", inject: false, project: "Pa" })).toBeNull();
    expect(siteSpawnInputError({ template: "opus-mid", inject: false })).toBeNull();
  });
  it("explains every route failure", () => {
    for (const reason of ["unknown_site", "inactive_site", "ambiguous_site", "listener_unavailable"] as const) {
      expect(siteSpawnFailureMessage(reason).length).toBeGreaterThan(0);
    }
  });
  it("offers the assigned sites plus HQ in the target menu", () => {
    const menu = spawnTargetMenu("spawn-target:1", "Pa", [melpot, gromac]);
    expect(menu.content).toContain("Pa");
    expect(menu.components[0]!.toJSON().components[0]).toMatchObject({
      custom_id: "spawn-target:1",
      options: [expect.objectContaining({ value: "melpot" }), expect.objectContaining({ value: "gromac" }), expect.objectContaining({ value: HQ_SPAWN_TARGET })],
    });
  });
});

describe("executeSiteSpawn", () => {
  function responder(inThread: boolean) {
    const thread = { id: "999999999999999999", name: "Pagus", setName: vi.fn(async () => undefined) };
    const reply = { startThread: vi.fn(async () => thread) };
    const ix = {
      reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(), fetchReply: vi.fn(async () => reply),
      channel: { isThread: () => inThread }, channelId: "111111111111111110", guildId: "111111111111111111", user: { id: "333333333333333333" },
    };
    return { ix: ix as unknown as SpawnResponder & typeof ix, reply, thread };
  }
  const port = (result: ReturnType<SpawnSitePort["route"]>) => ({ list: () => [], forProject: () => [], route: vi.fn(() => result) });
  const log = () => ({ info: vi.fn(), warn: vi.fn() });

  it("creates a thread outside threads and hands the spawn to the site", async () => {
    const { ix, reply, thread } = responder(false);
    const sites = port({ ok: true, siteId: "melpot", siteName: "MELPOT" });
    await executeSiteSpawn(ix, sites, "melpot", { provider: "claude", inject: false, prompt: "Pagus", project: "Pa" }, log());
    expect(reply.startThread).toHaveBeenCalled();
    expect(sites.route).toHaveBeenCalledWith(expect.objectContaining({ site: "melpot", channelId: thread.id, title: "Pagus", options: { provider: "claude", project: "Pa" } }));
    expect(ix.editReply).toHaveBeenLastCalledWith({ content: expect.stringContaining("MELPOT") });
    expect(thread.setName).toHaveBeenCalledWith("[M] Pagus");
  });

  it("reuses the current thread and reports a route failure without spawning at HQ", async () => {
    const { ix, reply } = responder(true);
    const sites = port({ ok: false, reason: "listener_unavailable" });
    await executeSiteSpawn(ix, sites, "melpot", { template: "opus-mid", inject: false }, log());
    expect(reply.startThread).not.toHaveBeenCalled();
    expect(sites.route).toHaveBeenCalledWith(expect.objectContaining({ channelId: ix.channelId }));
    expect(ix.editReply).toHaveBeenLastCalledWith({ content: expect.stringContaining("listener") });
  });

  it("rejects incomplete input before touching Discord threads", async () => {
    const { ix } = responder(false);
    const sites = port({ ok: true, siteId: "melpot", siteName: "MELPOT" });
    await executeSiteSpawn(ix, sites, "melpot", { provider: "claude", inject: false }, log());
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(sites.route).not.toHaveBeenCalled();
  });
});
