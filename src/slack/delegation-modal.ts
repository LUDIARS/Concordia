// `/co-spawn`（引数なし）で開く「delegation テンプレ選択 → 起動」モーダル。
// 単一モーダル + 起動ボタン常設。テンプレ select は dispatch_action 付きの input ブロックで、
// 選ぶと views.update でそのテンプレの input_schema 入力欄が増える（起動ボタンは最初から在る）。
// 作業ディレクトリ（ワークスペースルート直下）と初回注入プロンプトも選べる。
// view_submission を parseDelegationModalSubmit() で {call_name, args, cwd, extra_prompt} に戻し、
// bot.ts が /v1/delegation/invoke {spawn:true} に流す。spec/feature/slack-platform.md §co-spawn。

import type { InputSchemaItem } from "../db/delegation-repo.js";

/** delegation モーダルの callback_id（view_submission 振り分けキー）。 */
export const DELEGATION_MODAL_CALLBACK_ID = "concordia_delegation_modal";
/** テンプレ select の action_id（block_actions で views.update する目印）。 */
export const DELEGATION_TEMPLATE_ACTION = "delegation_template";

const TEMPLATE_BLOCK = "delegation_template_block";
const CWD_BLOCK = "cwd_block";
const PROMPT_BLOCK = "prompt_block";
const FIELD_ACTION = "v";
const ARG_BLOCK_PREFIX = "arg:";

// 作業ディレクトリ選択で兼ねるため、入力欄としては描画しない引数名。
// （多くのテンプレは default_cwd=`${target_repo}` で、cwd と同一を期待する。）
const CWD_ALIAS_ARG = "target_repo";

/** モーダル描画に必要なテンプレの最小 shape（/v1/delegation/templates のシリアライズ結果）。 */
export interface DelegationTemplateLite {
  call_name: string;
  title: string;
  description?: string;
  target_provider: string;
  model?: string | null;
  default_cwd?: string | null;
  input_schema?: InputSchemaItem[];
}

/** ワークスペースルート直下から選ぶ作業ディレクトリ候補（bot.ts が fs scan して渡す）。 */
export interface WorkdirOption {
  label: string;
  value: string;
}

/** private_metadata に載せる、submit 解析に必要な最小情報。 */
interface DelegationModalMeta {
  call_name: string;
  inputs: Array<Pick<InputSchemaItem, "name" | "type" | "required">>;
}

/** text を max 字に丸める。 */
function clip(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** テンプレ一覧から static_select の options を組む。 */
function templateOptions(templates: DelegationTemplateLite[]): unknown[] {
  return templates.slice(0, 100).map((t) => ({
    text: { type: "plain_text", text: clip(t.title || t.call_name, 75) },
    value: t.call_name,
    ...(t.description ? { description: { type: "plain_text", text: clip(t.description, 75) } } : {}),
  }));
}

/** 選択中テンプレの option（initial_option 用）。 */
function selectedOption(t: DelegationTemplateLite): Record<string, unknown> {
  return { text: { type: "plain_text", text: clip(t.title || t.call_name, 75) }, value: t.call_name };
}

/** boolean 入力用の true/false static_select element。 */
function boolElement(def: unknown): Record<string, unknown> {
  const yes = { text: { type: "plain_text", text: "true" }, value: "true" };
  const no = { text: { type: "plain_text", text: "false" }, value: "false" };
  return {
    type: "static_select",
    action_id: FIELD_ACTION,
    options: [yes, no],
    ...(def === true ? { initial_option: yes } : def === false ? { initial_option: no } : {}),
  };
}

/** input_schema 1 項目 → Slack input block。 */
function argBlock(item: InputSchemaItem): Record<string, unknown> {
  const required = item.required && item.default === undefined;
  const label = clip(item.description ? `${item.name} — ${item.description}` : item.name, 150);
  const element =
    item.type === "boolean"
      ? boolElement(item.default)
      : {
          type: "plain_text_input",
          action_id: FIELD_ACTION,
          ...(item.type === "number" ? { placeholder: { type: "plain_text", text: "数値" } } : {}),
          ...(item.default !== undefined ? { initial_value: String(item.default) } : {}),
        };
  return {
    type: "input",
    block_id: `${ARG_BLOCK_PREFIX}${item.name}`,
    optional: !required,
    label: { type: "plain_text", text: label },
    element,
  };
}

/** テンプレ select（dispatch_action 付き input ブロック、必須）。 */
function templateSelectBlock(templates: DelegationTemplateLite[], selected?: DelegationTemplateLite | null): Record<string, unknown> {
  return {
    type: "input",
    block_id: TEMPLATE_BLOCK,
    dispatch_action: true,
    label: { type: "plain_text", text: "テンプレート" },
    element: {
      type: "static_select",
      action_id: DELEGATION_TEMPLATE_ACTION,
      placeholder: { type: "plain_text", text: "テンプレートを選択" },
      options: templateOptions(templates),
      ...(selected ? { initial_option: selectedOption(selected) } : {}),
    },
  };
}

/** 作業ディレクトリ select（任意）。候補が無ければ null。 */
function workdirBlock(workdirs: WorkdirOption[]): Record<string, unknown> | null {
  if (!workdirs.length) return null;
  return {
    type: "input",
    block_id: CWD_BLOCK,
    optional: true,
    label: { type: "plain_text", text: "作業ディレクトリ (任意)" },
    element: {
      type: "static_select",
      action_id: FIELD_ACTION,
      placeholder: { type: "plain_text", text: "ワークスペースから選択" },
      options: workdirs.slice(0, 100).map((w) => ({
        text: { type: "plain_text", text: clip(w.label, 75) },
        value: w.value,
      })),
    },
  };
}

/** 初回注入プロンプト（任意、複数行）。 */
function promptBlock(): Record<string, unknown> {
  return {
    type: "input",
    block_id: PROMPT_BLOCK,
    optional: true,
    label: { type: "plain_text", text: "初回注入プロンプト (任意)" },
    element: {
      type: "plain_text_input",
      action_id: FIELD_ACTION,
      multiline: true,
      placeholder: { type: "plain_text", text: "起動直後に渡す追加指示" },
    },
  };
}

/**
 * delegation モーダル view を組む（純粋）。起動ボタンは常設。
 *  - selected 未指定: テンプレ select + 作業ディレクトリ + 初回プロンプト + 起動。
 *  - selected 指定  : 上記に加え、そのテンプレの input_schema 入力欄（target_repo は除外）。
 */
export function buildDelegationModalView(
  templates: DelegationTemplateLite[],
  workdirs: WorkdirOption[],
  selected?: DelegationTemplateLite | null,
): Record<string, unknown> {
  const blocks: unknown[] = [templateSelectBlock(templates, selected)];

  const shownInputs = (selected?.input_schema ?? []).filter((i) => i.name !== CWD_ALIAS_ARG);
  if (selected) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `\`${selected.call_name}\` → ${selected.model ? `${selected.target_provider} · ${selected.model}` : selected.target_provider}`,
      }],
    });
    for (const item of shownInputs) blocks.push(argBlock(item));
  }

  const wd = workdirBlock(workdirs);
  if (wd) blocks.push(wd);
  blocks.push(promptBlock());

  const meta: DelegationModalMeta = {
    call_name: selected?.call_name ?? "",
    inputs: shownInputs.map((i) => ({ name: i.name, type: i.type, required: i.required })),
  };
  return {
    type: "modal",
    callback_id: DELEGATION_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "委託セッション起動" },
    submit: { type: "plain_text", text: "起動" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks,
  };
}

