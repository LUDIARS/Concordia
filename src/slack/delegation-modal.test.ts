import { describe, it, expect } from "vitest";
import {
  buildDelegationModalView,
  parseDelegationModalSubmit,
  parseDelegationSelectAction,
  DELEGATION_MODAL_CALLBACK_ID,
  DELEGATION_TEMPLATE_ACTION,
  type DelegationTemplateLite,
} from "./delegation-modal.js";

const TEMPLATES: DelegationTemplateLite[] = [
  {
    call_name: "impl-from-design",
    title: "設計書から実装 (Codex)",
    description: "設計書を渡して実装委託",
    target_provider: "codex",
    model: null,
    default_cwd: "${target_repo}",
    input_schema: [
      { name: "design_path", type: "string", required: true, description: "設計書パス" },
      { name: "target_repo", type: "string", required: true },
      { name: "context_extra", type: "string", required: false },
    ],
  },
  {
    call_name: "task-process",
    title: "タスク処理",
    target_provider: "claude",
    model: "opus",
    default_cwd: null,
    input_schema: [{ name: "verbose", type: "boolean", required: false, default: true }],
  },
];

type View = {
  callback_id?: string;
  submit?: unknown;
  private_metadata?: string;
  blocks: Array<{ type: string; block_id?: string; elements?: Array<{ action_id?: string; options?: unknown[] }> }>;
};

describe("buildDelegationModalView", () => {
  it("テンプレ未選択は select のみ・submit 無し", () => {
    const v = buildDelegationModalView(TEMPLATES) as unknown as View;
    expect(v.callback_id).toBe(DELEGATION_MODAL_CALLBACK_ID);
    expect(v.submit).toBeUndefined();
    const select = v.blocks[0].elements?.[0];
    expect(select?.action_id).toBe(DELEGATION_TEMPLATE_ACTION);
    expect(select?.options).toHaveLength(2);
  });

  it("テンプレ選択後は input_schema を input block 化 + cwd + submit + private_metadata", () => {
    const v = buildDelegationModalView(TEMPLATES, TEMPLATES[0]) as unknown as View;
    expect(v.submit).toBeDefined();
    const meta = JSON.parse(v.private_metadata ?? "{}");
    expect(meta.call_name).toBe("impl-from-design");
    expect(meta.inputs.map((i: { name: string }) => i.name)).toEqual(["design_path", "target_repo", "context_extra"]);
    const argBlocks = v.blocks.filter((b) => b.block_id?.startsWith("arg:")).map((b) => b.block_id);
    expect(argBlocks).toEqual(["arg:design_path", "arg:target_repo", "arg:context_extra"]);
    expect(v.blocks.some((b) => b.block_id === "cwd_block")).toBe(true);
  });

  it("${} を含む default_cwd は cwd の初期値にしない", () => {
    const v = buildDelegationModalView(TEMPLATES, TEMPLATES[0]) as unknown as {
      blocks: Array<{ block_id?: string; element?: { initial_value?: string } }>;
    };
    const cwd = v.blocks.find((b) => b.block_id === "cwd_block");
    expect(cwd?.element?.initial_value).toBeUndefined();
  });
});

describe("parseDelegationSelectAction", () => {
  it("テンプレ select の選択値を返す", () => {
    const body = {
      type: "block_actions",
      actions: [{ action_id: DELEGATION_TEMPLATE_ACTION, selected_option: { value: "task-process" } }],
    };
    expect(parseDelegationSelectAction(body)).toBe("task-process");
  });
  it("別の action / 別 type は null", () => {
    expect(parseDelegationSelectAction({ type: "block_actions", actions: [{ action_id: "cc_answer:1:0" }] })).toBeNull();
    expect(parseDelegationSelectAction({ type: "view_submission" })).toBeNull();
  });
});

describe("parseDelegationModalSubmit", () => {
  const view = (privateMeta: object, values: Record<string, unknown>) => ({
    private_metadata: JSON.stringify(privateMeta),
    state: { values },
  });

  it("string / number / boolean を型に沿って coerce し cwd を拾う", () => {
    const v = view(
      { call_name: "t", inputs: [
        { name: "a", type: "string", required: true },
        { name: "n", type: "number", required: false },
        { name: "b", type: "boolean", required: false },
      ] },
      {
        "arg:a": { v: { value: "hello" } },
        "arg:n": { v: { value: "42" } },
        "arg:b": { v: { selected_option: { value: "false" } } },
        cwd_block: { v: { value: "E:/x" } },
      },
    );
    expect(parseDelegationModalSubmit(v)).toEqual({
      call_name: "t",
      args: { a: "hello", n: 42, b: false },
      cwd: "E:/x",
    });
  });

  it("空入力は args に載せない・cwd 空は undefined", () => {
    const v = view(
      { call_name: "t", inputs: [{ name: "a", type: "string", required: false }] },
      { "arg:a": { v: { value: "  " } }, cwd_block: { v: { value: "" } } },
    );
    expect(parseDelegationModalSubmit(v)).toEqual({ call_name: "t", args: {}, cwd: undefined });
  });

  it("private_metadata 不正は null", () => {
    expect(parseDelegationModalSubmit({ private_metadata: "not-json", state: { values: {} } })).toBeNull();
    expect(parseDelegationModalSubmit({})).toBeNull();
  });
});
