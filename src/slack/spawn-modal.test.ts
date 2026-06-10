import { describe, it, expect } from "vitest";
import { buildSpawnModalView, parseSpawnModalState, SPAWN_MODAL_CALLBACK_ID } from "./spawn-modal.js";

describe("buildSpawnModalView", () => {
  it("modal で callback_id と provider/cwd の input を持つ", () => {
    const v = buildSpawnModalView() as {
      type: string; callback_id: string;
      blocks: Array<{ block_id?: string; element?: { type?: string; options?: unknown[] } }>;
    };
    expect(v.type).toBe("modal");
    expect(v.callback_id).toBe(SPAWN_MODAL_CALLBACK_ID);
    const provider = v.blocks.find((b) => b.block_id === "provider_block");
    expect(provider?.element?.type).toBe("static_select");
    expect(provider?.element?.options).toHaveLength(2); // claude / codex
    const cwd = v.blocks.find((b) => b.block_id === "cwd_block");
    expect(cwd?.element?.type).toBe("plain_text_input");
  });
});

describe("parseSpawnModalState", () => {
  const view = (provider?: string, cwd?: string) => ({
    state: {
      values: {
        provider_block: { provider: { selected_option: provider ? { value: provider } : undefined } },
        cwd_block: { cwd: { value: cwd } },
      },
    },
  });

  it("provider と cwd を取り出す", () => {
    expect(parseSpawnModalState(view("codex", "E:/x"))).toEqual({ provider: "codex", cwd: "E:/x" });
  });
  it("cwd 空白は undefined に丸める", () => {
    expect(parseSpawnModalState(view("claude", "  "))).toEqual({ provider: "claude", cwd: undefined });
  });
  it("state が無い view は空オブジェクト", () => {
    expect(parseSpawnModalState({})).toEqual({});
    expect(parseSpawnModalState(null)).toEqual({});
  });
});
