/**
 * 外部エージェント用本文の共通の枠。 ジョブ固有の依頼の後に、 返し方と禁止事項を付ける。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 外部エージェント用の本文
 */

const COMMON_RULES = [
  "",
  "### 返し方",
  "",
  "- 材料は params.data だけです。 Cc・Memoria・Actio のローカル API やファイルには届かない前提で判断してください。",
  "- data.truncated があれば、 その件数分の材料が上限のため省かれています。 省かれた分は推測しないでください。",
  "- result の summary (400 文字以内) に結論を、 detail.items に項目ごとの所見 (文字列の配列) を入れて返してください。",
  "",
  "### やらないこと",
  "",
  "書き込み・通知・PR 作成・Issue 作成・外部への投稿。 反映は Cc が result を読んで行います。",
];

export function composeAgentBody(task: readonly string[]): string {
  return [...task, ...COMMON_RULES].join("\n");
}
