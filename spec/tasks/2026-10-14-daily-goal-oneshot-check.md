---
type: task
title: "デイリーゴールを専用セッションから 1 時間ごとのワンショット確認と不調時の通知へ変える"
service: concordia
domain: daily-goal-run
status: done
source_session: lictor-8a895796-39c7-41f5-b360-84d55b75a785
related:
  - feature/daily-goal-run.md
  - feature/work-modes.md
taskflow_reference: "actio:e89dc53b-e1ed-43f5-a8c5-d8139280e1fe"
updated: 2026-10-14
---

# デイリーゴールを専用セッションから 1 時間ごとのワンショット確認と不調時の通知へ変える

正本: [daily-goal-run](../feature/daily-goal-run.md) の 2026-10-14 改訂。Actio: `actio:e89dc53b-e1ed-43f5-a8c5-d8139280e1fe`。
依頼: neco「専用セッション使われない率が高いから 1 時間おきにワンショットで進捗確認して、進捗が芳しくなかったら人間に通知する程度にとどめよう。」

## 分解

### spec と契約

- spec: 何をするか・経緯・用語・状態の所有者・流れ §3〜§6・予算・不変条件 (CC-DG-INV-01/02/05/06/07 の書き換え、
  通知の重複防止 CC-DG-INV-12 の追加)・受け入れ基準。work-modes の WM-2 行、domain 宣言、README。
- 契約 (augur.contracts.json): dg-C-4 (planCheckpoint) / dg-C-6 (evaluateExhausted) を外し、
  dg-C-12 `normalizeJudgment` / dg-C-13 `decideProgressAlert` を足す。

### 実装

- 純関数: `judgment-policy.ts` (確認の期限・判定の正規化・到達の照合)、`alert-policy.ts` (通知するか・続き具合)、
  `labels.ts` (表示用の 1 行)。
- port + adapter: `progress-judge.ts` (runClaude 会話のみを 1 回、目標と資料を区切るプロンプト)。
  `evidence.ts` に repo 単位の収集 (ローカル branch 全体の commit、repo origin の pr_records、Revisor local PR)。
- 保存: `daily_goals.alert_streak_since` / `alert_count`、`daily_goal_checkpoints.judgment`、`daily_goal_alerts`
  (`alert-repository.ts`)。repository の constructor で ALTER する (runMigrations の対象外なので凍結台帳は不要)。
- use case: `checkpoint.ts` (判定 → カード → 通知の積み込み)、`finish.ts` (到達・人間の停止・締切だけ)、`service.ts`。
- 撤廃: `launch.ts` / `launch-policy.ts` / `session-binding.ts` / `checkpoint-policy.ts` / `prompts.ts`、セッションの報告 API、
  `resetGoalAndGoBudget`、`daily-goal-runner` テンプレート (seed の置換済み一覧 `LEGACY_DELEGATION_CALL_NAMES` で定義行を物理削除)。
- Discord: カードの「判定」「残り」欄、不調の通知の配達 (スレッド → 無ければカードへの返信、
  `allowedMentions.users` に投稿者 1 人、判定文の mention 記法は無害化)。

### 再利用探索の採否

- 採用: 投稿の読み取りで使っている headless 実行 (`runClaude` 会話のみ、`HeadlessRunner` 型、`extractJson`) を判定にもそのまま使う。
- 採用: 証跡の収集 (`evidence.ts` の `parseCommitLog` / `prEvidence`、Revisor の行の変換) を repo 単位の収集でも共用する。
- 採用: 到達の照合は既存の `evaluateGoalReached` (dg-C-5) に、判定が挙げた実在の証跡だけを渡して使う。
- 採用: 通知の intent と結果不明の扱いは、既存のカード配達 (`daily_goal_cards` の claim / unknown / rejected) と同じ形にした。
- 不採用: 新しい migration (デイリーゴールのテーブルは repository constructor で作る既存方式のため)。

## 判断が要る点

- commit 証跡は、セッションが無いためプロジェクトの repo のローカル branch 全体から取る。同じ repo の無関係な commit も資料に入るが、
  到達の照合は判定が受入条件ごとに挙げた実在の証跡キーで行う (spec の既知の制約に記載)。
- 旧方式で走っているゴール (`confirmed` / セッション紐付きの `running`) は止めず、新方式の確認だけを受ける。
  セッションへの inject・自走の停止・方式の解除はしない。報告 API は削除したので、旧方式のセッションが報告 API を呼ぶと 404 になる。
- 判定の「到達」は実在の証跡キーが無ければ「見込みあり」に落とす。判定の失敗は不調の続き具合を変えない。
- 判定のモデルは投稿の読み取りと同じ Sonnet。

## 検証

- `tsc --noEmit -p tsconfig.json`: 通過。`tsconfig.test.json` は変更ファイルにエラー無し (main 由来の既存エラーのみ)。
- 変更ファイルに対応する vitest (daily-goal-run 全体、API、Discord のカード描画・投稿受付、goal-and-go、seed、delegation 回帰、配線): 全件通過。
- depcruise: 今回の変更に関わる違反なし (main 由来の既存違反のみ)。`augur tests lint`: 有効。
- サービスの起動・再起動・実 Discord での確認は未実施 (委託範囲外)。

## 受け入れ条件

- 投稿から 3 項目がそろえば登録し、セッションは起動しない。
- 1 時間ごとに判定を 1 回だけ呼び、証跡と判定 (状態・理由・受入条件ごとの見込み) が同じカードの更新で届く。
- 判定の入力はゴール文・受入条件・証跡・経過時間・締切までの残り時間だけで、証跡は資料として区切られている。
- 「遅れ気味」「停滞」のときだけ投稿者 1 人への mention で通知し、1 続きの不調では最初の 1 回と 3 時間後の 1 回まで。
- 判定の失敗は「判定できず」としてカードに出し、通知しない。
- 止まるのはゴール到達・人間の停止・締切の 3 つだけ。
- `daily-goal-runner` が seed から外れ、既存 DB の定義行も消える。
