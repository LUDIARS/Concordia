import { afterEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import { handleTestForumControl, type TestForumActionDeps } from "./test-forum-actions.js";

function row(overrides: Partial<DiscordTestSurfaceRow> = {}): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: "sha-1",
    repo_root_path: "E:/Document/Ars/Concordia",
    head_branch: "feat/test-forum",
    worktree_path: "E:/wt",
    thread_id: "thread",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
    content_hash: null,
    qa_run_id: null,
    run_state: "testing",
    provider: "codex",
    model: "sol",
    effort: "xhigh",
    session_id: "session-1",
    local_pr_id: null,
    controls_message_id: "controls",
    check_status: "test_ok",
    ...overrides,
  };
}

function button(userId = "user-1") {
  return {
    user: { id: userId },
    isButton: () => true,
    isStringSelectMenu: () => false,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

function select(value: string, userId = "user-1") {
  return {
    user: { id: userId },
    values: [value],
    isButton: () => false,
    isStringSelectMenu: () => true,
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
}

function deps(surface: DiscordTestSurfaceRow, overrides: Partial<TestForumActionDeps> = {}) {
  const state = { ...surface };
  const surfaces = {
    listOpen: vi.fn(() => [state]),
    findOpen: vi.fn(() => state),
    create: vi.fn(),
    close: vi.fn(),
    updateRunConfig: vi.fn(),
    markStarting: vi.fn(() => {
      if (state.run_state !== "candidate") return false;
      state.run_state = "starting";
      return true;
    }),
    resetStarting: vi.fn(() => {
      if (state.run_state === "starting" && !state.session_id) state.run_state = "candidate";
    }),
    markTesting: vi.fn(),
    setLocalPrId: vi.fn((_id: number, localPrId: string) => { state.local_pr_id = localPrId; }),
    markMerged: vi.fn(() => { state.run_state = "merged"; }),
    setControlsMessageId: vi.fn(),
  } as unknown as DiscordTestSurfacesRepo;
  const revisor = {
    listLocalPrs: vi.fn(async () => [
      { id: "local-1", number: 42, repository: "LUDIARS/Concordia" },
    ]),
    baseUrl: vi.fn(async () => "http://127.0.0.1:4240"),
    mergeLocalPr: vi.fn(async () => undefined),
  };
  return {
    state,
    surfaces,
    revisor,
    deps: {
      concordiaUrl: "http://127.0.0.1:17330",
      workspaceRoots: ["E:/Document/Ars"],
      surfaces,
      revisor,
      isLaunchUserAllowed: () => true,
      isMergeUserAllowed: () => true,
      log: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    } as unknown as TestForumActionDeps,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("handleTestForumControl merge", () => {
  it("refuses to merge for a user without the roster capability", async () => {
    const h = deps(row(), { isMergeUserAllowed: () => false });
    const interaction = button();
    await handleTestForumControl(interaction as unknown as ButtonInteraction, { action: "merge", surfaceId: 7 }, h.deps);
    expect(h.revisor.mergeLocalPr).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("fails closed when no capability check is wired at all", async () => {
    const h = deps(row(), { isMergeUserAllowed: undefined });
    const interaction = button();
    await handleTestForumControl(interaction as unknown as ButtonInteraction, { action: "merge", surfaceId: 7 }, h.deps);
    expect(h.revisor.mergeLocalPr).not.toHaveBeenCalled();
  });

  it("resolves the Revisor local PR by repo and number, merges, then clears the controls", async () => {
    const h = deps(row());
    const interaction = button();
    await handleTestForumControl(interaction as unknown as ButtonInteraction, { action: "merge", surfaceId: 7 }, h.deps);
    expect(h.surfaces.setLocalPrId).toHaveBeenCalledWith(7, "local-1");
    expect(h.revisor.mergeLocalPr).toHaveBeenCalledWith("local-1");
    expect(h.state.run_state).toBe("merged");
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it("rejects a merge before the test session started", async () => {
    const h = deps(row({ run_state: "candidate" }));
    const interaction = button();
    await handleTestForumControl(interaction as unknown as ButtonInteraction, { action: "merge", surfaceId: 7 }, h.deps);
    expect(h.revisor.mergeLocalPr).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it("refuses to start a test for a user without the roster capability", async () => {
    const h = deps(row({ run_state: "candidate" }), { isLaunchUserAllowed: () => false });
    const interaction = button();
    await handleTestForumControl(interaction as unknown as ButtonInteraction, { action: "start", surfaceId: 7 }, h.deps);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("refuses to start a test when the safe repository or branch target is missing", async () => {
    const h = deps(row({ run_state: "candidate", repo_root_path: null, head_branch: null }));
    const interaction = button();
    await handleTestForumControl(interaction as unknown as ButtonInteraction, { action: "start", surfaceId: 7 }, h.deps);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("refuses to change the run configuration without the spawn capability", async () => {
    // 実行設定はそのまま特権 spawn の引数になる。 未配線なら fail-closed。
    const h = deps(row({ run_state: "candidate" }), { isLaunchUserAllowed: undefined });
    const interaction = select("claude:opus");
    await handleTestForumControl(
      interaction as unknown as StringSelectMenuInteraction,
      { action: "provider", surfaceId: 7 },
      h.deps,
    );
    expect(h.surfaces.updateRunConfig).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("clamps an effort the newly chosen provider cannot honor", async () => {
    const h = deps(row({ run_state: "candidate", effort: "minimal" }));
    await handleTestForumControl(
      select("claude:opus") as unknown as StringSelectMenuInteraction,
      { action: "provider", surfaceId: 7 },
      h.deps,
    );
    expect(h.surfaces.updateRunConfig)
      .toHaveBeenCalledWith(7, { provider: "claude", model: "opus", effort: "high" });
  });

  it("rejects an effort that is not valid for the current provider", async () => {
    const h = deps(row({ run_state: "candidate", provider: "claude", model: "opus", effort: "high" }));
    const interaction = select("minimal");
    await handleTestForumControl(
      interaction as unknown as StringSelectMenuInteraction,
      { action: "effort", surfaceId: 7 },
      h.deps,
    );
    expect(h.surfaces.updateRunConfig).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("sends the effort under the option key the chosen provider reads", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, pid: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = deps(row({ run_state: "candidate", provider: "claude", model: "opus", effort: "high" }));

    await handleTestForumControl(
      button() as unknown as ButtonInteraction,
      { action: "start", surfaceId: 7 },
      h.deps,
    );

    // claude レーンは `effort` を読む (model_reasoning_effort は codex 系)。
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).options).toEqual({ effort: "high" });
  });

  it("starts from the workspace root and tells the session its target", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, pid: 123 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = deps(row({ run_state: "candidate", worktree_path: null }));
    const interaction = button();

    await handleTestForumControl(
      interaction as unknown as ButtonInteraction,
      { action: "start", surfaceId: 7 },
      h.deps,
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      cwd: "E:/Document/Ars",
      test_surface_id: 7,
    });
    const body = JSON.parse(String(request.body));
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("worktree");
    expect(body.prompt).toContain("E:/Document/Ars/Concordia");
    expect(body.prompt).toContain("feat/test-forum");
    expect(body.prompt).toContain("このセッションの責務は検証と報告だけ");
    expect(body.prompt).not.toContain("CONCORDIA_REVISOR_WORKFLOW_TOKEN");
    expect(h.state.run_state).toBe("starting");
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("reserves the surface before spawn so concurrent requests cannot launch another session", async () => {
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const fetchMock = vi.fn(async () => {
      await responseGate;
      return new Response(JSON.stringify({ ok: true, pid: 123 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = deps(row({ run_state: "candidate", session_id: null }));

    const first = handleTestForumControl(
      button() as unknown as ButtonInteraction,
      { action: "start", surfaceId: 7 },
      h.deps,
    );
    await vi.waitFor(() => expect(h.state.run_state).toBe("starting"));
    await handleTestForumControl(
      button() as unknown as ButtonInteraction,
      { action: "start", surfaceId: 7 },
      h.deps,
    );
    releaseResponse();
    await first;

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
