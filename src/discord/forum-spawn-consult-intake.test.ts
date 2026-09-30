/**
 * 部署フォーラムからの技術相談の事前ヒアリング (spec/feature/tech-consultation.md §3)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { consultIntakeReplyBlock } from "../dialogue/intake.js";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import { executeForumSpawn, type ForumSpawnDepartment, type ForumSpawnDeps, type ForumSpawnThread } from "./forum-spawn.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";

const MANAGED_TAG = { id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME };

function thread(body = "DDD を採用する利点を教えてください"): ForumSpawnThread {
  return {
    id: "123456789012345678",
    guildId: "guild-1",
    parentId: "forum-qa",
    ownerId: "123456789",
    name: "DDD って何が良いの",
    appliedTags: [],
    availableTags: [MANAGED_TAG],
    fetchStarterMessage: vi.fn(async () => ({ content: body })),
    fetchTagState: vi.fn(async () => ({ appliedTags: [], availableTags: [MANAGED_TAG] })),
  };
}

function department(patch: Partial<ForumSpawnDepartment> = {}): ForumSpawnDepartment {
  return { id: "dept-qa", name: "技術相談課", projects: [], hasLaunchDefault: true, archived: false, intake: true, ...patch };
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

function spawnBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

describe("forum spawn consultation intake", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the missing premises in the thread before launching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const d = deps();

    expect(await executeForumSpawn(d, thread())).toEqual({ ok: false, error: "consultation intake requested" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.requestIntake).toHaveBeenCalledWith(expect.objectContaining({
      missing: ["consultation"],
      consultationQuestion: expect.stringContaining("技術レベル:"),
    }));
  });

  it("asks only for the purpose when the requester defaults cover level and role", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const d = deps({ consultIntakeDefaults: () => ({ skill_level: "中級", role_title: "エンジニア" }) });

    await executeForumSpawn(d, thread());
    const question = vi.mocked(d.requestIntake!).mock.calls[0]?.[0].consultationQuestion ?? "";
    expect(question).toContain("目的:");
    expect(question).not.toContain("技術レベル: (");
    expect(question).toContain("技術レベル「中級」");
  });

  it("launches with the intake once the reply supplies the premises", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, pid: 7 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const d = deps();
    const body = `DDD を採用する利点を教えてください\n\n${consultIntakeReplyBlock("初級、デザイナー、知りたいだけ")}`;

    expect(await executeForumSpawn(d, thread(), { title: "DDD って何が良いの", body })).toEqual({ ok: true });
    expect(d.requestIntake).not.toHaveBeenCalled();
    expect(spawnBody(fetchMock)).toMatchObject({
      department: "dept-qa",
      consultation_intake: {
        topic: "DDD って何が良いの",
        skill_level: "初級",
        role_title: "デザイナー",
        purpose: "知りたいだけ",
        source: "forum",
      },
    });
  });

  it("does not ask when the department's use case has no intake", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, pid: 7 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const d = deps({ department: department({ intake: false }) });

    expect(await executeForumSpawn(d, thread())).toEqual({ ok: true });
    expect(spawnBody(fetchMock)).not.toHaveProperty("consultation_intake");
  });

  it("gives up instead of appending answers to already-approved content", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const d = deps();

    expect(await executeForumSpawn(d, thread(), { title: "DDD って何が良いの", body: "利点は?", approved: true }))
      .toEqual({ ok: false, error: "approved content incomplete" });
    expect(d.requestIntake).not.toHaveBeenCalled();
    expect(d.postToThread).toHaveBeenCalledWith("123456789012345678", expect.stringContaining("相談の前提"));
  });
});
