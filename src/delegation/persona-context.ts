/**
 * delegation の初期プロンプトに前置きする「Concordia 文脈」ブロックの描画。
 *
 * 委託先 (Codex / Claude / Gemini) のセッションは Concordia が spawn した協調セッション
 * であり、 prompt file は spawn 前に書くため、 ここで文脈説明を載せて起動直後から
 * 協調作法が効くようにする。 spec/delegation.md §4。
 */

/** 協調コンテキストへ差し込む kind 別の作業マニュアル (inject_manuals 由来)。 */
export interface DelegationManual {
  kind: string;
  content: string;
}

/**
 * delegation prompt の冒頭に差し込む context ブロックを組み立てる。
 *
 * @param concordiaUrl  協調 API のベース URL (既定 http://127.0.0.1:11111)
 * @param manual        kind 別作業マニュアル。 渡されたら先頭付近に
 *                      「## 作業マニュアル (kind: …)」節として差し込む。
 */
export function buildDelegationContext(
  concordiaUrl = "http://127.0.0.1:11111",
  manual?: DelegationManual | null,
): string {
  const lines: string[] = [
    "## Concordia コンテキスト (この委託セッションについて)",
    "",
    "あなたは LUDIARS の **Concordia** (multi-agent session coordinator) が spawn した",
    "協調セッションです。 単独で動く CLI ではなく、 複数 AI セッションが横断的に協調する",
    "チームの一員として起動しています。",
    "",
    `- 協調 API は \`${concordiaUrl}\` (loopback)。 \`concordia\` skill が hook 経由で連携を案内します。`,
    "- 他セッションの状況は `GET /v1/stat`、 雑談は chitchat channel で共有されます。",
    "",
  ];

  // kind 別作業マニュアル (WebUI /manuals で調整可)。 kind ごとに作業手順が違う
  // (例: レビューは worktree 生成・ブランチ切替不要) ため、 固定文言より先に置く。
  if (manual && manual.content.trim()) {
    lines.push(
      `## 作業マニュアル (kind: ${manual.kind})`,
      "",
      manual.content.trim(),
      "",
    );
  }

  lines.push(
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
    "### 作業が終わったらコミットする (重要)",
    "",
    "- 承認された作業が完了 / 一段落したら、 変更を **必ずコミットしてください** (未コミットのまま",
    "  放置しない)。 これは上記『勝手に作業しない』の例外ではなく、 与えられた作業を仕上げる一部です。",
    "  Codex はコミットを忘れがちなので、 「動いた/直した」 で止めず必ずコミットまで行います。",
    "- ブランチ運用 (作業ブランチで作業 → push → PR) は委託プロンプト / Cc workflow の completion",
    "  ルールに従います。 コミットメッセージは『何を・なぜ』が分かる粒度で書きます。",
    "- 起動後は最新の origin base から新規 worktree を作成して実装します。base は origin/develop があれば",
    "  develop、無ければ main とし、PR base も同じにします。",
    "- ユーザが明示的に指示しない限り、単体・統合・動作・起動を含むテストを実行しません。",
    "- 実装完了の責務は commit + push + PR + delegation status 報告までです。PR 作成後は停止します。",
    "- ユーザが明示的に指示しない限り、merge・squash merge・auto-merge・main 更新を行いません。",
    "",
    "### 子タスクは Cc Delegation で起動する (重要)",
    "",
    "- sub-agent / child task が必要な場合、Codex/Claude 固有の子エージェント起動機能は使いません。",
    "- `delegation_list_templates` で対象を選び、`delegation_invoke` を `spawn: true` で呼びます。",
    "- `parent_session_id` は現在の `CONCORDIA_SESSION_ID` とし、委託するタスクを `task` / `problem`",
    "  / `design_path` のいずれかへ短く明記します。これが親セッション情報カードの記録になります。",
    "- Cc Delegation tool が利用不能なら、provider 固有 child を黙って代用せず委託元へ報告します。",
    "",
  );

  lines.push(
    "## 言語ポリシー (required)",
    "",
    "- 人間が読む出力は日本語で書きます: Discord / Slack への投稿、質問 (ask)、状況報告・完了報告の文面、PR タイトル・本文。",
    "- 実装内容は効率が良ければ英語で構いません: コード、コメント、コミットメッセージ、内部の推論・ログ、子委託へのプロンプト。",
    "",
  );

  lines.push(
    "## Delegation status / inject protocol (required)",
    "",
    "- The spawn environment includes CONCORDIA_DELEGATION_RUN_ID. When the task is completed or failed, you MUST call:",
    `  POST ${concordiaUrl}/v1/delegation/runs/$CONCORDIA_DELEGATION_RUN_ID/status`,
    '  with JSON {"status":"completed","detail":"...","result":"..."} or {"status":"failed","detail":"..."} before ending.',
    "- If approval or clarification is needed, ask the parent session through the delegation status/inject flow, not directly in Discord.",
    "- If additional injected instructions arrive, continue from them and keep the same run id.",
    "",
  );

  lines.push("---", "");
  return lines.join("\n");
}
