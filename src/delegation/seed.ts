/**
 * 初期 delegation テンプレート (3 本)。
 * boot 時に upsert される (call_name が存在しなければ作成、 あれば content を上書き)。
 * ユーザが GUI で is_active を 0 にすれば disable できる。
 */

import type { DelegationRepo, CreateTemplateInput } from "../db/delegation-repo.js";

const CLAUDE_TEMPLATE_SORT_ORDER = {
  "fable-5": 10,
  "opus-4-8": 30,
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
      "- Add or update tests; all relevant tests must pass.",
      "- Make 1 PR (squash mergeable). Follow CLAUDE.md / dev-process.md.",
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

const SEED_TEMPLATES: CreateTemplateInput[] = [
  {
    call_name: "impl-from-design",
    title: "設計書から実装 (Codex)",
    description: "Claude などが書いた設計書 / spec を Codex に渡して実装させる。 LUDIARS の規約 (feat branch + PR + vitest) を守らせる。",
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
      "- Add or update vitest tests; all tests must pass.",
      "- Make 1 PR (1 commit if possible) — squash mergeable.",
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
      "- Reproduce the issue first (add a failing test if practical).",
      "- Apply the minimal fix; no unrelated refactors.",
      "- Add a regression test that would catch this in CI.",
      "- Create a feature branch (fix/<short-slug>) + PR.",
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
      "- Behavior must be unchanged (existing tests stay green).",
      "- Add or strengthen tests where helpful, but don't pad them.",
      "- No drive-by changes outside the target.",
      "- Create a feature branch (refactor/<short-slug>) + PR.",
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
  ...(["opus-4-8", "sonnet-5", "fable-5", "haiku-4-5"] as const).map((tier) => {
    const meta = {
      "opus-4-8": { id: "claude-opus-4-8", label: "Opus 4.8", note: "最上位。 設計判断や難所の実装向き。", emoji: "🧙‍♂️" },
      "sonnet-5": { id: "claude-sonnet-5", label: "Sonnet 5", note: "中位。 一般的な実装の主力。", emoji: "🧑‍💼" },
      "fable-5": { id: "claude-fable-5", label: "Fable 5", note: "高速。 軽量〜中規模タスク向き。", emoji: "🦸" },
      "haiku-4-5": { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "超高速・軽量タスク向き。", emoji: "🗣️" },
    }[tier];
    return {
      call_name: `claude-${tier}-impl`,
      title: `実装委託 (Claude ${meta.label})`,
      description: `Claude Code (${meta.label}) に実装を委託する。${meta.note} LUDIARS 規約 (feat branch + PR + vitest) を守らせる。`,
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
        "- Add or update vitest tests; all tests must pass.",
        "- Make 1 PR (squash mergeable). Follow CLAUDE.md / dev-process.md.",
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
      "3. **実装系**: 優先度・インパクト順に1件ずつ着手し、各タスクは小さな完了単位で実装・検証・報告する。",
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
    default_cwd: "E:\\Document\\Ars",
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
      "- Add or update tests; make them pass before reporting done.",
      "- Make 1 PR (squash mergeable). Follow CLAUDE.md / dev-process.md.",
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
  // ── 毎朝 5 時の Timer Delegation (AIFormat + spec 追随チェック) ────────
  // Morning Tasks と同じ内部 Timer Delegation (src/scheduler/cron-scheduler.ts、
  // ジョブ定義は cron-jobs.ts) が毎日 5:07 JST に本テンプレを invoke する。
  // 安全範囲の autofix は自分でやらず daily-review-autofix (Codex) に委託させる。
  {
    call_name: "ludiars-review-daily",
    title: "日次レビュー (Claude)",
    description: "LUDIARS 全 active リポを AIFormat に沿ってレビューし、spec/ が実装に追随できているか (FORMAT_SPEC.md §10) も確認する。安全範囲の自動修正は自分で行わず daily-review-autofix (Codex) に委託する。Morning Tasks と同じ Timer Delegation が毎日5:07 JSTにinvokeし、記録は E:DocumentArsReview に保存する (配置フォルダの正本)。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "📋",
    prompt_template: [
      "## LUDIARS 全リポ日次レビュー — ${date}",
      "",
      "AIFormat (`E:\\Document\\Ars\\AIFormat\\REVIEW_*.md`、 spec 追随は `FORMAT_SPEC.md` §10) に沿って",
      "LUDIARS 全 active リポをレビューし、レビュー記録をローカル専用の `E:\\Document\\Ars\\Review\\<repo>\\${date}\\` に保存する。",
      "Review/ への書き込みはローカルのみ。Castra で git add / commit / push はしない。",
      "",
      "### 手順",
      "1. `E:\\Document\\Ars\\` 配下で origin が `github.com/LUDIARS/` のリポを列挙する (worktree / 複製は1件にまとめる)。",
      "2. AIFormat の `REVIEW.md` + 5 本の `REVIEW_*.md` を読み、テンプレ構造を把握する。",
      "3. リポごとに Explore agent を並列起動し、対象コミット範囲の差分を軸にレビューする。",
      "   `FORMAT_SPEC.md` §10 の spec 追随チェックを必ず行う: 実装差分に spec/ が追随できていなければ、",
      "   機械的に導出可能な内容は spec/ に新規ファイルとして生成 (既存ファイルは上書きしない)、",
      "   無理なら該当ファイル冒頭に `SPEC-TODO` マーカーを付ける。",
      "4. 各リポの安全範囲の指摘 (lint / typo / unused_import / dead_code / gitignore / toc / spec_gen) を",
      "   file:line + 概要で1件ずつまとめる。",
      "5. **自分でブランチを切って修正しない。** 安全範囲の指摘が1件以上あるリポごとに、",
      "   MCP tool `delegation_invoke` (server: concordia-delegation) を呼び、",
      "   call_name=\"daily-review-autofix\" に `target_repo` / `repo_name` / `date` / `fixes` (指摘一覧テキスト) を渡して",
      "   Codex に autofix を委託する (自分は git 操作をしない)。",
      "6. レビュー記録 (REVIEW*.md 6本 + AUTOFIX.md + latest.json) を `E:\\Document\\Ars\\Review\\<repo>\\${date}\\` に書く。",
      "   Castra で `git add` / `git commit` / `git push` を行わず、既存の追跡済み `Review/` も変更しない。",
      "7. 完了したら対象リポ数・重大指摘・autofix 委託件数をサマリとして報告する。",
      "",
      "詳細手順: `E:\\Document\\Ars\\.claude\\skills\\ludiars-review\\SKILL.md`。",
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars",
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
  // ── 毎朝 5:10 のデイリー突合レビュー (Codex × Opus 独立レビュー + 突合) ──
  // cron-jobs.ts が毎日 5:10 JST に invoke する。 対象は LUDIARS/service-map.json の
  // daily_review=true リポ (Tier 1)。 プロンプト正本は LUDIARS/docs/REVIEW-PROMPTS.md
  // (二重管理しない — 本テンプレはオーケストレーション手順のみ持つ)。
  // 旧 ludiars-review-daily は新運用の安定確認まで並走し、 その後停止する
  // (LUDIARS/docs/REVIEW-STRATEGY.md §7 O2)。
  {
    call_name: "daily-review-reconciliation",
    title: "デイリー突合レビュー (Codex × Opus)",
    description: "service-map.json の Tier 1 リポについて、前回レビュー HEAD からの累積 diff を Codex と Claude Opus に独立レビューさせ、所見を突合して E:DocumentArsReview に保存する。High 一致は GitHub Issue 化。プロンプト正本は LUDIARS/docs/REVIEW-PROMPTS.md。Timer Delegation が毎朝 5:10 JST に invoke する。",
    target_provider: "claude",
    model: "claude-sonnet-5",
    category: "parttimer",
    emoji: "⚖️",
    prompt_template: [
      "## デイリー突合レビュー — ${date}",
      "",
      "あなたはオーケストレータ。レビュー本文は書かず、Codex と Claude Opus の 2 レビュアーを回して所見を突合する。",
      "",
      "### 正本 (最初に必ず読む)",
      "- 手順・プロンプト・突合ルール: `E:\\Document\\Ars\\LUDIARS\\docs\\REVIEW-PROMPTS.md`",
      "- 対象リポ: `E:\\Document\\Ars\\LUDIARS\\service-map.json` の `daily_review: true` (Tier 1)",
      "",
      "### 手順",
      "1. service-map.json から対象リポを列挙。各リポの前回レビュー HEAD は `E:\\Document\\Ars\\Review\\<repo>\\latest.json` の `head` (無ければ直近 24h の main 差分)。",
      "2. 前回 HEAD == 現 HEAD のリポはスキップし「変更なし」と記録する。",
      "3. リポごとに REVIEW-PROMPTS.md §1 の入力を構築し、§3 のプロンプトで `codex exec` を、§4 のプロンプトで `claude -p --model claude-opus-4-8` を起動する (互いの所見は見せない)。",
      "4. §5 の突合ルールで機械マージ: file:line 実在検証 → ±5 行一致判定 → 両者一致の High 以上は対象リポへ GitHub Issue 作成。",
      "5. 結果を `E:\\Document\\Ars\\Review\\<repo>\\${date}\\` に保存し `latest.json` の `head` を現 HEAD へ更新する。",
      "   Review/ への書き込みはローカルのみ。Castra で `git add` / `git commit` / `git push` は行わない。",
      "6. 新規指摘より先に open な指摘 Issue の解消確認 (resolved_checks) を行い、未対応 High は放置日数付きでレポート先頭に出す。",
      "7. 最終サマリ (対象数 / 変更なし数 / 一致・不一致所見数 / Issue 化件数 / unreviewed) を報告する。",
      "",
      "自分でコード修正はしない。レビュアーの JSON が契約 (§2) を破ったら 1 回だけ再問い合わせ、それでも破れば該当リポを failed として記録し他リポを続行する。",
    ].join("\n"),
    input_schema: [
      { name: "date", type: "string" as const, required: true, description: "実行日 (YYYY-MM-DD)" },
    ],
    default_cwd: "E:\\Document\\Ars",
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
    title: "設計・提案・分析委託 (Opus 4.8)",
    description: "現状分析・改善提案・影響範囲の整理を Opus 4.8 に委託する。実装はせず、分析結果を spec/faq/ (kind: design) 形式のドキュメントとして出力する。",
    target_provider: "claude",
    model: "claude-opus-4-8",
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
    description: "対象を Claude Opus 4.8 と Codex GPT-5.6 Sol (xhigh) に独立レビューさせて突合する既定のレビュー起動。結果は E:\\Document\\Ars\\Review\\<リポ名>\\<日付>\\ に保存。起動後も追加指示 (inject) でモデル構成・範囲を調整できる。",
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
      "- Reviewer A: `claude -p --model claude-opus-4-8`",
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
}
