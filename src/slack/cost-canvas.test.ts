import { describe, it, expect, vi } from "vitest";
import { applyCostCanvas, SLACK_TS_FORMAT, COST_CANVAS_KEY, COST_CANVAS_TITLE } from "./cost-canvas.js";
import type { CostCanvasClient } from "./cost-canvas.js";

/** in-memory の slack_config 相当 + fake Slack canvas client を作る。 */
function makeHarness(opts?: { editThrows?: boolean }) {
  const store = new Map<string, string>();
  const editCalls: { canvas_id: string; markdown: string }[] = [];
  const createCalls: { channel_id: string; title?: string; markdown: string }[] = [];
  const client: CostCanvasClient = {
    canvases: {
      edit: vi.fn(async (args) => {
        if (opts?.editThrows) throw new Error("canvas_not_found");
        editCalls.push({ canvas_id: args.canvas_id, markdown: args.changes[0].document_content.markdown });
        return { ok: true };
      }),
    },
    conversations: {
      canvases: {
        create: vi.fn(async (args) => {
          createCalls.push({ channel_id: args.channel_id, title: args.title, markdown: args.document_content.markdown });
          return { ok: true, canvas_id: "C_NEW" };
        }),
      },
    },
  };
  const deps = {
    client,
    channelId: "CH1",
    configGet: (k: string) => store.get(k) ?? null,
    configSet: (k: string, v: string) => void store.set(k, v),
    configDelete: (k: string) => void store.delete(k),
  };
  return { store, editCalls, createCalls, client, deps };
}

describe("applyCostCanvas", () => {
  it("canvas_id 未保存なら channel canvas を作成し id を保存する", async () => {
    const h = makeHarness();
    await applyCostCanvas("# body", h.deps);
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({ channel_id: "CH1", title: COST_CANVAS_TITLE, markdown: "# body" });
    expect(h.store.get(COST_CANVAS_KEY)).toBe("C_NEW");
    expect(h.editCalls).toHaveLength(0);
  });

  it("canvas_id 保存済みなら edit で同じ Canvas を上書きし、 再作成しない", async () => {
    const h = makeHarness();
    h.store.set(COST_CANVAS_KEY, "C_EXISTING");
    await applyCostCanvas("# updated", h.deps);
    expect(h.editCalls).toHaveLength(1);
    expect(h.editCalls[0]).toMatchObject({ canvas_id: "C_EXISTING", markdown: "# updated" });
    expect(h.createCalls).toHaveLength(0);
    // id は据え置き
    expect(h.store.get(COST_CANVAS_KEY)).toBe("C_EXISTING");
  });

  it("edit 失敗時は保存 id を捨てて作り直す", async () => {
    const h = makeHarness({ editThrows: true });
    h.store.set(COST_CANVAS_KEY, "C_DEAD");
    await applyCostCanvas("# body", h.deps);
    // edit 失敗 → create にフォールバックし新 id を保存
    expect(h.createCalls).toHaveLength(1);
    expect(h.store.get(COST_CANVAS_KEY)).toBe("C_NEW");
  });
});

describe("SLACK_TS_FORMAT", () => {
  it("null は '-'、 epoch は JST 文字列で出す", () => {
    expect(SLACK_TS_FORMAT.at(null)).toBe("-");
    // 2021-01-01T00:00:00Z = JST 2021/01/01 09:00
    const s = SLACK_TS_FORMAT.at(1609459200);
    expect(s).toContain("2021");
    expect(s).toContain("JST");
  });
});
