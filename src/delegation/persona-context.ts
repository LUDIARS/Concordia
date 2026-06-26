/**
 * delegation の初期プロンプトに前置きする「Concordia 文脈 + persona」ブロックの描画。
 *
 * 委託先 (Codex / Claude / Gemini) のセッションは Concordia が spawn した協調セッション
 * であり、 起動後に persona が assign される。 ただし prompt file は spawn 前に書くため、
 * ここでは「文脈説明 + 暫定 persona の全文」を載せて、 起動直後から人格と協調作法が
 * 効くようにする。 spec/delegation.md §4。
 */

import type { PersonaRow } from "../db/personas-repo.js";

/** persona 全文ブロック (skill_template があればそれ、 無ければ最小描画)。 */
function renderPersonaBlock(persona: PersonaRow): string {
  const tmpl = (persona.skill_template ?? "").trim();
  if (tmpl) return tmpl;
  // skill_template が空の seed/旧データでも最低限の人格説明は出す。
  let traits: string[] = [];
  try {
    const arr = JSON.parse(persona.traits);
    if (Array.isArray(arr)) traits = arr.map((t) => String(t));
  } catch {
    traits = [];
  }
  return [
    `# Persona: ${persona.name}`,
    "",
    `**${persona.name}**${persona.display_name ? ` (${persona.display_name})` : ""} — ${persona.description}`,
    traits.length ? `\n特性: ${traits.join(" / ")}` : "",
    persona.speech_style ? `\n喋り方: ${persona.speech_style}` : "",
  ].join("\n");
}

/**
 * delegation prompt の冒頭に差し込む context ブロックを組み立てる。
 *
 * @param persona  暫定 persona (null なら persona ブロックは省く)
 * @param concordiaUrl  協調 API のベース URL (既定 http://127.0.0.1:11111)
 */
export function buildDelegationContext(
  persona: PersonaRow | null,
  concordiaUrl = "http://127.0.0.1:11111",
): string {
  const lines: string[] = [
    "## Concordia コンテキスト (この委託セッションについて)",
    "",
    "あなたは LUDIARS の **Concordia** (multi-agent session coordinator) が spawn した",
    "協調セッションです。 単独で動く CLI ではなく、 複数 AI セッションが横断的に協調する",
    "チームの一員として起動しています。",
    "",
    "- 起動直後に Concordia から **persona (人格役)** が割り当てられます。 人格は chitchat /",
    "  consultation / 報告 channel への投稿トーンと口調にだけ薄く影響し、 **作業の質・判断には",
    "  影響させません**。 ユーザ/委託元の指示が常に最優先です。",
    `- 協調 API は \`${concordiaUrl}\` (loopback)。 \`concordia\` skill が hook 経由で連携を案内します。`,
    "- 他セッションの状況は `GET /v1/stat`、 雑談は chitchat channel で共有されます。",
    "",
    "### 起動後の振る舞い (重要)",
    "",
    "- 委託プロンプトを読んだら、 **着手する前に「これから何をするか」を 1〜3 行で報告**して",
    "  ください (どのファイル/モジュールに、 どんな順序で手を入れるか)。 挨拶や inject を受けた",
    "  直後も同様に、 まず受領と次の一手を短く宣言してから動きます。",
    "- 報告のあとに実作業へ進みます。 委託元/ユーザはこの宣言を見て次の行動を取ります。",
    "",
    "### 勝手に作業しない (重要)",
    "",
    "- **明確な指示・承認がないまま実作業 (コード変更 / ファイル作成・削除 / コミット / 外部送信",
    "  など) を勝手に始めないでください。** 委託プロンプトで与えられた範囲を超える追加作業も同様。",
    "- 方針が複数あり得る / スコープが曖昧 / 影響が大きい場合は、 着手前に方針を 1〜3 行で示して",
    "  ユーザの承認を待ちます。 「やっておきました」 ではなく 「こう進めてよいですか」 が既定。",
    "- 調査・読み取りは進めてよいですが、 変更を伴う一歩はユーザの GO を確認してから踏み出します。",
    "",
  ];

  if (persona) {
    lines.push(
      "## 割り当て人格 (暫定)",
      "",
      "起動後に Concordia が確定する persona と異なる場合がありますが、 当面は以下の人格で",
      "口調を整えてください。",
      "",
      renderPersonaBlock(persona),
      "",
    );
  }

  lines.push("---", "");
  return lines.join("\n");
}
