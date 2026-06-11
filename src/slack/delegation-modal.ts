// `/co-spawn`（引数なし）で開く「delegation テンプレ選択 → 起動」モーダル。
// 2 段構成: ① テンプレ select（選ぶと views.update で②へ）→ ② 選んだテンプレの
// input_schema を入力フォーム化 + 作業ディレクトリ。view_submission を
// parseDelegationModalSubmit() で {call_name, args, cwd} に戻し、bot.ts が
// /v1/delegation/invoke {spawn:true} に流す。spec/feature/slack-platform.md §co-spawn。

import type { InputSchemaItem } from "../db/delegation-repo.js";

/** delegation モーダルの callback_id（view_submission 振り分けキー）。 */
export const DELEGATION_MODAL_CALLBACK_ID = "concordia_delegation_modal";
/** テンプレ select の action_id（block_actions で views.update する目印）。 */
export const DELEGATION_TEMPLATE_ACTION = "delegation_template";

const TEMPLATE_BLOCK = "delegation_template_block";
const CWD_BLOCK = "cwd_block";
const FIELD_ACTION = "v";
const ARG_BLOCK_PREFIX = "arg:";

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

/** private_metadata に載せる、submit 解析に必要な最小情報。 */
interface DelegationModalMeta {
  call_name: string;
  inputs: Array<Pick<InputSchemaItem, "name" | "type" | "required">>;
}

/** title を 75 字に丸める（static_select option text の上限）。 */
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

/** boolean 入力用の yes/no static_select element。 */
function boolElement(action: string, def: unknown): Record<string, unknown> {
  const yes = { text: { type: "plain_text", text: "true" }, value: "true" };
  const no = { text: { type: "plain_text", text: "false" }, value: "false" };
  return {
    type: "static_select",
    action_id: action,
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
      ? boolElement(FIELD_ACTION, item.default)
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

/**
 * delegation モーダル view を組む（純粋）。
 *  - selected 未指定: テンプレ select だけ（submit 無し → 選択で views.update）。
 *  - selected 指定  : select + その input_schema 入力欄 + 作業ディレクトリ + submit。
 */
export function buildDelegationModalView(
  templates: DelegationTemplateLite[],
  selected?: DelegationTemplateLite | null,
): Record<string, unknown> {
  const selectBlock = {
    type: "actions",
    block_id: TEMPLATE_BLOCK,
    elements: [
      {
        type: "static_select",
        action_id: DELEGATION_TEMPLATE_ACTION,
        placeholder: { type: "plain_text", text: "テンプレートを選択" },
        options: templateOptions(templates),
        ...(selected
          ? {
              initial_option: {
                text: { type: "plain_text", text: clip(selected.title || selected.call_name, 75) },
                value: selected.call_name,
              },
            }
          : {}),
      },
    ],
  };

  const blocks: unknown[] = [selectBlock];

  if (!selected) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "起動するテンプレートを選ぶと入力欄が出ます。" }],
    });
    // submit 無し: 選択 → views.update で②へ進む。
    return {
      type: "modal",
      callback_id: DELEGATION_MODAL_CALLBACK_ID,
      title: { type: "plain_text", text: "委託セッション起動" },
      close: { type: "plain_text", text: "キャンセル" },
      blocks,
    };
  }

  const provider = selected.model ? `${selected.target_provider} · ${selected.model}` : selected.target_provider;
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `\`${selected.call_name}\` → ${provider}` }],
  });
  for (const item of selected.input_schema ?? []) blocks.push(argBlock(item));
  blocks.push({
    type: "input",
    block_id: CWD_BLOCK,
    optional: true,
    label: { type: "plain_text", text: "作業ディレクトリ (任意)" },
    element: {
      type: "plain_text_input",
      action_id: FIELD_ACTION,
      placeholder: { type: "plain_text", text: "例: E:\\Document\\Ars\\Cernere" },
      ...(selected.default_cwd && !selected.default_cwd.includes("${")
        ? { initial_value: selected.default_cwd }
        : {}),
    },
  });

  const meta: DelegationModalMeta = {
    call_name: selected.call_name,
    inputs: (selected.input_schema ?? []).map((i) => ({ name: i.name, type: i.type, required: i.required })),
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
  const a = b.actions?.[0];
  if (a?.action_id !== DELEGATION_TEMPLATE_ACTION) return null;
  return a.selected_option?.value?.trim() || null;
}

/** view_submission の state + private_metadata から {call_name, args, cwd} を取り出す（純粋）。 */
export function parseDelegationModalSubmit(view: unknown): {
  call_name: string;
  args: Record<string, unknown>;
  cwd?: string;
} | null {
  const v = view as {
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, {
      value?: string;
      selected_option?: { value?: string };
    }>> };
  };
  let meta: DelegationModalMeta;
  try {
    meta = JSON.parse(v?.private_metadata ?? "");
  } catch {
    return null;
  }
  if (!meta?.call_name) return null;
  const values = v?.state?.values ?? {};
  const args: Record<string, unknown> = {};
  for (const item of meta.inputs ?? []) {
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
  const cwd = values[CWD_BLOCK]?.[FIELD_ACTION]?.value?.trim() || undefined;
  return { call_name: meta.call_name, args, cwd };
}
