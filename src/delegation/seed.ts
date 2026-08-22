/**
 * 初期 delegation テンプレート (3 本)。
 * boot 時に upsert される (call_name が存在しなければ作成、 あれば content を上書き)。
 * ユーザが GUI で is_active を 0 にすれば disable できる。
 */

import type { DelegationRepo, CreateTemplateInput } from "../db/delegation-repo.js";

const CLAUDE_TEMPLATE_SORT_ORDER = {
  "fable-5": 10,
  "opus-5": 30,
  "sonnet-5": 40,
  "haiku-4-5": 60,
} as const;

/**
 * Anatomia supply→verify を委託プロンプトの必須手順にする (2026-08-19 neco 指示:
 * 「指示内容からまずドメインを確認して設計する / どのドメインにどう紐づけるかを一緒に考えて貼る」)。
 * Claude Code の UserPromptSubmit/PostToolUse hook は Codex 委託には効かないので、テンプレ本文で縛る。
 * CLI の解決方法は委託先ごとに異なるため、ローカルの絶対パスをテンプレートへ埋め込まない。
 */
const ANATOMIA_SUPPLY_VERIFY_STEPS = [
  "- Before writing code, use the configured Anatomia CLI to ask where the change lands (`where --repo <target_repo> --task \"<what you will change>\"`, or `context`). If it is unavailable, stop and report the configuration issue; do not download or guess a local installation. Pass the repository path as a properly quoted shell argument (or an argument-array value); never interpolate it into a shell command. Design inside the existing domain/layer it reports; reuse the exemplars instead of reinventing.",
  "- Domain binding first: decide which declared domain the change belongs to. If it opens a new directory / feature surface outside every declared membership, add the declaration in the SAME PR (`spec/domains/<domain>.domain.json` or the project's documented canonical domain directory, `membership: [{ \"pathPattern\": \"(^|/)src/...\" }]`, src and tests paired) — Revisor blocks unbound code.",
  "- After implementing, run Anatomia `verify` against the PR diff with the repository path passed as a properly quoted shell argument (or an argument-array value), fix block-level gate failures before opening the PR, and mention the verify result in the PR body.",
];

