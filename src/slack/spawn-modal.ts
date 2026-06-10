// `/spawn`（引数なし）/ `/concordia spawn`（引数なし）で開く spawn フォームのモーダル。
// provider ドロップダウン + 作業ディレクトリ入力だけの最小フォーム。view_submission を
// parseSpawnModalState() で {provider, cwd} に戻して slash.ts の spawnSession() に流す。
// Enterprise Grid / Workflow Builder のカスタムステップ無しで「フォームから spawn」を実現する。

/** spawn モーダルの callback_id（view_submission の振り分けキー）。 */
export const SPAWN_MODAL_CALLBACK_ID = "concordia_spawn_modal";

const PROVIDER_BLOCK = "provider_block";
const PROVIDER_ACTION = "provider";
const CWD_BLOCK = "cwd_block";
const CWD_ACTION = "cwd";

/** Slack Modal view ペイロード（views.open / 返却用）。型は薄く保つ。 */
export function buildSpawnModalView(): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: SPAWN_MODAL_CALLBACK_ID,
    title: { type: "plain_text", text: "セッション起動" },
    submit: { type: "plain_text", text: "起動" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: PROVIDER_BLOCK,
        label: { type: "plain_text", text: "Provider" },
        element: {
          type: "static_select",
          action_id: PROVIDER_ACTION,
          initial_option: { text: { type: "plain_text", text: "claude" }, value: "claude" },
          options: [
            { text: { type: "plain_text", text: "claude" }, value: "claude" },
            { text: { type: "plain_text", text: "codex" }, value: "codex" },
          ],
        },
      },
      {
        type: "input",
        block_id: CWD_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "作業ディレクトリ (任意)" },
        element: {
          type: "plain_text_input",
          action_id: CWD_ACTION,
          placeholder: { type: "plain_text", text: "例: E:\\Document\\Ars\\Cernere" },
        },
      },
    ],
  };
}

/** view_submission の state から {provider, cwd} を取り出す（純粋）。欠落は undefined。 */
export function parseSpawnModalState(view: unknown): { provider?: string; cwd?: string } {
  const values = (view as { state?: { values?: Record<string, Record<string, {
    selected_option?: { value?: string };
    value?: string;
  }>> } })?.state?.values;
  if (!values) return {};
  const provider = values[PROVIDER_BLOCK]?.[PROVIDER_ACTION]?.selected_option?.value;
  const cwd = values[CWD_BLOCK]?.[CWD_ACTION]?.value;
  return {
    provider: provider?.trim() || undefined,
    cwd: cwd?.trim() || undefined,
  };
}
