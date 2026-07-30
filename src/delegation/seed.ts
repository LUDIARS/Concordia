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
}): CreateTemplateInput {
  return {
    call_name: `codex-5-6-${opts.callSuffix}`,
    title: `Implementation delegation (GPT-5.6 ${opts.label})`,
    description: `Delegate implementation work to Codex GPT-5.6 ${opts.label}.`,
    target_provider: "codex",
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
  codex56Template({ callSuffix: "sol-ultra", modelName: "sol", label: "Sol Ultra", emoji: "🌞", sort_order: 25, reasoning: "ultra" }),
  codex56Template({ callSuffix: "terra", modelName: "terra", label: "Terra", emoji: "🌏", sort_order: 50, reasoning: "xhigh" }),
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
const DAILY_REVIEW_PROMPT = [
  "## デイリーレビュー — ${date}",
  "",
  "### 正本 (最初に必ず読む)",
  "- レビュー観点・出力契約: `E:\\Document\\Ars\\LUDIARS\\docs\\REVIEW-PROMPTS.md`",
  "- 対象リポ: `E:\\Document\\Ars\\LUDIARS\\service-map.json` の `daily_review: true` (Tier 1)",
  "",
  "### 手順",
  "1. service-map.json から対象リポを列挙。今回 HEAD はローカル `refs/heads/<default-branch>` の SHA を正本とし、その SHA から detached の一時 review worktree を作る。",
  "   `git fetch` / `git pull` / `origin/*` / `gh` / GitHub API と現在 checkout 中の `HEAD` は使わない。",
  "   前回レビュー日時 (`latest.json.reviewed_at`、無ければ24時間前) 以降の main commit を一時 worktreeで確認し、無ければ変更なしとする。",
  "2. 前回 HEAD == 今回 HEAD は変更なし、今回 HEAD が前回 HEAD の祖先なら range_reversed としてレビューせず記録する。",
  "3. REVIEW-PROMPTS.md の入力・JSON契約・Claudeレビュー観点を使い、オーケストレータ自身が各リポを1回レビューする。別AIは起動しない。",
  "4. file:line の実在を検証し、結果を `E:\\Document\\Ars\\Review\\<repo>\\${date}\\` に保存して `latest.json` の `head` と `reviewed_at` を更新する。",
  "   Review/ への書き込みはローカルのみ。GitHub へのアクセスや push は行わず、一時 worktree は全経路で削除する。",
  "5. ローカル findings の未解決項目を確認 (resolved_checks) してから新規所見を扱い、未対応 High は放置日数付きでレポート先頭に出す。",
  "6. 最終サマリ (対象数 / 変更なし数 / 指摘数 / resolved_checks / failed) を報告する。",
  "",
  "自分でコード修正やIssue作成はしない。JSON契約を満たせないリポはfailedとして記録し、他リポを続行する。",
].join("\n");

// ── Genius (判断カード DB) の ingest 運用 ────────────────────────────────
// Genius 側 spec (`E:\Document\Ars\Genius\spec\feature\operations.md` §7) の
// 「Timer Delegation の実登録」は Concordia 側の実装項目である (Genius には自己申告
// できる設定ファイルも API も無く、cron は本ファイルと scheduler/cron-jobs.ts の
// 固定リストが正本)。本ブロックの 2 テンプレ + CRON_JOBS の 2 ジョブ
// (genius-ingest-tier2-nightly 3:10 / genius-ingest-daily 4:10 JST) でその登録は完了。
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
  "- Genius サービスの `GET http://127.0.0.1:4230/healthz` を確認する (port の正本は Excubitor catalog と",
  "  `genius.config.json`。応答が無い / 別 port の場合は設定を読んで確認する)。",
  "- サービスが起動していない場合、**起動・再起動は Excubitor / 人間の担当**なので自分では行わず、",
  "  「Genius サービス停止中のため ingest 未実行」と報告して終了する。",
  "",
  "### run の完了確認",
  "- CLI の成功は「非同期 run の受付成功」にすぎない。返った run id を控え、",
  "  `GET http://127.0.0.1:4230/api/clone/ingest/runs/<run id>` を polling して終了状態を確認する。",
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
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: GENIUS_REPO_PATH,
    is_active: true,
  },
];

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
    description: "ローカル LLM (Famulus 経由、Ollama 上の Gemma 4 等) に実装を委託する。API 課金ゼロ・ローカル完結。model='auto' で対象プロジェクトに合うモデルを Famulus の黒箱切り替え機 (FT registry + Sonnet ワンショット) が自動選択する。長いエージェントループは精度・速度が落ちるので小さく区切ったタスク向き。",
    target_provider: "gemma4-12",
    category: "employee",
    sort_order: 150,
    emoji: "🇬",
    // model="auto" → invoke 時に `famulus select --project <repo basename>` で自動選択
    // (service.ts / app.ts が resolveLocalModel で解決)。固定したいなら Ollama タグを直書き。
    model: "auto",
    prompt_template: [
      "Implement the following in ${target_repo}:",
      "",
      "${task}",
      "",
      "${context_extra:}", "",
      "Requirements:",
      "- Keep the change small and self-contained (local model — avoid sprawling multi-file edits).",
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
  // 単一オーケストレータ (Claude) 版。2026-07-27 neco 指示で dual (ちょいつよ) から
  // 日次 cron の既定へ巻き戻し。dual テンプレート自体は手動起動用に残す。
  {
    call_name: "ludiars-review-daily",
    title: "毎日レビュー",
    description: "Tier 1 リポの日次レビュー。単一オーケストレータ (Claude) が AIFormat に沿ってレビューし、Review/<repo>/<date>/ に保存する。ludiars-review-daily-dual (ちょいつよ版、Sol Ultra 突合) は手動起動用に残るが、日次 cron の既定はこちらに戻した。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "📋",
    prompt_template: DAILY_REVIEW_PROMPT,
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars\\Concordia",
    is_active: true,
  },
  {
    call_name: "daily-review-autofix",
    title: "日次レビュー安全修正委託 (Codex)",
    description: "ludiars-review-daily が見つけた安全範囲の指摘 (lint/typo/unused_import/dead_code/gitignore/toc/spec_gen) をまとめて Codex に適用させ、1 PR にする。call_only (人間向けドロップダウンには出さない)。",
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
  // ── Sol Ultra オーケストレータ版のデイリー突合レビュー ────────────
  {
    call_name: "ludiars-review-daily-dual",
    title: "毎日レビューちょいつよ版",
    description: "service-map.json の Tier 1 リポについて、ローカル main の一時 worktree と前回レビュー日時から累積 diff を作り、Codex と Claude Opus の所見を突合して E:DocumentArsReview に保存する。GitHub へはアクセスしない。プロンプト正本は LUDIARS/docs/REVIEW-PROMPTS.md。GPT-5.6 Sol Ultra のオーケストレータを Timer Delegation が毎朝 5:10 JST に invoke する。",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    runtime_options: { model_reasoning_effort: "ultra" },
    category: "parttimer",
    emoji: "⚖️",
    prompt_template: DAILY_REVIEW_RECONCILIATION_PROMPT,
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
}
