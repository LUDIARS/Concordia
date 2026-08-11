import { describe, it, expect, vi } from "vitest";
import type { Interaction } from "discord.js";
import { handlePanelInteraction, isPanelInteraction, type PanelInteractionDeps } from "./panel-interactions.js";
import { buildPrPanelId } from "./pr-panel.js";
import { buildRwfPanelId } from "./rwf-panel.js";
import type { RwfPrMergeOutcome, RwfPrSubmitOutcome } from "../platform/reaction-workflow-pr.js";

const PR = { id: "lpr-1", number: 7, repository: "LUDIARS/Concordia", headRef: "feat/x" };

interface ReplyCall {
  content?: string;
  embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
}

function makeInteraction(customId: string, kind: "button" | "select", values: string[] = []) {
  const replies: ReplyCall[] = [];
  const interaction = {
    customId,
    user: { id: "u-1" },
    channelId: "chan-1",
    channel: null,
    values,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    reply: vi.fn(async (payload: ReplyCall) => { replies.push(payload); }),
    followUp: vi.fn(async () => { /* ignore */ }),
  };
  return { interaction: interaction as unknown as Interaction, replies };
}

function makeDeps(options: {
  submit?: RwfPrSubmitOutcome;
  merge?: RwfPrMergeOutcome;
  canMerge?: boolean;
  withOperations?: boolean;
} = {}): PanelInteractionDeps & { submit: ReturnType<typeof vi.fn>; merge: ReturnType<typeof vi.fn>; mergeSelected: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async () => options.submit ?? { ok: true, kind: "submitted", pullRequest: PR } as RwfPrSubmitOutcome);
  const merge = vi.fn(async () => options.merge ?? { ok: true, kind: "merged", pullRequest: PR, authorizerRole: "管理職" } as RwfPrMergeOutcome);
  const mergeSelected = vi.fn(async () => options.merge ?? { ok: true, kind: "merged", pullRequest: PR, authorizerRole: "管理職" } as RwfPrMergeOutcome);
  return {
    sessionsRepo: {
      findSession: () => ({
        repo_path: "E:/x",
        status: "active",
        repo_origin: "LUDIARS/Concordia",
        branch: "feat/x",
      }),
    },
    ...(options.withOperations === false ? {} : {
      prOperations: {
        submitLocalPr: submit,
        mergeLocalPr: merge,
        mergeSelectedLocalPr: mergeSelected,
        listOpenLocalPrs: async () => [{ ...PR, status: "open", checkStatus: "test_ok" }],
      },
    }),
    isMergeUserAllowed: () => options.canMerge ?? true,
    log: { info: () => { /* silent */ }, warn: () => { /* silent */ } },
    submit,
    merge,
    mergeSelected,
  };
}

function replyText(reply: ReplyCall): string {
  return reply.content ?? reply.embeds?.map((e) => `${e.toJSON().title ?? ""}\n${e.toJSON().description ?? ""}`).join("\n") ?? "";
}

describe("isPanelInteraction", () => {
  it("claims only its own namespaces", () => {
    expect(isPanelInteraction(makeInteraction(buildPrPanelId("submit", "s1"), "button").interaction)).toBe(true);
    expect(isPanelInteraction(makeInteraction(buildRwfPanelId("actions", "m1"), "button").interaction)).toBe(true);
    expect(isPanelInteraction(makeInteraction("ctrl:end:s1", "button").interaction)).toBe(false);
  });
});

describe("PR panel interactions", () => {
  it("submits through the same operations port as the reaction", async () => {
    const deps = makeDeps();
    const { interaction, replies } = makeInteraction(buildPrPanelId("submit", "sess-1"), "button");

    expect(await handlePanelInteraction(interaction, deps)).toBe(true);
    expect(deps.submit).toHaveBeenCalledWith({ sessionId: "sess-1", actor: { userId: "u-1" } });
    expect(replyText(replies[0])).toContain("local PR #7");
  });

  it("merges the session branch PR when the button is pressed", async () => {
    const deps = makeDeps();
    const { interaction, replies } = makeInteraction(buildPrPanelId("merge", "sess-1"), "button");

    await handlePanelInteraction(interaction, deps);
    expect(deps.merge).toHaveBeenCalled();
    expect(replyText(replies[0])).toContain("マージしました");
  });

  it("merges the PR chosen in the select menu", async () => {
    const deps = makeDeps();
    const { interaction } = makeInteraction(buildPrPanelId("select", "sess-1"), "select", ["lpr-9"]);

    await handlePanelInteraction(interaction, deps);
    expect(deps.mergeSelected).toHaveBeenCalledWith({
      sessionId: "sess-1",
      localPrId: "lpr-9",
      actor: { userId: "u-1" },
    });
  });

  it("refuses to merge without the merge_pr capability", async () => {
    const deps = makeDeps({ canMerge: false });
    const { interaction, replies } = makeInteraction(buildPrPanelId("merge", "sess-1"), "button");

    await handlePanelInteraction(interaction, deps);
    expect(deps.merge).not.toHaveBeenCalled();
    expect(replyText(replies[0])).toContain("merge_pr 権限");
  });

  it("still allows submitting without the merge capability (submission is not destructive)", async () => {
    const deps = makeDeps({ canMerge: false });
    const { interaction } = makeInteraction(buildPrPanelId("submit", "sess-1"), "button");

    await handlePanelInteraction(interaction, deps);
    expect(deps.submit).toHaveBeenCalled();
  });

  it("says so when PR operations are not wired", async () => {
    const deps = makeDeps({ withOperations: false });
    const { interaction, replies } = makeInteraction(buildPrPanelId("submit", "sess-1"), "button");

    await handlePanelInteraction(interaction, deps);
    expect(replyText(replies[0])).toContain("有効になっていません");
  });
});

describe("RWF panel interactions", () => {
  it("opens the action select panel", async () => {
    const deps = makeDeps();
    const { interaction, replies } = makeInteraction(buildRwfPanelId("actions", "m-1"), "button");

    expect(await handlePanelInteraction(interaction, deps)).toBe(true);
    expect(replyText(replies[0])).toContain("リアクションワークフローを選ぶ");
  });

  it("runs the chosen action through the reaction workflow runner", async () => {
    const handle = vi.fn(async (_input: { dedupeKey: string; emoji: string; userId: string }) => { /* ignore */ });
    const deps = { ...makeDeps(), reactionWorkflow: { handle } };
    const { interaction } = makeInteraction(buildRwfPanelId("choose", "m-1"), "select", ["submit-pr"]);

    await handlePanelInteraction(interaction, deps);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][0]).toMatchObject({
      dedupeKey: "m-1",
      emoji: "📮",
      userId: "u-1",
    });
  });

  it("rejects an unknown workflow action", async () => {
    const handle = vi.fn(async (_input: { dedupeKey: string; emoji: string; userId: string }) => { /* ignore */ });
    const deps = { ...makeDeps(), reactionWorkflow: { handle } };
    const { interaction, replies } = makeInteraction(buildRwfPanelId("choose", "m-1"), "select", ["not-an-action"]);

    await handlePanelInteraction(interaction, deps);
    expect(handle).not.toHaveBeenCalled();
    expect(replyText(replies[0])).toContain("未知のワークフロー");
  });
});
