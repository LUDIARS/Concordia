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
 * 起動直後の振る舞い方針。
 *
 * - `approval` (既定): 従来どおり。 方針が複数あり得るなら着手前にユーザ承認を待つ。
 * - `investigation`: 段階注入の第1段階。 まず調べる。 通常の不明点で停止しない。
 *   実装タスクは調査報告のあとに後追いで届く (staged-injection.ts)。
 *
 * 両者は同時に成立しない。 `approval` の文言 (「方針が複数あり得る/影響が大きいなら
 * 承認を待つ」) を残したまま調査ブリーフを渡すと、 委託先は矛盾を安全側に解釈して
 * 初回ターンで質問を返し停止する。 ここで排他に切り替えるのはそのため。
 */
export type DelegationPosture = "approval" | "investigation";

/**
 * delegation prompt の冒頭に差し込む context ブロックを組み立てる。
 *
 * @param concordiaUrl  協調 API のベース URL (既定 http://127.0.0.1:11111)
 * @param manual        kind 別作業マニュアル。 渡されたら先頭付近に
 *                      「## 作業マニュアル (kind: …)」節として差し込む。
 * @param commandPatternBlock  Genius command-pattern の整形済みブロック
 *                      (delegation/command-patterns.ts)。 マニュアルの直後に置く。
 * @param posture       起動直後の振る舞い方針 (既定 approval)。
 * @param teamRules     選択チームの委託ルール。 posture と独立して同じ文脈へ差し込む。
 */
export function buildDelegationContext(
  concordiaUrl = "http://127.0.0.1:11111",
  manual?: DelegationManual | null,
  commandPatternBlock?: string | null,
  posture: DelegationPosture = "approval",
  teamRules?: { team: string; rules: string } | null,
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

  // Genius command-pattern (定型作業のコマンド列)。 task 文面に一致した手順を最初から
  // 渡し、 弱いモデルが自前手順を組み立てて処理がばらつくのを防ぐ (push 型注入)。
  if (commandPatternBlock && commandPatternBlock.trim()) {
    lines.push(commandPatternBlock.trim(), "");
  }

  if (teamRules?.rules.trim()) {
    lines.push(`## Team rules (${teamRules.team})`, "", teamRules.rules.trim(), "");
  }

  lines.push(
    "### 起動後の振る舞い (重要)",
    "",
    "- 委託プロンプトを読んだら、 **着手する前に「これから何をするか」を 1〜3 行で報告**して",
    "  ください (どのファイル/モジュールに、 どんな順序で手を入れるか)。 挨拶や inject を受けた",
    "  直後も同様に、 まず受領と次の一手を短く宣言してから動きます。",
    "- 報告のあとに実作業へ進みます。 委託元/ユーザはこの宣言を見て次の行動を取ります。",
    "",
    ...(posture === "investigation" ? investigationPostureLines() : approvalPostureLines()),
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
    "- Revisor 提出用の PR 内容は対象リポの spec/tasks/ にある当該 session の task md から生成されます。# タイトル、## 目的、## 完了条件を日本語で空欄なく設計してください。",
    "",
  );

  lines.push(
    "## Delegation status / inject protocol (required)",
    "",
    "- The spawn environment includes CONCORDIA_DELEGATION_RUN_ID. When the task is completed or failed, you MUST call:",
    `  POST ${concordiaUrl}/v1/delegation/runs/$CONCORDIA_DELEGATION_RUN_ID/status`,
    '  with JSON {"status":"completed","detail":"...","result":"...","acceptance_report":[]} or {"status":"partial","remaining":[{"title":"...","note":"...","scope_dirs":[]}]} or {"status":"failed","detail":"..."} before ending.',
    "- If approval or clarification is needed, ask the parent session through the delegation status/inject flow, not directly in Discord.",
    "- 前提が不足しても原則は質問せず『前提未確定』として PR 本文と completed/partial 報告へ明記します。質問は権限・破壊的操作の判断に限ります。",
    "- If additional injected instructions arrive, continue from them and keep the same run id.",
    "",
  );

  lines.push("---", "");
  return lines.join("\n");
}

/** 既定 (承認待ち) の姿勢。 段階注入を使わない委託はこれまでどおりこちら。 */
function approvalPostureLines(): string[] {
  return [
    "### 勝手に作業しない (重要)",
    "",
    "- **明確な指示・承認がないまま実作業 (コード変更 / ファイル作成・削除 / コミット / 外部送信",
    "  など) を勝手に始めないでください。** 委託プロンプトで与えられた範囲を超える追加作業も同様。",
    "- 方針が複数あり得る / スコープが曖昧 / 影響が大きい場合は、 着手前に方針を 1〜3 行で示して",
    "  ユーザの承認を待ちます。 「やっておきました」 ではなく 「こう進めてよいですか」 が既定。",
    "- 調査・読み取りは進めてよいですが、 変更を伴う一歩はユーザの GO を確認してから踏み出します。",
    "",
  ];
}

/**
 * 段階注入 (第1段階) の姿勢。 「まず調べる」 を既定にし、 停止してよい条件を
 * 2 つに限定する。 approval 版の 「方針が複数あり得るなら承認を待つ」 とは併存させない。
 */
function investigationPostureLines(): string[] {
  return [
    "### まず調べる — 通常の不明点で停止しない (重要)",
    "",
    "- この委託は **調査 → 実装** の 2 段階です。 いま渡されているのは調査ブリーフで、",
    "  実装タスク本文・理由・完了条件は調査報告のあとに Concordia が inject します。",
    "- 調査中に出てくる通常の不明点 (どのファイルか / 命名 / 実装順序 / テストの粒度 / 既存実装の意図)",
    "  は、 **コードと spec を根拠に自分で判断して進めます**。 ユーザや親セッションに質問して停止しないでください。",
    "- 停止して質問してよいのは次の 2 つだけです。 いずれも調べた事実を根拠として添えます。",
    "  - **外部権限が必要**なとき (未取得の credential、 外部サービスへの書き込み、 リポジトリ外への公開)",
    "  - **本当に不可逆な選択**のとき (データ破壊、 履歴書き換え、 公開済み成果物の削除)",
    "- 上記に当たる事項も、 まず調査報告の `blockers` に載せて調査自体は完走させます。",
    "- 調査の範囲では変更を伴う一歩 (コード変更・コミット) を踏み出しません。 実装は第 2 段階が届いてからです。",
    "",
  ];
}
