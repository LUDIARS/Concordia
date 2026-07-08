/**
 * 初期 delegation テンプレート (3 本)。
 * boot 時に upsert される (call_name が存在しなければ作成、 あれば content を上書き)。
 * ユーザが GUI で is_active を 0 にすれば disable できる。
 */

import type { DelegationRepo, CreateTemplateInput } from "../db/delegation-repo.js";

const SEED_TEMPLATES: CreateTemplateInput[] = [
  {
    call_name: "impl-from-design",
    title: "設計書から実装 (Codex)",
    description: "Claude などが書いた設計書 / spec を Codex に渡して実装させる。 LUDIARS の規約 (feat branch + PR + vitest) を守らせる。",
    target_provider: "codex",
    call_only: true,
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
    call_only: true,
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
    call_only: true,
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
  {
    call_name: "task-process",
    title: "タスク処理",
    description: "Memoriaから残タスクを確認して実行する。どのプロジェクトの作業をするかはユーザーに質問形式で問い合わせる。delegate-task リアクションワークフロー (🤝) のデフォルトテンプレート。",
    target_provider: "claude",
    model: "claude-sonnet-5",
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
];

export function seedDelegationTemplates(repo: DelegationRepo): void {
  for (const tpl of SEED_TEMPLATES) {
    repo.upsertTemplate(tpl);
  }
  // 旧 seed `gamma-impl` (target_provider=gamma) の置換。 新 seed は別 call_name
  // (gemma4-12-impl) で upsert されるため、 既存 DB には旧行が残る。 重複を避けるため
  // 旧行があれば deactivate する (削除はせず is_active=0 で残す)。 fresh DB では no-op。
  const legacy = repo.findTemplateByCallName("gamma-impl");
  if (legacy) repo.deactivateTemplate(legacy.id);
  const legacySonnet = repo.findTemplateByCallName("claude-sonnet-4-6-impl");
  if (legacySonnet) repo.deactivateTemplate(legacySonnet.id);
}
