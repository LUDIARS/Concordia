/**
 * delegation の初期プロンプトに前置きする「Concordia 文脈」ブロックの描画。
 *
 * 委託先 (Codex / Claude / Gemini) のセッションは Concordia が spawn した協調セッション
 * であり、 prompt file は spawn 前に書くため、 ここで文脈説明を載せて起動直後から
 * 協調作法が効くようにする。 spec/delegation.md §4。
 */

import { ASK_MARKER_RULE } from "../taskflow/task-instructions.js";

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
 * @param commandPatternBlock  Genius command-pattern の整形済みブロック
 *                      (delegation/command-patterns.ts)。 マニュアルの直後に置く。
 * @param teamRules     選択チームの委託ルール。 作業姿勢と独立して同じ文脈へ差し込む。
 * @param prRules       選択チームの typed PR ルール (teams §3.1 A層)。 base branch 案内を
 *                      ヒューリスティック推測からチーム設定優先に切り替える。
 */
export function buildDelegationContext(
  concordiaUrl = "http://127.0.0.1:11111",
  manual?: DelegationManual | null,
  commandPatternBlock?: string | null,
  teamRules?: { team: string; rules: string } | null,
  prRules?: { base: string; push: "revisor" } | null,
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
    ...workPostureLines(),
    "### 作業が終わったらコミットする (重要)",
    "",
    "- 承認された作業が完了 / 一段落したら、 変更を **必ずコミットしてください** (未コミットのまま",
    "  放置しない)。 これは上記『勝手に作業しない』の例外ではなく、 与えられた作業を仕上げる一部です。",
    "  Codex はコミットを忘れがちなので、 「動いた/直した」 で止めず必ずコミットまで行います。",
    "- ブランチ運用 (作業ブランチで作業 → push → PR) は委託プロンプト / Cc workflow の completion",
    "  ルールに従います。 コミットメッセージは『何を・なぜ』が分かる粒度で書きます。",
    "- 起動後は最新の origin base から新規 worktree を作成して実装します。" + (
      prRules?.base
        ? `base はこのチームの設定により \`${prRules.base}\` に固定します。PR base も同じにします。`
        : "base は origin/develop があれば develop、無ければ main とし、PR base も同じにします。"
    ),
    "- ユーザが明示的に指示しない限り、単体・統合・動作・起動を含むテストを実行しません。",
    "- 実装完了の責務は commit + push + PR + delegation status 報告までです。PR 作成後は停止します。",
    "- ユーザが明示的に指示しない限り、merge・squash merge・auto-merge・main 更新を行いません。",
    "",
    "### 終わったら自分でセッションを閉じる (重要)",
    "",
    "- 完了 (または partial/failed) の status 報告まで終えたら、 **その場で session-end してください**。",
    "  待機して次の指示を待つ / 別のタスクを自分で探して着手する、 のどちらもしません。",
    "- 追加でやるべきことに気づいたら、 自分で始めずに status 報告の `remaining` へ書いて終了します。",
    "- 終了処理は「作業ブランチのコミット + Revisor local PR 提出 + status 報告 → session-end」の順です。",
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
    // 質問の作法は taskflow/task-instructions.ts が正本 (実装 inject の受け入れ条件節と共用)。
    // 経路ごとに書くと片方だけ古くなり、 対話 picker で止まる事故が戻る (2026-09-05 問題ログ)。
    `- ${ASK_MARKER_RULE}`,
    "- 前提が不足しても原則は質問せず『前提未確定』として PR 本文と completed/partial 報告へ明記します。質問は権限・破壊的操作の判断に限ります。",
    "- If additional injected instructions arrive, continue from them and keep the same run id.",
    "",
  );

  lines.push("---", "");
  return lines.join("\n");
}

/**
 * 作業姿勢。 通常の不明点では止まらず自分で決めて進み、 停止してよいのは外部権限と
 * 本当に不可逆な選択の 2 つだけ、 とする。
 *
 * 以前の「方針が複数あり得るなら着手前に承認を待つ」 は、 委託先 (特に Claude/Opus) が
 * 初回ターンで質問を返して止まる原因だった。 委託元は答えを持っていないので、 その質問は
 * 誰にも解けず run が宙に浮く。 段階注入 (調査ブリーフ) はその回避策だったが、 段階自体が
 * 別の停止点になったため 2026-08-21 に廃止し、 姿勢の側を一本化した。
 */
function workPostureLines(): string[] {
  return [
    "### 通常の不明点で停止しない (重要)",
    "",
    "- どのファイルを触るか / 命名 / 実装順序 / テストの粒度 / 既存実装の意図 といった不明点は、",
    "  **コードと spec を根拠に自分で決めて進めます**。 ユーザや親セッションに聞いて止まらないでください。",
    "- コードの配置・既存実装・影響範囲は **Anatomia の解析グラフ**から引きます",
    "  (`/anatomia-analyze` の supply → CLI の `find` / `where` / `context`)。 事前の調査報告は要りません。",
    "- 停止して質問してよいのは次の 2 つだけです。 いずれも調べた事実を根拠として添えます。",
    "  - **外部権限が必要**なとき (未取得の credential、 外部サービスへの書き込み、 リポジトリ外への公開)",
    "  - **本当に不可逆な選択**のとき (データ破壊、 履歴書き換え、 公開済み成果物の削除)",
    "- 上記に当たる事項も、 まずは status 報告の detail / PR 本文へ書いて作業自体は完走させます。",
    "",
  ];
}