/** block_actions の body からテンプレ select の選択 call_name を取り出す（純粋）。対象外は null。 */
export function parseDelegationSelectAction(body: unknown): string | null {
  const b = body as {
    type?: string;
    actions?: Array<{ action_id?: string; selected_option?: { value?: string } }>;
  };
  if (b?.type !== "block_actions") return null;
  const a = b.actions?.find((x) => x.action_id === DELEGATION_TEMPLATE_ACTION);
  if (!a) return null;
  return a.selected_option?.value?.trim() || null;
}

type StateValues = Record<string, Record<string, {
  value?: string;
  selected_option?: { value?: string };
}>>;

/** view から submit に必要な値（{call_name, args, cwd, extra_prompt}）を取り出す（純粋）。 */
export function parseDelegationModalSubmit(view: unknown): {
  call_name: string;
  args: Record<string, unknown>;
  cwd?: string;
  extra_prompt?: string;
} | null {
  const v = view as { private_metadata?: string; state?: { values?: StateValues } };
  const values: StateValues = v?.state?.values ?? {};
  let meta: DelegationModalMeta | null = null;
  try { meta = JSON.parse(v?.private_metadata ?? ""); } catch { meta = null; }

  // call_name は select の現在値を最優先（private_metadata より新しい可能性があるため）。
  const call_name =
    values[TEMPLATE_BLOCK]?.[DELEGATION_TEMPLATE_ACTION]?.selected_option?.value?.trim() ||
    meta?.call_name ||
    "";
  if (!call_name) return null;

  const args: Record<string, unknown> = {};
  for (const item of meta?.inputs ?? []) {
    const cell = values[`${ARG_BLOCK_PREFIX}${item.name}`]?.[FIELD_ACTION];
    if (!cell) continue;
    if (item.type === "boolean") {
      const sel = cell.selected_option?.value;
      if (sel === "true") args[item.name] = true;
      else if (sel === "false") args[item.name] = false;
      continue;
    }
    const raw = (cell.value ?? "").trim();
    if (!raw) continue;
    if (item.type === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) args[item.name] = n;
    } else {
      args[item.name] = raw;
    }
  }
  const cwd = values[CWD_BLOCK]?.[FIELD_ACTION]?.selected_option?.value?.trim() || undefined;
  const extra_prompt = values[PROMPT_BLOCK]?.[FIELD_ACTION]?.value?.trim() || undefined;
  return { call_name, args, cwd, extra_prompt };
}
