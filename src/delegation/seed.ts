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
  ...(["opus-4-8", "sonnet-4-6", "fable-5"] as const).map((tier) => {
    const meta = {
      "opus-4-8": { id: "claude-opus-4-8", label: "Opus 4.8", note: "最上位。 設計判断や難所の実装向き。" },
      "sonnet-4-6": { id: "claude-sonnet-4-6", label: "Sonnet 4.6", note: "中位。 一般的な実装の主力。" },
      "fable-5": { id: "claude-fable-5", label: "Fable 5", note: "高速。 軽量〜中規模タスク向き。" },
    }[tier];
    return {
      call_name: `claude-${tier}-impl`,
      title: `実装委託 (Claude ${meta.label})`,
      description: `Claude Code (${meta.label}) に実装を委託する。${meta.note} LUDIARS 規約 (feat branch + PR + vitest) を守らせる。`,
      target_provider: "claude" as const,
      model: meta.id,
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
    call_name: "gemma4-12-impl",
    title: "ローカル LLM 実装委託 (gemma4-12 / auto)",
    description: "ローカル LLM (Famulus 経由、Ollama 上の Gemma 4 等) に実装を委託する。API 課金ゼロ・ローカル完結。model='auto' で対象プロジェクトに合うモデルを Famulus の黒箱切り替え機 (FT registry + Sonnet ワンショット) が自動選択する。長いエージェントループは精度・速度が落ちるので小さく区切ったタスク向き。",
    target_provider: "gemma4-12",
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
}
