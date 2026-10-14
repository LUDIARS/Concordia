/**
 * バグ報告の仕分けを起動する委託テンプレート (spec/feature/bug-bounty.md §5)。
 *
 * 読み取り専用 (CC-BOUNTY-INV-01): 起動引数で編集・シェル・push の道具を塞ぐ (`tool_policy: "read_only"`、
 * provider-preset.ts が `--disallowedTools` に変換する)。 結果は MCP ツール `bounty_triage_result` で返す
 * (シェル無しで返せるように)。 依頼文 (`task`) は Cc が組み立て (triage-prompt.ts)、報告の本文は資料の区切りの中に入る。
 *
 * call_name に review を含めるのは、作業マニュアルの kind を「レビュー」にするため (manual-kind.ts)。
 * 「実装」だと Actio タスクの封印・worktree・PR を促し、読み取り専用の契約と衝突する。
 * 起動は bug-bounty の triage-service だけ (spawn 一覧には出さない = call_only)。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 */

import type { CreateTemplateInput } from "../db/delegation-repo.js";

/** 仕分けの委託テンプレートの call_name。 */
export const BOUNTY_TRIAGE_CALL_NAME = "bounty-triage-review";

export const BOUNTY_TRIAGE_TEMPLATE: CreateTemplateInput = {
  call_name: BOUNTY_TRIAGE_CALL_NAME,
  title: "バグ報告の仕分け (読み取り専用レビュー)",
  description: "バウンティに届いたバグ報告 1 件を、対象プロジェクトのコードと spec を読んで採用・重複・対象外・情報不足に仕分ける。Cc の bug-bounty が受付後に起動する。",
  target_provider: "claude",
  model: "claude-sonnet-5-5",
  runtime_options: { effort: "medium", thinking: false, tool_policy: "read_only" },
  call_only: true,
  category: "freelancer",
  sort_order: 47,
  emoji: "🐞",
  prompt_template: "${task}",
  input_schema: [
    { name: "task", type: "string", required: true, description: "Cc が組み立てた仕分けの依頼文 (報告の本文は資料の区切りの中)" },
    { name: "target_repo", type: "string", required: true, description: "対象プロジェクトの作業領域 (cwd)" },
  ],
  default_cwd: "${target_repo}",
  is_active: true,
};
