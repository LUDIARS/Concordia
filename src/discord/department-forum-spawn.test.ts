/**
 * 部署フォーラムへの投稿からの起動 (spec/feature/departments.md §9.3)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import { executeForumSpawn, type ForumSpawnDepartment, type ForumSpawnDeps, type ForumSpawnThread } from "./forum-spawn.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";

const MANAGED_TAG = { id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME };

function thread(): ForumSpawnThread {
  return {
    id: "thread-qa",
    guildId: "guild-1",
    parentId: "forum-qa",
    ownerId: "123456789",
    name: "DDD って何が良いの",
    appliedTags: [],
    availableTags: [MANAGED_TAG],
    fetchStarterMessage: vi.fn(async () => ({ content: "DDD を採用する利点を教えてください" })),
    fetchTagState: vi.fn(async () => ({ appliedTags: [], availableTags: [MANAGED_TAG] })),
  };
}

function department(patch: Partial<ForumSpawnDepartment> = {}): ForumSpawnDepartment {
  return { id: "dept-qa", name: "技術相談課", projects: [], hasLaunchDefault: true, archived: false, ...patch };
}

function deps(patch: Partial<ForumSpawnDeps> = {}): ForumSpawnDeps {
  const templates: DelegationTemplateLite[] = [];
  return {
    sessionForumId: "forum-qa",
    department: department(),
    botUserId: "987654321",
    concordiaUrl: "http://127.0.0.1:17320",
    isLaunchUserAllowed: () => true,
    templates: vi.fn(async () => templates),
    selectTemplate: vi.fn(async () => ({ ok: false as const, error: "none" })),
    resolveProjectTarget: () => null,
    requestIntake: vi.fn(async () => true),
    resolveUserDisplayName: vi.fn(async () => "neco"),
    hasExistingRun: () => false,
    postToThread: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...patch,
  };
}

describe("department forum spawn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("launches with the department defaults without asking for a project or model", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, pid: 7 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const d = deps();

    expect(await executeForumSpawn(d, thread())).toEqual({ ok: true });

    expect(d.requestIntake).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      department: "dept-qa",
      requester_discord_user_id: "123456789",
      requester_display_name: "neco",
      source_discord_channel_id: "thread-qa",
    });
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("template");
    expect(body).not.toHaveProperty("project");
    expect(d.postToThread).toHaveBeenCalledWith("thread-qa", expect.stringContaining("部署「技術相談課」の"));
  });

  it("asks for the model when the department has no launch default", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const d = deps({ department: department({ hasLaunchDefault: false }) });

    expect(await executeForumSpawn(d, thread())).toEqual({ ok: false, error: "template selection requested" });
    expect(d.requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["template"] }));
  });

  it("asks for a project when the department restricts projects, and rejects others", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const restricted = deps({ department: department({ projects: ["Concordia"] }) });
    expect(await executeForumSpawn(restricted, thread())).toEqual({ ok: false, error: "missing information requested" });

    const outside = deps({
      department: department({ projects: ["Concordia"] }),
      resolveProjectTarget: () => ({ project: "Memoria", code: "Mm", cwd: "E:/Document/Ars/Memoria" }),
    });
    expect(await executeForumSpawn(outside, thread())).toEqual({ ok: false, error: "project out of department scope" });
  });

  it("keeps requiring a project inside a subsidiary", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const d = deps({ subsidiaryId: "glab", resolveSubsidiaryProjects: () => ["glab-web"] });
    expect(await executeForumSpawn(d, thread())).toEqual({ ok: false, error: "missing information requested" });
  });

  it("launches a projectless consultation inside a subsidiary without picking up a project (tech-consultation.md §6)", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, pid: 8 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // 本文のプロジェクト名が解決できても、 相談部署では拾わない (関係プロジェクト外の拒否にも回さない)。
    const d = deps({
      subsidiaryId: "glab",
      resolveSubsidiaryProjects: () => [],
      department: department({ projectless: true }),
      resolveProjectTarget: () => ({ project: "Concordia", code: "Cc", cwd: "E:/Document/Ars/Concordia" }),
    });

    expect(await executeForumSpawn(d, thread())).toEqual({ ok: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ department: "dept-qa", subsidiary_id: "glab" });
    expect(body).not.toHaveProperty("project");
  });

  it("does not treat a projectless department as projectless when the flag is off in a subsidiary", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const d = deps({ subsidiaryId: "glab", resolveSubsidiaryProjects: () => [], department: department({ projectless: false }) });
    expect(await executeForumSpawn(d, thread())).toEqual({ ok: false, error: "missing information requested" });
  });

  it("does not launch from an archived department", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const d = deps({ department: department({ archived: true }) });
    expect(await executeForumSpawn(d, thread())).toEqual({ ok: false, error: "department archived" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.postToThread).toHaveBeenCalledWith("thread-qa", expect.stringContaining("廃止"));
  });
});
