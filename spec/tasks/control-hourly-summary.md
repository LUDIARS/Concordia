---
task: control-hourly-summary
project: Concordia
kind: 実装
status: done
created: 2026-11-16T07:00:00.000Z
source_session: lictor-9fd85ee4-d7cd-4814-afe4-a93092a3fdbd
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# 管制チャンネルの 1 時間ごとのまとめ + 管制セッション起動の enrollment 修正

設計正本: `spec/feature/control-session.md` §7・§8、不変条件 CC-CTL-INV-07。

## 目的

- neco 指示 (2026-11-16)「管制チャンネルは 1 時間に 1 回まとめを投げてくる」。
- 本番で管制セッション第 1 世代が Cc に登録されず trust picker で止まった障害を直す。

## 変更した境界

- `src/control-session/hourly-summary.ts` (新規・純関数): 投稿の要否 (`isSummaryDue`) と本文 (`renderHourlySummary`)。進捗ボードだけを読み、`@` は全角にしてメンションにしない。
- `src/control-session/runtime.ts`: tick の最後に、ON・管制チャンネル用意済みのときだけまとめを投稿。投稿成功時だけ内部状態キー `control_session.summary_posted_at` を保存し、OFF で消す。管制セッション本体には送らない。
- 障害の原因: 管制の spawn は pending spawn (enrollment) を記録していなかったため、起動した Lictor の `POST /v1/sessions` が `invalid_or_consumed_session_enrollment` (401) になり、Lictor の `shouldSeedWorkspaceTrust` (登録済み + enrollment) が成り立たず trust が焼かれなかった。chores と同じく spawn 直前に `recordPendingDelegationSpawn` し、失敗時に取り消す (`runtime.ts` の `enrollment` 口 / `bootstrap/core.ts` の配線)。Lictor 側の変更は不要。
- `src/control-session/supervisor.ts`: spawnControl を 60 秒で打ち切り、例外も起動失敗として扱う。返らない起動があってもボード更新とまとめは続く。本番ログでは第 2 世代は第 1 世代の 300 秒後に起動しており、巡回自体は止まっていなかった (予防の追加)。

## 復旧方法

- まとめを止める: `session.control_session_enabled` を OFF (キーも消える)。コードを戻すならこの PR を revert。
- enrollment 記録は 5 分で消えるメモリ上の表だけなので、revert しても残骸は残らない。

## 検証

- 実施: `vitest run src/control-session/hourly-summary.test.ts src/control-session/runtime.test.ts src/control-session/supervisor.test.ts` (17 件成功)、`tsc --noEmit` (エラーなし)、`augur tests lint` (有効)、Anatomia `pr-review` (5 ゲート通過)。
- 未実施: 全体テスト、本番での trust 焼き込みの観測 (マージ後の反映で確認する)。

## 完了条件

- [x] ON + 管制チャンネル用意済みの巡回で 1 時間に 1 回だけ投稿し、失敗時は時刻を残さず次の巡回で再投稿、OFF で時刻を消す。
- [x] 本文は状態別・プロジェクト別の件数と停止セッション最大 10 行 (超過は「…ほか n 件」)、0 件の文言、メンションなし。
- [x] 管制の spawn は spawn 前に enrollment を記録し、失敗時に取り消す。
- [x] 返らない spawn でも巡回が止まらず、猶予後に次の世代を起動する。
