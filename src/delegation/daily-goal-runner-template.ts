/**
 * デイリーゴール自走 (WM-2) の専用セッションを起動するテンプレート。
 *
 * @implements spec/feature/daily-goal-run.md — 3. 専用セッションを起動する
 *
 * 依頼文に入れるのはゴール文・受入条件・許可範囲・Actio task ID と、 作業の手順だけ。
 * 起動は daily-goal-run の scheduler だけが行う (spawn 一覧には出さない = call_only)。
 */

import type { CreateTemplateInput } from "../db/delegation-repo.js";

export const DAILY_GOAL_RUNNER_TEMPLATE: CreateTemplateInput = {
  call_name: "daily-goal-runner",
  title: "デイリーゴール自走 (Opus 5.5)",
  description: "人間が確定したその日のゴール 1 件を、専用セッションで Goal & Go により進める。Cc の daily-goal-run が起動時刻に invoke する。",
  target_provider: "claude",
  model: "claude-opus-5-5",
  runtime_options: { effort: "medium", thinking: false },
  emoji: "🎯",
  category: "employee",
  sort_order: 145,
  call_only: true,
  prompt_template: [
    "# デイリーゴール ${daily_goal_id}",
    "",
    "## ゴール",
    "${goal_text}",
    "",
    "## 受入条件",
    "${acceptance}",
    "",
    "## 許可範囲",
    "${permissions}",
    "",
    "## 対応する Actio task",
    "${actio_tasks}",
    "",
    "## 手順",
    "- 作業場所は ${target_repo}。プロジェクトの規則 (task worktree / direct-main) に従う。",
    "- ゴールの範囲だけで作業する。セッション外の task (Actio の他の未着手 task、git diff の残り、TODO など) を持ち込まない。",
    "- 許可範囲に無い操作 (不可のマージ・テスト・サービス操作・反映) が必要になったら、実行せずに ask で聞いて止まる。",
    "- Actio の task 状態は Cc から書き換えない。残りを翌日のゴールへ自動で持ち越さない。",
    "- Cc が 1 時間ごとに確認の inject を送る。進捗確認には「進み具合 (受入条件ごと) / 次の 1 時間でやること / 人間判断が要る点」の形で答え、",
    "  同じ内容を POST ${concordia_url}/v1/daily-goals/${daily_goal_id}/report に {\"session_id\":\"<自分>\",\"report\":\"…\"} で送る。",
    "- 完了確認には、受入条件と Actio task の一つずつについて完了か・残りは何かを確かめて答える。",
    "- 受入条件がすべて満たせたら POST ${concordia_url}/v1/daily-goals/${daily_goal_id}/reached に、受入条件ごとの証跡 (commit / PR / Actio task) を付けて報告する。",
    "  Cc が証跡を照合できない項目があれば到達にならず、続行 (GO) が返る。",
    "- 残りがすべて達成不能 (理由付き) か人間判断待ち (未回答の質問・人間依頼) になったら POST ${concordia_url}/v1/daily-goals/${daily_goal_id}/exhausted に残りの一覧を送る。",
    "  AI だけで進められる残り (doable) が 1 件でもあれば認められず、続行 (GO) が返る。",
    "- 止まる条件はゴール到達・十分にこなした・人間の停止の 3 つだけ。時刻や停滞を理由に自分で止めない。終了の通知を受けたら既存の session-end 手順で終える。",
  ].join("\n"),
  input_schema: [
    { name: "daily_goal_id", type: "string", required: true, description: "Cc の daily goal id" },
    { name: "target_repo", type: "string", required: true, description: "作業する repository の絶対パス" },
    { name: "goal_text", type: "string", required: true, description: "ゴール文" },
    { name: "acceptance", type: "string", required: true, description: "受入条件 (番号付き、改行区切り)" },
    { name: "permissions", type: "string", required: true, description: "許可範囲 (マージ / テスト / サービス操作 / 反映 の可否)" },
    { name: "actio_tasks", type: "string", required: true, description: "対応する Actio task の参照" },
    { name: "concordia_url", type: "string", required: true, description: "報告 API の Cc URL" },
  ],
  default_cwd: "${target_repo}",
  is_active: true,
};
