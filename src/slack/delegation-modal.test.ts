import { describe, it, expect } from "vitest";
import {
  buildDelegationModalView,
  parseDelegationModalSubmit,
  parseDelegationSelectAction,
  DELEGATION_MODAL_CALLBACK_ID,
  DELEGATION_TEMPLATE_ACTION,
  type DelegationTemplateLite,
  type WorkdirOption,
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

const WORKDIRS: WorkdirOption[] = [
  { label: "Cernere", value: "E:/Document/Ars/Cernere" },
  { label: "Memoria", value: "E:/Document/Ars/Memoria" },
];

type Block = {
  type: string;
  block_id?: string;
  dispatch_action?: boolean;
  element?: { action_id?: string; multiline?: boolean; options?: unknown[] };
};
type View = { callback_id?: string; submit?: unknown; private_metadata?: string; blocks: Block[] };

describe("buildDelegationModalView", () => {
  it("テンプレ未選択でも submit(起動) は常設・select は dispatch_action 必須 input", () => {
    const v = buildDelegationModalView(TEMPLATES, WORKDIRS) as unknown as View;
    expect(v.callback_id).toBe(DELEGATION_MODAL_CALLBACK_ID);
    expect(v.submit).toBeDefined();
    const sel = v.blocks[0];
    expect(sel.type).toBe("input");
    expect(sel.dispatch_action).toBe(true);
    expect(sel.element?.action_id).toBe(DELEGATION_TEMPLATE_ACTION);
    // 未選択でも作業ディレクトリ select + 初回プロンプトは出る
    expect(v.blocks.some((b) => b.block_id === "cwd_block")).toBe(true);
    expect(v.blocks.some((b) => b.block_id === "prompt_block" && b.element?.multiline === true)).toBe(true);
  });

  it("テンプレ選択後は input_schema を入力欄化するが target_repo は除外 (作業ディレクトリが兼ねる)", () => {
    const v = buildDelegationModalView(TEMPLATES, WORKDIRS, TEMPLATES[0]) as unknown as View;
    const argBlocks = v.blocks.filter((b) => b.block_id?.startsWith("arg:")).map((b) => b.block_id);
    expect(argBlocks).toEqual(["arg:design_path", "arg:context_extra"]);
    expect(argBlocks).not.toContain("arg:target_repo");
    const meta = JSON.parse(v.private_metadata ?? "{}");
    expect(meta.call_name).toBe("impl-from-design");
    expect(meta.inputs.map((i: { name: string }) => i.name)).toEqual(["design_path", "context_extra"]);
  });

  it("作業ディレクトリ候補が空なら cwd ブロックを出さない", () => {
    const v = buildDelegationModalView(TEMPLATES, []) as unknown as View;
    expect(v.blocks.some((b) => b.block_id === "cwd_block")).toBe(false);
    expect(v.submit).toBeDefined(); // それでも起動ボタンは在る
  });
});

describe("parseDelegationSelectAction", () => {
  it("テンプレ select の選択値を返す（input ブロック由来でも actions 配列に来る）", () => {
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

  it("call_name は select の現在値・cwd と初回プロンプトを拾う", () => {
    const v = view(
      { call_name: "impl-from-design", inputs: [{ name: "design_path", type: "string", required: true }] },
      {
        delegation_template_block: { delegation_template: { selected_option: { value: "impl-from-design" } } },
        "arg:design_path": { v: { value: "spec/x.md" } },
        cwd_block: { v: { selected_option: { value: "E:/Document/Ars/Cernere" } } },
        prompt_block: { v: { value: "まず設計を読んで" } },
      },
    );
    expect(parseDelegationModalSubmit(v)).toEqual({
      call_name: "impl-from-design",
      args: { design_path: "spec/x.md" },
      cwd: "E:/Document/Ars/Cernere",
      extra_prompt: "まず設計を読んで",
    });
  });

  it("number / boolean を型に沿って coerce、空入力は載せない", () => {
    const v = view(
      { call_name: "t", inputs: [
        { name: "n", type: "number", required: false },
        { name: "b", type: "boolean", required: false },
        { name: "s", type: "string", required: false },
      ] },
      {
        delegation_template_block: { delegation_template: { selected_option: { value: "t" } } },
        "arg:n": { v: { value: "42" } },
        "arg:b": { v: { selected_option: { value: "false" } } },
        "arg:s": { v: { value: "  " } },
      },
    );
    expect(parseDelegationModalSubmit(v)).toEqual({ call_name: "t", args: { n: 42, b: false }, cwd: undefined, extra_prompt: undefined });
  });

  it("select 値が無ければ private_metadata の call_name にフォールバック", () => {
    const v = view({ call_name: "fallback", inputs: [] }, {});
    expect(parseDelegationModalSubmit(v)?.call_name).toBe("fallback");
  });

  it("call_name が全く無ければ null", () => {
    expect(parseDelegationModalSubmit(view({ call_name: "", inputs: [] }, {}))).toBeNull();
    expect(parseDelegationModalSubmit({})).toBeNull();
  });
});
