---
task: parttimer-work-report-rollout
project: Concordia
kind: 雑用
created: 2026-09-09
memory_links: []
---
# パートタイマーの実作業・報告契約を稼働環境で確認する

## 目的

日報・メール報告は実作業とsystemへのサマリ報告、カイゼンはAstraによる改善実装と報告までを担当する契約を、稼働環境と次回の定時実行で確認する。
対象の価値と不変条件はUX-CC-W3/W4、CC-INV-03/04/05/06。
変更の根拠は `spec/feature/delegation-parttimer-inject.md`、`spec/feature/delegation.md`、
`spec/plan/problem_logs/2026-09-09-parttimer-work-report-completion.md`。

## 作業

1. 稼働版・配備済みinject・保存済みテンプレートを読み取りで照合する。kaizen-dailyの起動担当がcodex / gpt-6-astraであることを確認する。
2. 反映が必要なら対象と必要な操作を整理し、サービス操作の明示許可を得てから反映する。再起動はCcへ事前claimし、Excubitor経由・Concordia本体フォルダのみで行い、終了後releaseする。
3. 次回の通常スケジュール実行を確認する。日報の取得・更新根拠、メール取り込みと件数、カイゼンの実装成果・委託結果を確認する。検知・委託受付だけを実装済みと扱わない。
4. systemサマリの送信先とDiscord投稿の配送記録を照合する。0件と未実行、成果作成と配送完了を区別する。配送未確認は重複実行せず既存受付を照合する。
5. 確認できた事実と未確認事項を人間へ報告する。資格情報、個人データ、生ログ、session transcript、private endpoint、ローカル設定値、絶対パス、非公開成果物は転載せず、進行状態と証跡参照はCc DBに記録する。

## 完了条件

- 稼働環境で今回の実作業・報告契約を利用している根拠がある。
- 日報・メール・カイゼンそれぞれについて実作業結果とサマリ配送を照合できる。
- 0件、未実施、判断待ち、配送未確認を正常完了へ置き換えていない。
- 確認結果を報告し、状態はtaskflow_task_stateに保存する。本ファイルは書き戻さない。

## スコープ (編集可ディレクトリ)

- 対象はConcordiaの配備状況・パートタイマー実行結果の確認。コード改修は含めない。
- 稼働サービスの操作はExcubitor catalogに登録されたConcordia本体checkoutのみ。worktreeから起動しない。
- テスト・手動run起動・再起動・main更新を、このタスク保存によって許可されたと解釈しない。必要な操作は別途明示許可を得る。
- 既存の `spec/tasks/2026-09-08-verify-kaizen-astra-routing-rollout.md` と確認対象が重なる場合は、稼働版・保存済みテンプレート・実行結果の証跡を照合し、サービス操作と手動実行を重複させない。