function codex56Template(opts: {
  /** call_name = `codex-5-6-${callSuffix}`。 model は `gpt-5.6-${modelName}`。 */
  callSuffix: string;
  modelName: "sol" | "terra" | "luna";
  label: string;
  emoji: string;
  sort_order: number;
  /** codex の model_reasoning_effort。 ultra は Sol の最上位推論。 */
  reasoning: "medium" | "high" | "xhigh" | "ultra";
  /** fast モード (出力高速化)。 Sol の既定は high + fast (2026-07-17 neco 指示)。 */
  fastMode?: boolean;
  /**
   * codex 実行系の provider。 既定 `"codex"` は codex-cli (Lictor wrap)。
   * `"codex-sdk"` は Satelles ヘッドレスランナー経由で、 Cc 側の
   * `CONCORDIA_SATELLES_CODEX_RUNTIME=wsl` と組み合わせると WSL 内 Linux codex で
   * 走り、 Windows 版 codex の CreateProcessWithLogonW 経由 lsass ログオンセッション
   * リーク (upstream openai/codex #33356 / #35940) を回避できる。
   */
  provider?: "codex" | "codex-sdk";
}): CreateTemplateInput {
  return {
    call_name: `codex-5-6-${opts.callSuffix}`,
    title: `Implementation delegation (GPT-5.6 ${opts.label})`,
    description: `Delegate implementation work to Codex GPT-5.6 ${opts.label}.`,
    target_provider: opts.provider ?? "codex",
    model: `gpt-5.6-${opts.modelName}`,
    runtime_options: {
      model_reasoning_effort: opts.reasoning,
      ...(opts.fastMode ? { fast_mode: true } : {}),
    },
    emoji: opts.emoji,
    category: "employee",
    sort_order: opts.sort_order,
    prompt_template: [
      "Implement the following in ${target_repo}:",
      "",
      "${task}",
      "",
      "${context_extra:}", "",
      "Requirements:",
      "- Create a feature branch (feat/<short-slug>) off origin/main.",
      "- Implement as specified; don't add scope.",
      ...ANATOMIA_SUPPLY_VERIFY_STEPS,
      "- Add or update test coverage when the change needs it, but do not run tests unless the user explicitly requested them.",
      "- Make 1 PR (squash mergeable). Follow CLAUDE.md / dev-process.md.",
      "- Stop after the PR is created. Do not merge or enable auto-merge unless the user explicitly requested it.",
      "",
      "Report the PR URL when done.",
    ].join("\n"),
    input_schema: [
      { name: "task", type: "string", required: true, description: "What to implement" },
      { name: "target_repo", type: "string", required: true, description: "Absolute path of the target repository" },
      { name: "context_extra", type: "string", required: false, description: "Optional extra context to prepend" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  };
}

const CODEX_56_TEMPLATES: CreateTemplateInput[] = [
  // Sol の既定は high + fast (2026-07-17 neco 指示)。
  codex56Template({ callSuffix: "sol", modelName: "sol", label: "Sol", emoji: "☀️", sort_order: 20, reasoning: "high", fastMode: true }),
  // 最上位推論が要る難所用に Sol Ultra を明示的に用意する (同指示)。
  // provider=codex-sdk: Satelles 経由 (Cc の CONCORDIA_SATELLES_CODEX_RUNTIME=wsl と
  // 組み合わせて WSL 内 Linux codex で走らせ、 lsass リークを回避する — neco 指示)。
  codex56Template({ callSuffix: "sol-ultra", modelName: "sol", label: "Sol Ultra", emoji: "🌞", sort_order: 25, reasoning: "ultra", provider: "codex-sdk" }),
  // Terra も provider=codex-sdk: Satelles 経由で WSL 内 Linux codex を使う (neco 指示)。
  codex56Template({ callSuffix: "terra", modelName: "terra", label: "Terra", emoji: "🌏", sort_order: 50, reasoning: "xhigh", provider: "codex-sdk" }),
  codex56Template({ callSuffix: "luna", modelName: "luna", label: "Luna", emoji: "🌙", sort_order: 70, reasoning: "medium" }),
];

const FORUM_SESSION_PROMPT = [
  "Discord Session フォーラムの投稿から起動されたセッションです。",
  "追加の初回指示に含まれる Title と本文を依頼の正本として扱ってください。",
  "対象プロジェクトと作業範囲を最初に確認し、不明な場合は実装前にユーザーへ確認してください。",
].join("\n");

/** Forum 投稿本文は extra_prompt で渡るため、引数なしで安全に invoke できる既定テンプレ。 */
const FORUM_SESSION_TEMPLATES: CreateTemplateInput[] = [
  {
    call_name: "forum-claude-session",
    title: "Claude起動",
    description: "Discord Session フォーラムの投稿から Claude セッションを起動する既定テンプレート。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    prompt_template: FORUM_SESSION_PROMPT,
    input_schema: [],
    is_active: true,
    forum_tag: true,
    category: "employee",
    sort_order: 80,
    emoji: "🟣",
  },
  {
    call_name: "forum-codex-session",
    title: "Codex起動",
    description: "Discord Session フォーラムの投稿から Codex セッションを起動する既定テンプレート。",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    runtime_options: { model_reasoning_effort: "high" },
    prompt_template: FORUM_SESSION_PROMPT,
    input_schema: [],
    is_active: true,
    forum_tag: true,
    category: "employee",
    sort_order: 90,
    emoji: "🟢",
  },
];

/**
 * パートタイマー (category: "parttimer") 共通の完了時ステップ (2026-08-08 neco 指示:
 * 「パートタイマーは完了後に管理者にメンションする」)。 各テンプレの最終手順の直後に差し込む。
 * mention_user_id は Concordia の `GET /v1/admin/state` が正本 (未設定なら null)。
 */
const MENTION_ADMIN_STEP = [
  "### 完了時 (必須)",
  "- Excubitor catalog で解決した Concordia endpoint へ `GET /v1/admin/state` を投げ、`mention_user_id` を確認する。",
  "  値があれば最終報告の先頭に `<@${mention_user_id}> ` を付けて投稿する (値が null/未設定なら付けずに通常通り報告する)。",
].join("\n");

/**
 * Memoria から「関連する未完了タスク」を引く共通手順
 * (spec/feature/director-workflow.md §1。取得手順の正本は director-task-pull テンプレ)。
 * 単体テンプレ (director-task-pull) とタスク整理 (director-task-organize) が同じ定義を使う。
 */
const MEMORIA_TASK_PULL_PROCEDURE = [
  "- Memoria のポートは Excubitor catalog / ProcessMap で解決する (ハードコードしない)。",
  "- `GET /api/tasks?limit=500` で取得し、`status != done` に絞る。",
  "- topic (プロジェクトコード / カテゴリ / キーワード) との関連は title / details / category の",
  "  全文一致で判定する。プロジェクトコードは `LUDIARS/PROJECT-CODES.md` の別名 (略称・リポ名・",
  "  日本語名) も展開して突き合わせる。",
  "- 各タスクは id / title / category / due_at / 関連根拠 (どの語が一致したか) を持つ行に正規化する。",
  "- この手順は**読み取り専用**。タスクの書き換え・削除・追加はしない。",
].join("\n");

/** Provider を切り替えても日次レビューの対象・突合・保存規約を同一に保つ正本。 */
const DAILY_REVIEW_RECONCILIATION_PROMPT = [
  "## デイリー突合レビュー — ${date}",
  "",
  "あなたはオーケストレータ。レビュー本文は書かず、Codex と Claude Opus の 2 レビュアーを回して所見を突合する。",
  "",
  "### 正本 (最初に必ず読む)",
  "- 手順・プロンプト・突合ルール: `E:\\Document\\Ars\\LUDIARS\\docs\\REVIEW-PROMPTS.md`",
  "- 対象リポ: `E:\\Document\\Ars\\LUDIARS\\service-map.json` の `daily_review: true` (Tier 1)",
  "",
  "### 手順",
  "1. service-map.json から対象リポを列挙。今回 HEAD の正本は各リポのローカル `refs/heads/<default-branch>` とする。",
  "   `git fetch` / `git pull` / `origin/*` / `gh` / GitHub API は使用しない。現在 checkout 中の `HEAD` も使わない。",
  "   `git rev-parse refs/heads/<default-branch>` で SHA を固定し、その SHA から detached の一時 review worktree を作る。",
  "2. 前回レビュー日時は `E:\\Document\\Ars\\Review\\<repo>\\latest.json` の `reviewed_at` (無ければ実行日の24時間前) とする。",
  "   一時 worktree で `git log refs/heads/<default-branch> --since=<前回レビュー日時>` を確認し、期間内 commit が無ければ",
  "   スキップして「変更なし」と記録する。差分 base は latest.json の `head` が今回 main の祖先ならその SHA、",
  "   それ以外は `git rev-list -1 --before=<前回レビュー日時> refs/heads/<default-branch>` とする。",
  "   さらに `git merge-base --is-ancestor <今回HEAD> <前回HEAD>` が真になる場合 (範囲逆転: 今回 HEAD が",
  "   前回 HEAD の祖先) は、diff を作らずそのリポを",
  "   skip/no_change として記録し、理由 (range_reversed) を添えてレビュアーには一切投げない (early-exit)。",
  "3. リポごとに REVIEW-PROMPTS.md §1 の入力を一時 worktree だけから構築し、§3 のプロンプトで `codex exec` を、§4 のプロンプトで `claude -p --model claude-opus-5` を起動する (互いの所見は見せない)。",
  "4. §5 の突合ルールで機械マージ: file:line 実在検証 → ±5 行一致判定。High 以上も外部 Issue 化せずローカル findings に記録する。",
  "5. 結果を `E:\\Document\\Ars\\Review\\<repo>\\${date}\\` に保存し `latest.json` の `head` をローカル main SHA、`reviewed_at` を実行日時へ更新する。",
  "   Review/ への書き込みはローカルのみ。GitHub へのアクセス、Castra での `git add` / `git commit` / `git push` は行わない。一時 worktree は全経路で削除する。",
  "6. 新規指摘より先にローカル findings の未解決項目を確認 (resolved_checks) し、未対応 High は放置日数付きでレポート先頭に出す。",
  "7. 最終サマリ (対象数 / 変更なし数 / range_reversed によるスキップ数 / 一致・不一致所見数 / ローカル findings 数 / unreviewed) を報告する。",
  "",
  "自分でコード修正はしない。レビュアーの JSON が契約 (§2) を破ったら 1 回だけ再問い合わせ、それでも破れば該当リポを failed として記録し他リポを続行する。",
  "Codex または Claude の一方が利用不能な場合は、利用可能な側のレビューを partial として保存して処理を続ける。突合できないため findings は確定せず、latest.json の head も進めず、unreviewed に停止理由を記録する。",
].join("\n");

/** 新方式の対象・差分・保存規約を使い、オーケストレータ自身が1回レビューする通常版。 */
const WEEKLY_REVIEW_PROMPT = [
  "## 週次レビュー — ${date}",
  "",
  "### 正本 (最初に必ず読む)",
  "- レビュー観点・出力契約: `E:\\Document\\Ars\\LUDIARS\\docs\\REVIEW-PROMPTS.md`",
  "- 対象リポ: `E:\\Document\\Ars\\LUDIARS\\service-map.json` の `daily_review: true` (Tier 1)",
  "",
  "### 手順",
  "1. service-map.json から対象リポを列挙。今回 HEAD はローカル `refs/heads/<default-branch>` の SHA を正本とし、その SHA から detached の一時 review worktree を作る。",
  "   `git fetch` / `git pull` / `origin/*` / `gh` / GitHub API と現在 checkout 中の `HEAD` は使わない。",
  "   前回レビュー日時 (`latest.json.reviewed_at`、無ければ7日前) 以降の main commit を一時 worktreeで確認し、無ければ変更なしとする。",
  "2. 前回 HEAD == 今回 HEAD は変更なし、今回 HEAD が前回 HEAD の祖先なら range_reversed としてレビューせず記録する。",
  "3. REVIEW-PROMPTS.md の入力・JSON契約・Claudeレビュー観点を使い、オーケストレータ自身が各リポを1回レビューする。別AIは起動しない。",
  "4. file:line の実在を検証し、結果を `E:\\Document\\Ars\\Review\\<repo>\\${date}\\` に保存して `latest.json` の `head` と `reviewed_at` を更新する。",
  "   Review/ への書き込みはローカルのみ。GitHub へのアクセスや push は行わず、一時 worktree は全経路で削除する。",
  "5. ローカル findings の未解決項目を確認 (resolved_checks) してから新規所見を扱い、未対応 High は放置日数付きでレポート先頭に出す。",
  "6. 最終サマリ (対象数 / 変更なし数 / 指摘数 / resolved_checks / failed) を報告する。",
  "",
  "自分でコード修正やIssue作成はしない。JSON契約を満たせないリポはfailedとして記録し、他リポを続行する。",
  "",
  MENTION_ADMIN_STEP,
].join("\n");

// ── Genius (判断カード DB) の ingest 運用 ────────────────────────────────
// Genius 側 spec (`E:\Document\Ars\Genius\spec\feature\operations.md` §7) の
// 「Timer Delegation の実登録」は Concordia 側の実装項目である (Genius には自己申告
// できる設定ファイルも API も無く、cron は本ファイルと scheduler/cron-jobs.ts の
// 固定リストが正本)。Tier 1 は genius-ingest-daily (4:10 JST) として登録する。Tier 2 は
// 歩留まり不足で停止中のためテンプレートだけを残し、CRON_JOBS には登録しない。
//
// 注意:
// - どちらも「ingest を回して run を polling し、結果を報告する」だけの運用ジョブ。
//   テスト実行・コード修正・サービスの起動/再起動は指示しない (共有インフラの
//   lifecycle は Excubitor / 人間の担当)。
// - 完了条件は `completed` と `completed-with-errors` の両方。後者は Genius T5 で
//   入る「文書単位で失敗を隔離した正常終了」なので失敗扱いにしない。
// - 自動リトライは実装せず、`--retry-failed` を 1 回試すか人間へ上げるかを LLM が判断する。
const GENIUS_REPO_PATH = "E:\\Document\\Ars\\Genius";

/** run polling・失敗トリアージ・非転記ルールを Tier 1 / Tier 2 で同一に保つ共通節。 */
const GENIUS_INGEST_COMMON_STEPS = [
  "### 前提確認 (起動はしない)",
  `- 作業ディレクトリは Genius repository (\`${GENIUS_REPO_PATH}\`)。別の場所にいる場合は移動してから実行する。`,
  "- Genius サービスの healthz を確認する (接続先は Excubitor catalog の provides.GENIUS_URL が正本)。",
  "  `genius.config.json`。応答が無い / 別 port の場合は設定を読んで確認する)。",
  "- サービスが起動していない場合、**起動・再起動は Excubitor / 人間の担当**なので自分では行わず、",
  "  「Genius サービス停止中のため ingest 未実行」と報告して終了する。",
  "",
  "### run の完了確認",
  "- CLI の成功は「非同期 run の受付成功」にすぎない。返った run id を控え、",
  "  catalog の provides.GENIUS_URL 配下の `/api/clone/ingest/runs/<run id>` を polling して終了状態を確認する。",
  "- 完了条件は status が `completed` **または** `completed-with-errors`。",
  "  `completed-with-errors` は文書単位で失敗を隔離した正常終了であり、失敗扱いにしない。",
  "",
  "### 失敗時の判断 (自動リトライはしない)",
  "- status が `failed`、または `completed-with-errors` で未解決の失敗が残る場合は、",
  "  失敗したソース名・文書のリポジトリ相対パス・エラー種別とメッセージ要約を報告する。",
  "  **文書本文・カード本文・絶対パスは報告に載せない** (通知が次回 ingest で DB へ環流するため)。",
  "- 対処として `node dist/cli.js ingest --sources <失敗ソース> --retry-failed` を **1 回だけ** 試すか、",
  "  人間へエスカレーションするかを自分で判断する。同じリトライを繰り返さない。",
  "- コードの修正・テスト実行・PR 作成はしない。原因が実装バグらしい場合も報告に留める。",
].join("\n");

const GENIUS_INGEST_TEMPLATES: CreateTemplateInput[] = [
  {
    call_name: "genius-ingest-daily",
    title: "Genius 日次 ingest (Tier 1)",
    description: "Genius (判断カード DB) の Tier 1 日次 ingest を実行し、run を polling して結果を報告する。completed / completed-with-errors を完了条件とし、失敗時は --retry-failed 1 回か人間へのエスカレーションを LLM が判断する。Timer Delegation が毎朝 4:10 JST に invoke する。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🧠",
    prompt_template: [
      "## Genius 日次 ingest (Tier 1) — ${date}",
      "",
      "Genius の Tier 1 ingest を回し、終了状態を確認して報告する運用ジョブです。",
      "",
      GENIUS_INGEST_COMMON_STEPS,
      "",
      "### 実行",
      "1. `node dist/cli.js ingest` を実行する (引数なしは Tier 1 のみが対象。Tier 2 は別枠の夜間ジョブ)。",
      "2. 1 時間前に始まる夜間の Tier 2 ジョブが長引いてまだ走っていることがある。CLI や API が",
      "   「別の run が実行中」の旨を返した場合は**重ねて起動せず**、その run id を添えて",
      "   「夜間 run 継続中のため Tier 1 は見送り」と報告して終了する (kill も強制実行もしない)。",
      "3. 上記「run の完了確認」に従って polling する。Tier 1 は通常数分程度で終わる。",
      "4. 最終報告: run id / status / 取り込み件数 / 未解決失敗件数 / 取った対処。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: GENIUS_REPO_PATH,
    is_active: true,
  },
  {
    call_name: "genius-ingest-tier2-nightly",
    title: "Genius 夜間 ingest (Tier 2 全量)",
    description: "Genius の Tier 2 (Claude / Codex 生 JSONL) を budget 無制限で ingest する夜間ジョブ。日次 Tier 1 とは別枠で、初回全量は非常に長時間かかりうる。Timer Delegation が毎朝 3:10 JST に invoke する。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🌙",
    prompt_template: [
      "## Genius 夜間 ingest (Tier 2 全量) — ${date}",
      "",
      "Genius の Tier 2 (Claude / Codex の生 JSONL) を budget 無制限で取り込む夜間ジョブです。",
      "日次 Tier 1 ingest とは別枠なので、Tier 1 の再実行はしません。",
      "",
      GENIUS_INGEST_COMMON_STEPS,
      "",
      "### 実行",
      "1. `npm run ingest:tier2-nightly` を実行する (Tier 2 ソースのみを明示したラッパ。",
      "   budget 上限は Genius 側の設計で撤廃済みのため、未読分を全量処理する)。",
      "2. 上記「run の完了確認」に従って polling する。**未読が多いと 1 run が非常に長時間かかる**ため、",
      "   polling 間隔を数分に広げ、進行が見える限りは待つ。",
      "3. 待ち切れないほど長引く場合も run を kill せず、run id と最後に観測した進捗を添えて",
      "   「継続中」として報告し、翌朝の実行で確認できるようにする。",
      "4. 最終報告: run id / status / 取り込み件数 / 未解決失敗件数 / 所要時間 / 取った対処。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: GENIUS_REPO_PATH,
    // 2026-08-13: pause Tier 2 due to insufficient yield; retain the template for reactivation.
    is_active: false,
  },
];

const VULTUS_REPO_PATH = "E:\\Document\\Ars\\Vultus";

const VULTUS_CATALOG_TEMPLATES: CreateTemplateInput[] = [{
  call_name: "vultus-catalog-refresh-daily",
  title: "Vultus 女優カタログ日次更新",
  description: "DMMとMGStageの全50音ページを低頻度で巡回し、ローカル画像・解析manifest・Vultus統合カタログへ新人と変更分だけを取り込む。Timer Delegationが毎朝8:20 JSTにinvokeする。2026-08-20 neco指示でパートタイマーからHaikuを除外 (auto-mode不可・処理能力不足) しSonnet 5へ変更。",
  target_provider: "claude",
  model: "claude-sonnet-5",
  category: "parttimer",
  emoji: "🖼️",
  prompt_template: [
    "## Vultus 女優カタログ日次更新 — ${date}",
    "",
    `作業ディレクトリは Vultus 本体 (\`${VULTUS_REPO_PATH}\`)。worktree・複製フォルダでは実行しない。`,
    "このジョブはデータ更新専用。コード編集、git操作、テスト、サービス起動・停止・再起動は行わない。",
    "DMM / MGStage の各クライアントが持つ1秒以上のアクセス間隔を短縮しない。",
    "",
    "### 手順",
    "1. `analyzer` で `.venv\\Scripts\\python.exe -m vultus_analyzer.dmm.cli --output-dir ..\\server\\data\\dmm-catalog --permission-confirmed` を実行する。",
    "2. 続けて `.venv\\Scripts\\python.exe -m vultus_analyzer.mgstage.cli --catalog-url https://www.mgstage.com/list/actress_list.php --output-dir ..\\server\\data\\mgstage-catalog --permission-confirmed` を実行する。",
    "3. crawler / ingest のどの段階でも、一方が失敗しても他方の処理は続行する。失敗したcrawlerだけをproviderごとに最大1回リトライし、それ以上は繰り返さない。",
    "4. `server` で `npm run cli -- sources:list --realm catalog` を実行し、`dmm-actress-catalog` と `mgstage-actress-catalog` が有効か確認する。欠けていれば登録を推測せず報告し、対応するproviderのingestは行わない。",
    "5. crawlerが成功し、かつsourceが有効なproviderのmanifestだけを次のコマンドで取り込む。",
    "   - `npm run cli -- ingest:catalog-manifest --realm catalog --source dmm-actress-catalog --manifest data\\dmm-catalog\\manifest.json`",
    "   - `npm run cli -- ingest:catalog-manifest --realm catalog --source mgstage-actress-catalog --manifest data\\mgstage-catalog\\manifest.json`",
    "6. crawlerとingestの出力から、provider別にmanifest件数、解析成功/品質除外/エラー、追加/更新/skip件数を報告する。氏名・画像URL・顔特徴量は報告へ載せない。",
    "",
    MENTION_ADMIN_STEP,
  ].join("\n"),
  input_schema: [
    { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
  ],
  default_cwd: VULTUS_REPO_PATH,
  is_active: true,
}];

const SEED_TEMPLATES: CreateTemplateInput[] = [
  {
    call_name: "impl-from-design",
    title: "設計書から実装 (Codex)",
    description: "Claude などが書いた設計書 / spec を Codex に渡して実装させる。 LUDIARS の規約 (feat branch + PR) を守らせる。",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    call_only: true,
    category: "freelancer",
    sort_order: 100,
    prompt_template: [
      "Read the design document at ${design_path}.",
      "",
      "${context_extra:}", "",
      "Target repository: ${target_repo}.",
      "",
      "Implementation requirements:",
      "- Create a feature branch (feat/<scope>) off origin/main.",
      "- Implement the design as written. Don't add scope.",
      ...ANATOMIA_SUPPLY_VERIFY_STEPS,
      "- Add or update test coverage when the design needs it, but do not run tests unless the user explicitly requested them.",
      "- Make 1 PR (1 commit if possible) — squash mergeable.",
      "- Stop after the PR is created. Do not merge or enable auto-merge unless the user explicitly requested it.",
      "- Follow LUDIARS conventions (see CLAUDE.md / dev-process.md).",
      "",
      "When done, report the PR URL.",
    ].join("\n"),
    input_schema: [
      { name: "design_path", type: "string", required: true, description: "Path to the design doc (absolute or relative to target_repo)" },
      { name: "target_repo", type: "string", required: true, description: "Absolute path of the target repository" },
      { name: "context_extra", type: "string", required: false, description: "Optional extra context to prepend" },
    ],
    // ${target_repo} は service.ts:substituteVars が invoke 時に args から展開する。
    // 旧 null だと wt -d が抜けて Codex が user-home で起動していた (cwd bug)。
    default_cwd: "${target_repo}",
    is_active: true,
  },
  {
    call_name: "fix-bug",
    title: "バグ修正委託 (Codex)",
    description: "バグ説明 + 任意の再現手順を Codex に投げ、 修正 PR を作らせる。",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    call_only: true,
    category: "freelancer",
    sort_order: 110,
    prompt_template: [
      "Fix this bug in ${target_repo}:",
      "",
      "${description}",
      "",
      "${reproduce_steps:}", "",
      "Requirements:",
      "- Diagnose the issue from the available evidence before editing.",
      "- Apply the minimal fix; no unrelated refactors.",
      ...ANATOMIA_SUPPLY_VERIFY_STEPS,
      "- Add regression coverage when practical, but do not run tests unless the user explicitly requested them.",
      "- Create a feature branch (fix/<short-slug>) + PR.",
      "- Stop after the PR is created. Do not merge or enable auto-merge unless the user explicitly requested it.",
      "",
      "Report the PR URL.",
    ].join("\n"),
    input_schema: [
      { name: "description", type: "string", required: true, description: "What is broken" },
      { name: "target_repo", type: "string", required: true, description: "Absolute path of the target repository" },
      { name: "reproduce_steps", type: "string", required: false, description: "How to reproduce (optional)" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  {
    call_name: "refactor",
    title: "局所リファクタ (Codex)",
    description: "範囲指定のリファクタ。 behavior 維持の規約を持たせる。",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    call_only: true,
    category: "freelancer",
    sort_order: 120,
    prompt_template: [
      "Refactor ${target} to achieve: ${goal}.",
      "",
      "${constraints:}", "",
      "Rules:",
      "- Behavior must be unchanged.",
      "- Add or strengthen tests where helpful, but do not run them unless the user explicitly requested it.",
      "- No drive-by changes outside the target.",
      "- Create a feature branch (refactor/<short-slug>) + PR.",
      "- Stop after the PR is created. Do not merge or enable auto-merge unless the user explicitly requested it.",
      "",
      "Report the PR URL and a 2-bullet summary of the structural change.",
    ].join("\n"),
    input_schema: [
      { name: "target", type: "string", required: true, description: "File path or module symbol" },
      { name: "goal", type: "string", required: true, description: "Why refactor (split / clarify / remove dup)" },
      { name: "constraints", type: "string", required: false, description: "Hard constraints" },
    ],
    default_cwd: null,
    is_active: true,
  },
  // ── Claude (Opus / Sonnet / Fable) への汎用実装委託 ──────────────────
  // target_provider=claude + model 指定 → spawn は `lictor claude --model <id>`。
  // 同じ Claude Code でも上位/中位/高速モデルを選んで委託できるよう既定で 3 本入れる。
  ...(["opus-5", "sonnet-5", "fable-5", "haiku-4-5"] as const).map((tier) => {
    const meta = {
      "opus-5": { id: "claude-opus-5", label: "Opus 5", note: "最上位。 設計判断や難所の実装向き。", emoji: "🧙‍♂️" },
      "sonnet-5": { id: "claude-sonnet-5", label: "Sonnet 5", note: "中位。 一般的な実装の主力。", emoji: "🧑‍💼" },
      "fable-5": { id: "claude-fable-5", label: "Fable 5", note: "高速。 軽量〜中規模タスク向き。", emoji: "🦸" },
      "haiku-4-5": { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "超高速・軽量タスク向き。", emoji: "🗣️" },
    }[tier];
    return {
      call_name: `claude-${tier}-impl`,
      title: `実装委託 (Claude ${meta.label})`,
      description: `Claude Code (${meta.label}) に実装を委託する。${meta.note} LUDIARS 規約 (feat branch + PR) を守らせる。`,
      target_provider: "claude" as const,
      model: meta.id,
      emoji: meta.emoji,
      category: "employee" as const,
      sort_order: CLAUDE_TEMPLATE_SORT_ORDER[tier],
      prompt_template: [
        "Implement the following in ${target_repo}:",
        "",
        "${task}",
        "",
        "${context_extra:}", "",
        "Requirements:",
        "- Create a feature branch (feat/<short-slug>) off origin/main.",
        "- Implement as specified; don't add scope.",
        ...ANATOMIA_SUPPLY_VERIFY_STEPS,
        "- Add or update test coverage when the change needs it, but do not run tests unless the user explicitly requested them.",
        "- Make 1 PR (squash mergeable). Follow CLAUDE.md / dev-process.md.",
        "- Stop after the PR is created. Do not merge or enable auto-merge unless the user explicitly requested it.",
        "",
        "Report the PR URL when done.",
      ].join("\n"),
      input_schema: [
        { name: "task", type: "string" as const, required: true, description: "What to implement" },
        { name: "target_repo", type: "string" as const, required: true, description: "Absolute path of the target repository" },
        { name: "context_extra", type: "string" as const, required: false, description: "Optional extra context to prepend" },
      ],
      default_cwd: "${target_repo}",
      is_active: true,
    };
  }),
  ...CODEX_56_TEMPLATES,
  {
    call_name: "task-process",
    title: "タスク処理",
    description: "Memoriaから残タスクを確認して実行する。どのプロジェクトの作業をするかはユーザーに質問形式で問い合わせる。delegate-task リアクションワークフロー (🤝) のデフォルトテンプレート。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "employee",
    sort_order: 130,
    emoji: "🤝",
    prompt_template: [
      "Memoriaから残タスクを確認して実行する。どのプロジェクトの作業をするかはユーザーに質問形式で問い合わせること。",
      "",
      "${context_extra:}",
    ].join("\n"),
    input_schema: [
      { name: "context_extra", type: "string" as const, required: false, description: "Optional extra context" },
    ],
    default_cwd: null,
    is_active: true,
  },
  // ── 毎朝 8 時の自動タスク処理 ──────────────────────────────────────────
  // Concordia の MorningScheduler が今日期限の Memoria タスクを取得し、
  // task_list を引数として本テンプレを invoke する。
  {
    call_name: "morning-tasks",
    title: "毎朝タスク処理 (Claude)",
    description: "Memoriaの今日期限タスクを「確認系(人間がやる)」と「実装系(AIがやれる)」に仕分け、確認系は整理して提示し、実装系は1件ずつ着手して、詰まったらask・分割・委譲で止める朝ルーティン。MorningSchedulerが毎朝8時にinvokeする。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    sort_order: 140,
    emoji: "🌅",
    prompt_template: [
      "## 朝タスク処理 — ${date}",
      "",
      "Memoriaから取得した今日期限の未完タスクです。",
      "まず全タスクを **確認系 (人間がやる)** と **実装系 (AIがやれる)** の2つに仕分けてください。",
      "",
      "### 今日の対象タスク",
      "",
      "${task_list}",
      "",
      "### 仕分け基準",
      "- **確認系 (人間がやる)**: 実機確認, ブラウザ操作, Discord/GCP/AWS等の外部サービス設定, データ手動入力, 物理操作, 対人連絡, 本人にしか判断できないもの。",
      "  → これらは **実行しない**。人間が今日こなすための整理リストとして提示するだけ。",
      "- **実装系 (AIがやれる)**: コード修正・実装, CLIコマンド実行 (`npm run ...` 等), PR作成, 設定変更, ステータス更新, 調査・ドキュメント生成。",
      "  → これらは **1件ずつ着手する**。詰まったらask・分割・委譲で止め、単独エージェントを走らせ続けない。",
      "",
      "### 手順",
      "1. 全タスクを 確認系 / 実装系 に仕分ける (判定に迷うタスクは確認系=人間側に寄せる)。",
      "2. **確認系**: 「今日 人間がやること」として優先度順に整理し、1メッセージにまとめて投稿する (実行はしない)。",
      "3. **実装系**: 優先度・インパクト順に1件ずつ着手し、各タスクは小さな完了単位で実装・報告する。テストはユーザが明示した場合だけ実行する。",
      "   - **軽微な修正** (CORS追加・パス修正・設定変更等) は直接worktreeで実施してPR作成。",
      "   - **複雑な実装** (新機能・大規模リファクタ) はAgent tool (model=opus) に委託し、自分はPR作成まで確認。",
      "   - **CLIコマンド実行** タスク (`npm run companies:xxx` 等) は `--limit 100` 程度で実施。",
      "   - 完了したタスクは `node \"E:/Document/Ars/.claude/skills/memoria-task/mmtask.mjs\" --set <id> done` でクローズ。",
      "4. **人間の判断が必要になったら** (方針が割れる/破壊的操作/本番影響不明/仕様が曖昧 等)、決め打ちせず ask マーカーで質問し、そのタスクは保留にして人間に委ねる (進行を止める)。",
      "5. そのセッションで扱う実装単位が完了するか、全タスクが「完了 or 確認系として提示済み or 判断待ちで保留 or 分割/委譲済み」のいずれかになったら、結果サマリを投稿する。",
      "   - サマリ構成: **① 今日 人間がやること(確認系一覧)** / **② AIが実装したもの(PR・クローズ済み)** / **③ 判断待ちで止めたもの(質問内容)**。",
      "6. サマリ投稿後に `/session-end`。",
      "",
      "注意: 破壊的なDB操作・本番への影響が不明な操作は実行せず ask で確認する。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "task_list", type: "string" as const, required: true, description: "今日期限の未完タスク一覧 (MorningSchedulerが整形して渡す)" },
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Concordia",
    is_active: true,
  },
  {
    call_name: "gemma4-12-impl",
    title: "ローカル LLM 実装委託 (gemma4-12 / auto)",
    description: "ローカル LLM (Ollama 上の Gemma 4 等) に実装を委託する。API 課金ゼロ・ローカル完結。model='auto' は Concordia 管理の既定ローカルモデルへ解決する。長いエージェントループは精度・速度が落ちるので小さく区切ったタスク向き。",
    target_provider: "gemma4-12",
    category: "employee",
    sort_order: 150,
    emoji: "🇬",
    // model="auto" → Cc 管理の既定ローカルモデルへ解決。固定したいなら Ollama タグを直書き。
    model: "auto",
    prompt_template: [
      "Implement the following in ${target_repo}:",
      "",
      "${task}",
      "",
      "${context_extra:}", "",
      "Requirements:",
      "- Keep the change small and self-contained (local model — avoid sprawling multi-file edits).",
      ...ANATOMIA_SUPPLY_VERIFY_STEPS,
      "- Create a feature branch (feat/<short-slug>) off origin/main.",
      "- Add or update test coverage when the change needs it, but do not run tests unless the user explicitly requested them.",
      "- Make 1 PR (squash mergeable). Follow CLAUDE.md / dev-process.md.",
      "- Stop after the PR is created. Do not merge or enable auto-merge unless the user explicitly requested it.",
      "",
      "Report the PR URL when done.",
    ].join("\n"),
    input_schema: [
      { name: "task", type: "string", required: true, description: "What to implement (keep it scoped)" },
      { name: "target_repo", type: "string", required: true, description: "Absolute path of the target repository" },
      { name: "context_extra", type: "string", required: false, description: "Optional extra context to prepend" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  // 単一オーケストレータ (Claude) 版。2026-08-08 neco 指示で毎日 → 週次へ変更 (形骸化した
  // デイリーレビューを廃止し、空いた朝枠は vulnerability-response-daily に譲った)。
  // dual テンプレート自体は手動起動用に残す。
  {
    call_name: "ludiars-review-weekly",
    title: "週次レビュー",
    description: "Tier 1 リポの週次レビュー。単一オーケストレータ (Claude) が AIFormat に沿ってレビューし、Review/<repo>/<date>/ に保存する。ludiars-review-daily-dual (ちょいつよ版、Sol Ultra 突合) は手動起動用に残る。2026-08-08 neco 指示で毎日 → 週次 (毎週月曜) へ変更。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "📋",
    prompt_template: WEEKLY_REVIEW_PROMPT,
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Concordia",
    is_active: true,
  },
  {
    call_name: "vulnerability-response-daily",
    title: "脆弱性対応 (毎朝)",
    description: "Tier 1 リポを AIFormat REVIEW_VULNERABILITY.md の観点だけで毎朝スキャンし、安全カテゴリの指摘は Codex に自動修正委託、Critical/High は自動修正せず管理者へメンションして報告する。2026-08-08 neco 指示で新設 (デイリーレビュー廃止で空いた 5:10 枠を引き継ぐ)。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🛡️",
    prompt_template: [
      "## 脆弱性対応 — ${date}",
      "",
      "### 正本 (最初に必ず読む)",
      "- 脆弱性観点テンプレ: `E:\\Document\\Ars\\AIFormat\\common\\REVIEW_VULNERABILITY.md`",
      "- 対象リポ: `E:\\Document\\Ars\\LUDIARS\\service-map.json` の `daily_review: true` (Tier 1)",
      "- 差分・保存規約: `E:\\Document\\Ars\\LUDIARS\\docs\\REVIEW-PROMPTS.md` (§1 入力構築 / §出力契約はそのまま流用し、観点だけ REVIEW_VULNERABILITY.md に絞る)",
      "",
      "### 手順",
      "1. service-map.json から対象リポを列挙。今回 HEAD はローカル `refs/heads/<default-branch>` の SHA を正本とし、その SHA から detached の一時 review worktree を作る。",
      "   `git fetch` / `git pull` / `origin/*` / `gh` / GitHub API と現在 checkout 中の `HEAD` は使わない。",
      "   前回実行日時 (`E:\\Document\\Ars\\Review\\<repo>\\latest.json` の `vulnerability_reviewed_at`、無ければ24時間前) 以降の main commit を確認し、無ければ変更なしとする。",
      "2. 前回 HEAD == 今回 HEAD は変更なし、今回 HEAD が前回 HEAD の祖先なら range_reversed としてスキャンせず記録する。",
      "3. REVIEW_VULNERABILITY.md の観点だけでオーケストレータ自身が各リポを1回スキャンする (設計/実装/品質等の他観点は扱わない)。別AIは起動しない。",
      "4. file:line の実在を検証し、指摘を Critical/High/Medium/Low で分類する。",
      "5. **安全カテゴリ** (依存パッケージの既知脆弱性バージョン更新のうち breaking change を伴わないもの、機密情報のログ出力停止、明らかな入力検証漏れの追加等、既存挙動を壊さない修正に限る) は `daily-review-autofix` と同じ要領で Codex に1リポ1PRで自動修正委託してよい。",
      "6. **Critical/High、または安全カテゴリの判断に自信が持てない指摘**は自動修正せず、file:line + 内容 + 推奨対応を記録するだけにとどめる。",
      "7. 結果を `E:\\Document\\Ars\\Review\\<repo>\\${date}-vulnerability\\` に保存し、`latest.json` に `vulnerability_reviewed_at` と `head` を記録する (既存の週次レビュー用フィールドは上書きしない)。",
      "   Review/ への書き込みはローカルのみ。GitHub へのアクセスや push は行わず、一時 worktree は全経路で削除する。",
      "8. 最終サマリ (対象数 / 変更なし数 / 自動修正委託数 / Critical・High件数 / 未対応日数) を報告する。Critical/High が1件でもあれば報告冒頭で明示する。",
      "",
      "自分でコード修正はしない (Codexへの委託のみ)。JSON契約を満たせないリポはfailedとして記録し、他リポを続行する。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Concordia",
    is_active: true,
  },
  {
    call_name: "kaizen-daily",
    title: "カイゼン (毎朝)",
    description: "前日の session-logs とメモリの蓄積から、アルゴリズム/スクリプト/ツールで解決できる非効率・やらかしを見つけて改善案を提案する (実装はしない)。2026-08-08 neco 指示で新設。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "📈",
    prompt_template: [
      "## カイゼン — ${date}",
      "",
      "前日にあった session-log 上のやらかし・非効率と、現在メモリに蓄積されている繰り返しパターンから、",
      "**アルゴリズム・スクリプト・ツールで機械的に解決できるもの**を見つけて改善案を提案する回です。",
      "実装はしません (提案のみ)。",
      "",
      "### 材料",
      "- 前日の session-log: `E:\\Document\\Ars\\session-logs\\<前日日付>*.md` (同日に複数ファイルがある場合は全部読む)。",
      "  前日分が無ければ前々日まで遡って直近1日分を対象にする。",
      "- 現在のメモリ索引: `~/.claude/projects/E--Document-Ars/memory/MEMORY.md` とそこから",
      "  リンクされる feedback系メモリ (同じ非効率・同じ失敗が繰り返し記録されていないか確認する)。",
      "- session-log とメモリは機密扱いにする。認証情報・個人情報・内部 endpoint・生の本文は、保存する改善案と最終報告のどちらにも転記しない。",
      "",
      "### 探す対象の例 (機械化できるものだけに絞る)",
      "- 同じ確認・同じmiss検知を毎回人力でやっている (→ hook / lint / スクリプトで自動検知できないか)。",
      "- 同じ種類の判断ミス・手順飛ばしが繰り返されている (→ CLAUDE.md / スキル / harness gate に固定できないか)。",
      "- 同じ調査を毎回イチからやり直している (→ キャッシュ・索引・定型スクリプト化できないか)。",
      "- 人間の判断が必須ではないのに毎回 ask で止まっている箇所 (→ 安全に自動化できる境界か見極める)。",
      "",
      "**対象外**: 個別のバグ修正・設計判断・人間の意思決定が本質的に必要なもの (これらは通常のタスク/レビューで扱う)。",
      "",
      "### 手順",
      "1. 前日の session-log を読み、やらかし・手戻り・非効率と思われる箇所を洗い出す。",
      "2. メモリ索引と feedback 系メモリを確認し、同じパターンが過去にも記録されていないか (繰り返しなら優先度を上げる)。",
      "3. 洗い出した項目のうち、アルゴリズム・スクリプト・ツール (hook / lint / CI check / 定型コマンド等) で解決できそうなものだけを絞り込む。",
      "4. 各提案について: 症状 (何が起きたか) / 原因 / 提案する機械的対策 / 対象リポジトリ or 汎用設定、を1件ずつ整理する。",
      "5. 提案を `E:\\Document\\Ars\\session-logs\\kaizen\\${date}.md` に保存する (実装はしない。コードは書かない)。",
      "6. 保存したファイルパスと提案件数・要約を報告する。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Concordia",
    is_active: true,
  },
  {
    call_name: "team-standup-daily",
    title: "チーム朝礼 (毎朝)",
    description: "チームごとの稼働状況と対応状況をまとめ、チームの 目標 面へカードとして投稿する。証跡で裏付けられる完了だけを Memoria タスク / director case step へ毎日反映する (2026-08-20 neco 裁定)。2026-08-17 neco 指示で新設。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🌅",
    prompt_template: [
      "## チーム朝礼 — ${team_name} (${date})",
      "",
      "チーム `${team_name}` (team_id `${team_id}`) の稼働状況と対応状況をまとめ、",
      "チームの 目標 面へ 1 枚のカードとして投稿し、**証跡で裏付けられる完了だけ**を",
      "タスクリスト (Memoria) と目標 (director case step) へ反映する回です。",
      "コードの修正、commit、push、PR 作成、サービスの起動・停止・再起動はしません。",
      "",
      "### 参照先",
      "ポート番号は Excubitor catalog / ProcessMap で解決する (ハードコードしない)。",
      "- チーム定義: Concordia `GET /v1/teams` の該当チーム (repos / settings / metrics)",
      "- 目標: Concordia `GET /v1/director/cases?team_id=${team_id}` の case と step",
      "- セッション / コスト: Concordia `GET /v1/sessions`、`GET /v1/teams/${team_id}/cost`",
      "- PR: Concordia `GET /v1/prs` をチームの repos で絞る",
      "- タスク: Memoria の未完了タスクをチームの repos / プロジェクト名で絞る",
      "- 稼働: Excubitor でチームの repos に対応するサービスの state / health / 24h 稼働率",
      "",
      "### 手順",
      "1. チームの repos を取得し、対応する Excubitor サービスを特定する (catalog の repo / cwd で突き合わせる)。",
      "2. **稼働**: 各サービスの state・health・24h 稼働率・最後に落ちた時刻を集める。",
      "   落ちているものは depends_on も辿り、どの依存が原因で機能が通らないかまで書く。",
      "3. **対応**: director case の step 進捗、滞留している PR、未完了タスク、前日のセッション本数とコストを集める。",
      "4. **突き合わせ**: 実態はもう終わっているのに step / タスクが未完了のまま、というズレを探す",
      "   (朝礼で一番価値がある指摘なので必ず見る)。",
      "5. 「今日いま効く 3 点」を選ぶ。裁定待ちで着手できないものは、何を誰が決めれば動くのかを書く。",
      "6. **台帳のデイリー更新** (2026-08-20 neco 裁定): 手順 4 のズレのうち、証跡 (マージ済み PR /",
      "   完了済み delegation run / 稼働確認) で裏付けられる**完了だけ**を反映する:",
      "   - Memoria タスクの完了 (該当タスクを done にする)",
      "   - director case step の completed 化 (`PATCH /v1/director/cases/:caseId/steps/:stepId`)",
      "   削除・期限変更・優先順位・内容修正・新規目標の起案など判断が要る更新は**反映しない**。",
      "   議題として提示し、人間の回答 (定例または thread 返信) を待つ。",
      "7. まとめを Concordia `POST /v1/teams/${team_id}/cards` へ投稿する。",
      "   body は `{\"kind\":\"standup\",\"title\":\"朝礼 ${date} — ${team_name}\",\"body\":\"<Markdown 本文>\"}`。",
      "   日本語ペイロードは JSON ファイル経由で POST する (シェルへ直接埋め込むと文字化けする)。",
      "8. API の受理結果と本文の要約を最終報告に載せる。実際の Discord 投稿は非同期なので、受理結果から配信済みとは断定しない。",
      "",
      "### カード本文の型 (4000 字以内)",
      "- **稼働**: サービスごとに 1 行 (state / health / 24h 稼働率)",
      "- **対応**: 目標ごとに 1 行 (どの step まで来たか) + 滞留 PR + 未完了タスク件数",
      "- **ズレ**: 実態と記録が食い違っている箇所 (無ければ「なし」と書く)",
      "- **更新**: 証跡ベースで反映した項目と、判断待ちとして提示した項目を 1 件ずつ (無ければ「なし」)",
      "- **今日効く 3 点**: 具体的な行動を 1 行ずつ",
      "",
      "数字は実測値だけを書く。取れなかった項目は「取得できず」と明記し、推測で埋めない。",
      "",
      "### やらないこと",
      "- 証跡の無い書き換えをしない。判断が要る整理 (削除・期限変更・優先順位・内容修正) は定例で人間と決める。",
      "- PR の状態は書き換えない (Revisor / 人間の持ち場)。",
      "- チームの settings が `visibility: private` なら、対外に出せない固有名 (学校名・顧客名) をカードに書かない。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
      { name: "team_id", type: "string" as const, required: true, description: "対象チームの team id" },
      { name: "team_name", type: "string" as const, required: true, description: "対象チームの表示名" },
      { name: "team_slug", type: "string" as const, required: false, description: "対象チームの slug" },
    ],
    default_cwd: "E:\\Document\\Ars",
    is_active: true,
  },
  {
    call_name: "team-review-regular",
    title: "チーム定例 (週2回・人間同席)",
    description: "チームのタスクを棚卸しする定例。議題を提示して neco の返信を待ち、Memoria タスクと director case step へ反映するまでを 1 回とする。火・金 13:00。2026-08-17 neco 指示で新設。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🗓️",
    prompt_template: [
      "## チーム定例 — ${team_name} (${date})",
      "",
      "チーム `${team_name}` (team_id `${team_id}`) のタスクの確認と棚卸しを、neco と一緒に行う回です (週 2 回)。",
      "**議題を出して終わりではありません。neco の返信を読んで、Memoria タスクと director case step へ",
      "実際に反映するところまでが 1 回分**です。",
      "",
      "### 進め方",
      "1. 棚卸しの材料を集める (参照先は朝礼 `team-standup-daily` と同じ。ポートは Excubitor catalog で解決する)。",
      "2. 議題を作る。次の 5 分類で、該当するものだけを挙げる:",
      "   - **実態は終わっているのに未完了**: 実装・マージ・稼働が確認できるのに step / タスクが pending のまま",
      "   - **止まっている**: 前回の定例から動いていないもの (何日動いていないかを書く)",
      "   - **裁定待ち**: 人間の判断が無いと着手できないもの (何を決めれば動くのかを 1 行で書く)",
      "   - **重複・陳腐化**: 同じ内容が複数ある / 前提が変わって不要になった",
      "   - **浮いている**: どの目標にも紐づいていないタスク",
      "3. 議題を **このセッションの Discord thread へ投稿する** (ここが定例の場。thread への返信はそのまま inject される)。",
      "   各項目に `A-1` `B-2` のような短い番号を振り、neco が番号で返信できるようにする。",
      "   Concordia `GET /v1/admin/state` の `mention_user_id` があれば議題の先頭に `<@...>` を付ける",
      "   (定例は人間の同席が要るので、朝礼と違ってここで呼ぶ)。",
      "   併せて `POST /v1/teams/${team_id}/cards` に `{\"kind\":\"meeting\", ...}` で開始通知を出し、",
      "   direction 面から定例の場に辿り着けるようにする (件数と入口だけ。議題本文は入れない)。",
      "4. **neco の返信を待つ。** 返信が来たら指示どおりに反映する:",
      "   - Memoria タスク: 完了 / 削除 / 期限変更 / 内容修正",
      "   - director case step: `PATCH /v1/director/cases/:caseId/steps/:stepId` で status を変える",
      "   - 反映できないもの (権限不足・情報不足) は、理由を添えて指示を仰ぐ",
      "5. 反映が終わったら、何をどう変えたかを 1 件ずつ列挙して thread へ報告する。未反映が残っていれば明示する。",
      "6. neco から終了の指示が出るまでセッションを閉じない。返信が無いまま長時間経過した場合は、",
      "   議題を残したまま「未実施」として報告して終わる (**勝手に反映しない**)。",
      "",
      "### 原則",
      "- **neco が決めていないことを反映しない。** 明らかな事実誤り (既にマージ済み等) でも、",
      "  反映前に議題として出して同意を取る。",
      "- 反映は 1 件ずつ確認できる形で行い、まとめて一括変更しない。",
      "- コードの修正・commit・push・PR 作成・サービスの起動停止はしない。この回は台帳の整理だけ。",
      "- 日本語ペイロードの POST / PATCH はファイル経由で行う (シェルへ直接埋め込むと文字化けする)。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
      { name: "team_id", type: "string" as const, required: true, description: "対象チームの team id" },
      { name: "team_name", type: "string" as const, required: true, description: "対象チームの表示名" },
      { name: "team_slug", type: "string" as const, required: false, description: "対象チームの slug" },
    ],
    default_cwd: "E:\\Document\\Ars",
    is_active: true,
  },
  // ── ディレクターワークフロー (spec/feature/director-workflow.md) ──────────
  {
    call_name: "director-task-pull",
    title: "関連未完了タスク取得 (Memoria)",
    description: "Memoria から topic (プロジェクトコード/カテゴリ/キーワード) に関連する未完了タスクを引き、正規化した一覧を報告する読み取り専用の部品。タスク整理 (director-task-organize) が同じ手順定義を使う。2026-08-20 neco 指示で新設。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "📋",
    prompt_template: [
      "## 関連未完了タスク取得 — ${topic}",
      "",
      "Memoria のタスクから `${topic}` に関連する**未完了タスク**を引き、正規化した一覧を報告する回です。",
      "**読み取り専用** — タスクの書き換え・削除・追加はしません。",
      "",
      "### 取得手順",
      MEMORIA_TASK_PULL_PROCEDURE,
      "",
      "### 出力 (最終報告に載せる)",
      "- Markdown 表: id / title / category / due_at / 関連根拠 の列。期限昇順 (期限なしは末尾)。",
      "- 同じ内容を ```json フェンスの JSON 配列でも併記する (機械読み取り用)。",
      "- 件数が ${limit:50} を超える場合は期限の近い順に切り、切った件数を明記する。",
      "- 0 件なら「該当なし」と、試した別名・検索語を書く (0 件は「探していない」と区別する)。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "topic", type: "string" as const, required: true, description: "関連の軸 (プロジェクトコード / カテゴリ / キーワード)" },
      { name: "limit", type: "string" as const, required: false, description: "一覧の最大件数 (既定 50)" },
    ],
    default_cwd: "E:\\Document\\Ars",
    is_active: true,
  },
  {
    call_name: "director-task-organize",
    title: "ディレクター タスク整理 (チーム毎日 10:00)",
    description: "チームの関連未完了タスクを Memoria から引き、実行可能なものを director case の step へ落とし、証跡ある完了を反映し、判断待ち・浮いているタスクを人間へ提示する。毎日 10:00 にチームごとへ fanout。2026-08-20 neco 指示で新設。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🗂️",
    prompt_template: [
      "## ディレクター タスク整理 — ${team_name} (${date})",
      "",
      "チーム `${team_name}` (team_id `${team_id}`) のタスク整理を行う回です。これは現場を回す",
      "ディレクターのワークロードの一部で、Memoria の未完了タスクを目標 (director case) へ紐付けて",
      "**巡回 (director-patrol) が実行できる形**へ落とします。",
      "コードの修正、commit、push、PR 作成、サービスの起動・停止はしません。",
      "",
      "### 材料",
      "- チーム定義: Concordia `GET /v1/teams` の該当チーム (repos / settings)",
      "- 目標: Concordia `GET /v1/director/cases?team_id=${team_id}` の case と step",
      "- 関連未完了タスク: 次の取得手順で引く (delegation `director-task-pull` と同じ定義)。",
      "  topic はチームの repos 名・プロジェクトコード・チーム名を使う (追加指定: ${topic:なし})。",
      MEMORIA_TASK_PULL_PROCEDURE,
      "",
      "### 整理 (4 分類)",
      "1. **実行可能**: チームの目標 (case) に紐づき、AI が実装できる —",
      "   該当 case へ `POST /v1/director/cases/:caseId/steps` で `{\"kind\":\"delegate\",\"title\":\"<タスク内容>\",",
      "   \"handoff_note\":\"Memoria #<id>: <補足>\"}` を追加する。1 タスク 1 step。既存 step と title /",
      "   handoff_note の Memoria id で突き合わせ、**重複追加しない**。追加した step は巡回が自動で実装する。",
      "2. **実態完了**: 証跡 (マージ済み PR / 完了済み delegation run / 稼働確認) がある —",
      "   Memoria タスクを done にし、対応する step を `PATCH /v1/director/cases/:caseId/steps/:stepId` で",
      "   completed にする。証跡を 1 件ずつ記録する。",
      "3. **判断待ち**: 削除・期限変更・優先順位・内容修正・新規目標の起案が要る — **反映しない**。",
      "   何を決めれば動くのかを 1 行ずつ書いて提示する。",
      "4. **浮いている**: どの目標にも紐づかない — 一覧で提示する (勝手に case を作らない)。",
      "",
      "### 報告",
      "- 整理結果を Concordia `POST /v1/teams/${team_id}/cards` へ投稿する。",
      "  body は `{\"kind\":\"task-kanban\",\"title\":\"タスク整理 ${date} — ${team_name}\",\"body\":\"<Markdown 本文>\"}`。",
      "  本文は 4 分類ごとに 1 件 1 行 (実行可能は追加した step id、実態完了は証跡、判断待ちは決め所を添える)。",
      "  日本語ペイロードは JSON ファイル経由で POST する (シェルへ直接埋め込むと文字化けする)。",
      "- 面が未プロビジョニングで受理されない場合はスキップし、最終報告にその旨を書く。",
      "",
      "### 原則",
      "- 証跡の無い書き換えをしない。判断が要る変更は提示のみ (定例 / thread 返信で人間が決める)。",
      "- step の追加は「AI が実装できる」と確信できるものだけ。迷ったら判断待ちへ回す。",
      "- 数字・状態は実測値だけを書く。取れなかったものは「取得できず」と明記する。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
      { name: "team_id", type: "string" as const, required: true, description: "対象チームの team id" },
      { name: "team_name", type: "string" as const, required: true, description: "対象チームの表示名" },
      { name: "team_slug", type: "string" as const, required: false, description: "対象チームの slug" },
      { name: "topic", type: "string" as const, required: false, description: "関連タスク取得の軸 (未指定はチーム名)" },
    ],
    default_cwd: "E:\\Document\\Ars",
    is_active: true,
  },
  {
    call_name: "daily-review-autofix",
    title: "週次レビュー安全修正委託 (Codex)",
    description: "ludiars-review-weekly / vulnerability-response-daily が見つけた安全範囲の指摘 (lint/typo/unused_import/dead_code/gitignore/toc/spec_gen) をまとめて Codex に適用させ、1 PR にする。call_only (人間向けドロップダウンには出さない)。",
    target_provider: "codex",
    call_only: true,
    category: "freelancer",
    emoji: "🛠️",
    prompt_template: [
      "Apply the following safe auto-fixes in ${target_repo} (${repo_name}):",
      "",
      "${fixes}",
      "",
      "Requirements:",
      "- Only apply the listed fixes; no unrelated changes.",
      "- spec/ ファイルは新規生成のみ許可。既存ファイルは上書きしない。",
      "- Create branch chore/review-fix-${date} off origin/main.",
      "- Make 1 PR (squash mergeable). PR body: 適用した修正一覧 + ローカル記録",
      "  `E:\\Document\\Ars\\Review\\${repo_name}\\${date}\\AUTOFIX.md` の参照 (リモートリンクにはしない)。",
      "",
      "Report the PR URL when done.",
    ].join("\n"),
    input_schema: [
      { name: "target_repo", type: "string" as const, required: true, description: "Absolute path of the target repository" },
      { name: "repo_name", type: "string" as const, required: true, description: "リポ名 (Review/<repo_name>/ と一致させる)" },
      { name: "date", type: "string" as const, required: true, description: "レビュー実施日 (YYYY-MM-DD)" },
      { name: "fixes", type: "string" as const, required: true, description: "適用する安全範囲の指摘一覧 (file:line + 概要)" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  {
    call_name: "steam-persona-daily",
    title: "Steam 横断レビュアー収集 (毎朝)",
    description: "Discutere の steam-persona パイプライン (新作レビュー定期取得 → 横断投稿者検出 → 集中収集、spec/feature/crawler/STEAM-PERSONA.md) を日次で 1 周回す。Timer Delegation が毎朝 7:40 JST に invoke する。2026-08-13 neco 指示で新設。2026-08-20 neco 指示でパートタイマーから Haiku を除外 (auto-mode 不可・処理能力不足) し Sonnet 5 へ変更。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🎮",
    prompt_template: [
      "## Steam 横断レビュアー収集 — ${date}",
      "",
      "Discutere の steam-persona 収集を 1 周回す回です。実装・コード修正・commit・PR 作成はしません。",
      "",
      "### 手順",
      "1. cwd (E:\\Document\\Ars\\Discutere) で `npm run steam-persona` を実行する。",
      "   polite delay (1200ms/リクエスト) 支配で数十分かかることがある。完走を待つ。",
      "2. stdout 末尾のサマリ JSON (scanned / trackedNew / trackedTotal / sightings / detected /",
      "   collectedAuthors / collectedReviews) を読み取る。",
      "3. エラーで落ちた場合はエラーメッセージを要約して報告する (リトライは 1 回まで)。",
      "",
      "### 報告",
      "サマリ JSON の数値と、新たに検出・収集された投稿者数、出力先",
      "(data/external/steam-persona/authors/) の JSONL 増分を簡潔にまとめる。",
      "Steam アカウント ID・レビュー本文・認証情報・内部 endpoint・絶対パスは最終報告に載せない。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Discutere",
    is_active: true,
  },
  {
    call_name: "deps-sweep-daily",
    title: "日次依存関係点検",
    description: "LUDIARS の依存関係を日次で点検し、更新が必要なものを報告する。Timer Delegation が毎朝 7:10 JST に invoke する。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "🔍",
    prompt_template: [
      "## 日次依存関係点検",
      "",
      "LUDIARS の各リポジトリにある依存関係について、更新候補と影響を確認して報告する。",
      "依存関係の更新、コード修正、テスト実行、サービスの起動・再起動、commit、push、PR 作成はしない。",
      "",
      "最終報告には、確認したリポジトリ、更新候補、想定される影響、対応が必要な事項を簡潔にまとめる。",
      "",
      MENTION_ADMIN_STEP,
    ].join("\n"),
    input_schema: [],
    default_cwd: "E:\\Document\\Ars",
    is_active: true,
  },
  // ── Sol Ultra オーケストレータ版のデイリー突合レビュー ────────────
  {
    call_name: "ludiars-review-daily-dual",
    title: "毎日レビューちょいつよ版",
    description: "service-map.json の Tier 1 リポについて、ローカル main の一時 worktree と前回レビュー日時から累積 diff を作り、Codex と Claude Opus の所見を突合して E:DocumentArsReview に保存する。GitHub へはアクセスしない。プロンプト正本は LUDIARS/docs/REVIEW-PROMPTS.md。GPT-5.6 Sol Ultra のオーケストレータ版。cron の既定は単一オーケストレータ版 (ludiars-review-weekly、毎週月曜 4:40 JST) なので、こちらは手動起動用。",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    runtime_options: { model_reasoning_effort: "ultra" },
    category: "parttimer",
    emoji: "⚖️",
    prompt_template: [DAILY_REVIEW_RECONCILIATION_PROMPT, MENTION_ADMIN_STEP].join("\n\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Concordia",
    is_active: true,
  },
  // ── タスク種別別 Delegation Caller (実装委託の claude-*-impl とは別軸) ──
  {
    call_name: "design-hard-fable5",
    title: "高難度設計・課題解決委託 (Fable 5)",
    description: "難所の設計判断や複雑な課題解決を Fable 5 に委託する。複数案を比較しトレードオフを明示、結論は spec/plan/ 形式の設計書として出力する (実装はしない)。",
    target_provider: "claude",
    model: "claude-fable-5",
    category: "freelancer",
    emoji: "🧩",
    prompt_template: [
      "Work through the following hard design problem in ${target_repo}:",
      "",
      "${problem}",
      "",
      "${context_extra:}", "",
      "Requirements:",
      "- 複数の解決案を比較し、それぞれのトレードオフを明示する。",
      "- 結論と推奨案を spec/plan/<slug>.md 形式のドキュメントとして書く (実装はしない)。",
      "- Follow LUDIARS conventions (CLAUDE.md / spec 分類は FORMAT_SPEC.md)。",
      "",
      "完了したら生成したドキュメントのパスを報告する。",
    ].join("\n"),
    input_schema: [
      { name: "problem", type: "string" as const, required: true, description: "解決すべき難所・課題" },
      { name: "target_repo", type: "string" as const, required: true, description: "Absolute path of the target repository" },
      { name: "context_extra", type: "string" as const, required: false, description: "Optional extra context to prepend" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  {
    call_name: "design-analysis-opus",
    title: "設計・提案・分析委託 (Opus 5)",
    description: "現状分析・改善提案・影響範囲の整理を Opus 5 に委託する。実装はせず、分析結果を spec/faq/ (kind: design) 形式のドキュメントとして出力する。",
    target_provider: "claude",
    model: "claude-opus-5",
    category: "freelancer",
    emoji: "🔬",
    prompt_template: [
      "Analyze the following in ${target_repo} and propose an approach:",
      "",
      "${topic}",
      "",
      "${context_extra:}", "",
      "Requirements:",
      "- 現状分析 → 改善提案 → 影響範囲、の順で整理する。",
      "- 結論は spec/faq/<slug>.md (frontmatter kind: design) として書く (実装はしない)。",
      "- Follow LUDIARS conventions (CLAUDE.md / FORMAT_SPEC.md)。",
      "",
      "完了したら生成したドキュメントのパスを報告する。",
    ].join("\n"),
    input_schema: [
      { name: "topic", type: "string" as const, required: true, description: "分析・提案の対象" },
      { name: "target_repo", type: "string" as const, required: true, description: "Absolute path of the target repository" },
      { name: "context_extra", type: "string" as const, required: false, description: "Optional extra context to prepend" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  // レビュー起動は review-duo に一本化 (2026-07-17 neco 指示)。旧テンプレは無効化して残す。
  {
    call_name: "review-sonnet5",
    title: "レビュー委託 (Sonnet 5) [旧・review-duo に統合]",
    description: "旧レビュー起動。review-duo (Opus × Sol xhigh 突合) に一本化したため無効。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "freelancer",
    emoji: "🔍",
    prompt_template: "review-duo を使用してください。",
    input_schema: [],
    default_cwd: "${target_repo}",
    is_active: false,
  },
  // ── 既定のレビュー起動 (1 本だけ): Opus × Sol xhigh の突合 ──
  {
    call_name: "review-duo",
    title: "レビュー (Opus × Sol xhigh 突合)",
    description: "対象を Claude Opus 5 と Codex GPT-5.6 Sol (xhigh) に独立レビューさせて突合する既定のレビュー起動。結果は E:\\Document\\Ars\\Review\\<リポ名>\\<日付>\\ に保存。起動後も追加指示 (inject) でモデル構成・範囲を調整できる。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "freelancer",
    emoji: "⚖️",
    sort_order: 105,
    prompt_template: [
      "## 突合レビュー — ${target_repo}",
      "",
      "あなたはオーケストレータ。レビュー本文は自分で書かず、2 レビュアーを独立に走らせて所見を突合する。",
      "",
      "対象: ${target}",
      "",
      "${context_extra:}", "",
      "### レビュアー既定 (入力パラメータ / 起動後の追加指示で変更可)",
      "- Reviewer A: `claude -p --model claude-opus-5`",
      "- Reviewer B: `codex exec` — model gpt-5.6-sol, `model_reasoning_effort=\"${sol_effort:xhigh}\"`",
      "- 互いの所見は見せない (独立レビュー)。",
      "",
      "### レビュー作法 (遵守)",
      "- worktree の生成・ブランチ切り替えは行わない。main 最新 (または指示されたブランチ/worktree) の上で読む。",
      "- コードの修正・git 操作 (add/commit/push) はしない。",
      "- 指摘は Critical/High/Medium/Low の重大度 + file:line (推測禁止)。",
      "- AIFormat (`E:\\Document\\Ars\\AIFormat\\REVIEW.md`) の評価の決定ルールに準拠する。",
      "",
      "### 出力",
      "- 両者の所見を file:line で突合し、一致 / 片方のみ を整理する。",
      "- 結果一式を `E:\\Document\\Ars\\Review\\<リポ名>\\<YYYY-MM-DD>\\` に保存する (レビューの配置フォルダは Review が正本)。",
      "- 最終サマリ (一致 High / 不一致 / 総件数 / 保存先) を報告する。",
      "",
      "起動後にユーザから追加指示 (inject) が来たら、モデル構成・対象範囲・深さをその指示に合わせて調整して続行する。",
    ].join("\n"),
    input_schema: [
      { name: "target", type: "string" as const, required: true, description: "レビュー対象 (PR URL / diff / リポ全体 等)" },
      { name: "target_repo", type: "string" as const, required: true, description: "Absolute path of the target repository" },
      { name: "sol_effort", type: "string" as const, required: false, description: "Codex Sol の reasoning effort (既定 xhigh)" },
      { name: "context_extra", type: "string" as const, required: false, description: "Optional extra context to prepend" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  {
    // Test Forum の投稿検知で自動起動するテスト・QA セッション (spec/feature/revisor-test-forum-sync.md)。
    // 投稿 (テスト候補) の内容確認・調整が仕事で、 マージ判断はしない。
    call_name: "test-qa",
    title: "テスト・QA (Test Forum 候補の検証)",
    description: "Revisor で Open / Test OK になったテスト候補の内容を確認・調整する。Test Forum の投稿検知で Cc が自動起動する。",
    target_provider: "claude" as const,
    model: "claude-sonnet-5",
    emoji: "🧪",
    category: "test-qa" as const,
    sort_order: 160,
    prompt_template: [
      "あなたはテスト・QA 担当です。Revisor のローカル審査を通過した以下のテスト候補について、内容の確認と調整を行ってください。",
      "",
      "- Repository: ${repository}",
      "- Local PR: #${pr_number} ${pr_title}",
      "- Test Forum thread: ${thread_id}",
      "${details:}",
      "",
      "### 作法",
      "- 対象リポジトリの main とレビュー済みブランチを読み、変更内容がタイトル・説明と一致しているか確認する。",
      "- 実行して安全なテスト (unit 等) があれば流し、結果を確認する。動作確認が必要と示されている場合は、確認手順を整理して報告する。",
      "- コードの修正・マージ・push はしない。マージ判断は人間が行う。",
      "- Test Forum の投稿 (thread) はあなたが閉じない。閉じる操作は Cc の同期が行う。",
      "- 確認結果 (OK / 懸念 / 追加で人間が見るべき点) を報告して終了してよい。end-session で終了しても投稿は残る。",
    ].join("\n"),
    input_schema: [
      { name: "repository", type: "string" as const, required: true, description: "対象リポジトリ (org/name)" },
      { name: "pr_number", type: "string" as const, required: true, description: "Revisor local PR 番号" },
      { name: "pr_title", type: "string" as const, required: true, description: "PR タイトル" },
      { name: "thread_id", type: "string" as const, required: true, description: "Test Forum の thread id" },
      { name: "target_repo", type: "string" as const, required: false, description: "Absolute path of the target repository" },
      { name: "details", type: "string" as const, required: false, description: "判断事項・リスク等の要約" },
    ],
    default_cwd: "${target_repo}",
    is_active: true,
  },
  ...VULTUS_CATALOG_TEMPLATES,
  ...GENIUS_INGEST_TEMPLATES,
];

export function seedDelegationTemplates(repo: DelegationRepo): void {
  for (const tpl of SEED_TEMPLATES) {
    repo.upsertTemplate(tpl);
  }
  // 既定2件 (forum-claude-session / forum-codex-session) は forum_tag を常に維持し、
  // 必ず forum spawn の入口を用意する。 カスタム forum template が存在しても既定を
  // 無効化せずマージする (以前は「カスタムが1件でもあれば既定2件の forum_tag を
  // false に上書きする」実装だったため、 再起動のたびに既定の Discord タグが消え、
  // Discord 側の既存タグと不整合を起こしていた)。 合計 10 件の上限は
  // validateForumTemplateTags (forum-template-tags.ts) が sync 時に明示エラーで
  // 検出するので、 ここで先回りして黙って間引く必要はない。
  for (const template of FORUM_SESSION_TEMPLATES) {
    repo.upsertTemplate(template);
  }
  // 旧 seed `gamma-impl` (target_provider=gamma) の置換。 新 seed は別 call_name
  // (gemma4-12-impl) で upsert されるため、 既存 DB には旧行が残る。 重複を避けるため
  // 旧行があれば deactivate する (削除はせず is_active=0 で残す)。 fresh DB では no-op。
  const legacy = repo.findTemplateByCallName("gamma-impl");
  if (legacy) repo.deactivateTemplate(legacy.id);
  const legacySonnet = repo.findTemplateByCallName("claude-sonnet-4-6-impl");
  if (legacySonnet) repo.deactivateTemplate(legacySonnet.id);
  const legacyOpus = repo.findTemplateByCallName("claude-opus-4-8-impl");
  if (legacyOpus) repo.deactivateTemplate(legacyOpus.id);
  const legacyDailyReconciliation = repo.findTemplateByCallName("daily-review-reconciliation");
  if (legacyDailyReconciliation) repo.deactivateTemplate(legacyDailyReconciliation.id);
  // 2026-08-08 neco 指示: 毎日 → 週次へ変更。旧 call_name は ludiars-review-weekly に置き換えたため deactivate。
  const legacyDailyReview = repo.findTemplateByCallName("ludiars-review-daily");
  if (legacyDailyReview) repo.deactivateTemplate(legacyDailyReview.id);
}
