# Cc 委託フローの停止点を 3 つ潰す (段階注入廃止 / 契約カード撤廃 / 待機文面)

## 目的

Concordia の委託セッションが「終わらない・止まる・人間を呼ぶ」3 つの経路を塞ぐ
(2026-08-21 neco 指示)。

1. 二段階のタスク渡し (調査ブリーフ → 実装タスク) をやめる。 コードベース把握は
   Anatomia の解析グラフで委託先が自走できる。
2. タスクが終わったら委託先はその場で session-end する。 次のタスクを拾わせない。
3. plan か vibes かの判断ダイアログを撤廃する。 判断に意味が無く、 未回答の間は
   `contract-incomplete` が編集を deny するため Task Workflow 内で停止バグになっていた。
4. タスク未指定 spawn の文面を「何もするな」から「追加のタスク指示があるまで待機せよ。
   質問はするな。判断もするな。」へ変える (spawn 直後の質問を止める)。

## 変更

- `delegation/implementation-inject.ts` (旧 `staged-injection.ts`): 初回 inject を
  why + タスク本文 + Memoria + 完了条件の 1 通に統合。 調査ブリーフ・段階判定を削除。
- `delegation/memoria-task.ts` (新): Memoria 追跡タスクの起票を第 2 段階から起動時へ移設。
  fail-soft (未起票の理由は本文へ書く)。 冪等性は `delegation_runs.memoria_task_id`。
- `delegation/persona-context.ts`: 作業姿勢を 1 本化 (「通常の不明点で停止しない」)。
  Anatomia 解析グラフの案内と「終わったら session-end / 次を拾わない」節を追加。
- 削除: `delegation/staged-followup.ts`、 `POST /v1/delegation/runs/:id/investigated`、
  設定 `workflow.delegation_staged_injection_enabled`。 DB 列は残置 (既存行の読み出し用)。
- `contract/seed-rules.ts`: mode を決定論で決め切る (高リスク語 → plan、 それ以外 → vibes)。
  work_location / acceptance / testing_claim も seed で確定。
- `contract/lifecycle.ts`: 保存前に `finalizeContract` で未決を埋め切る backstop
  (model/effort は現 runtime、 vibes の testing service は catalog 解決)。
- `contract/question-bridge.ts`: 契約カード (plan/vibes) の投稿と回答処理を削除。
  残るカードはチーム選択のみ。
- `shared/session-task.ts`: `BLANK_SESSION_TASK` の文面変更。

## 完了条件

- [x] 仕様を更新した (`spec/feature/delegation-implementation-inject.md` 新規、
      `session-contract.md` §3.3、 `vibes-mode.md` §1、 `discord-session-task-post.md`)
- [x] 実装した
- [x] 回帰テストを追加/更新した (implementation-inject / memoria-task / persona-context /
      question-bridge / lifecycle)
- [x] typecheck + vitest 全緑
- [ ] Revisor local PR を提出した

## 残件 (このタスクでは触らない)

- mode=plan と判定されたセッションは `plan_approved` が立つまで編集が全 deny になる
  (Director の設計カード承認が要る)。 委託セッションが plan 判定に落ちた場合の扱いは別途。
- **vibes 述語の発火母数が広がった (要観察)。** これまで mode は契約カードに回答が付くまで
  null で、 `vibesScope` / `vibesFileLimit` はどちらも `contractMode !== "vibes"` で
  素通りしていた。 mode を決定論で決め切ったことで、 高リスク語に当たらない全セッションが
  vibes になり、 2 つの deny が初めて常時有効になる。
  - `vibes-file-limit`: 既定 20 ファイル超で deny。 昇格カード (`mode-switch.ts`) で
    plan へ上げれば続行できる。 参考までに、 この PR 自体は 28 ファイルに触っている。
  - `vibes-scope`: `VIBES_PROTECTED_PATH` (migration/schema/auth/削除系のパス) を deny。
    判定軸が `PLAN_PATTERN` (タスク文言) と違って**パス**なので、 文言が低リスクでも
    `src/db/schema.ts` 等に触れる委託は落ちる。
  どちらも「止めない」 という本タスクの狙いとは逆に働き得るので、 実運用のログを見て
  閾値・保護パスを調整するか、 委託セッションを対象外にするかを別途判断する。
