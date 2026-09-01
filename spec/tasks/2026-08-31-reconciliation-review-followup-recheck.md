---
task: reconciliation-review-followup-recheck-20260831
project: Concordia
kind: 実装
status: pending
created: 2026-08-31T00:00:00.000Z
source_task: spec/tasks/2026-07-19-reconciliation-review-followup.md
memoria_task_id: 570
---
# 2026-08-31 突合レビュー対応 再調査 (Concordia)

## 目的
2026-07-19 付け突合レビュー指摘 (`spec/tasks/2026-07-19-reconciliation-review-followup.md`) は
6週間前のもので行番号がずれ、issue #369 も GitHub 上に見当たらない。現状コードを直接確認し、
実在すると確認できた指摘だけを解消する。

## 現状コードでの再調査結果
- **条件1 (旧 high/両者一致, Issue #369相当)**: 未解消と確認。
  `src/control/end-session-command.ts` の `endSessionNow` が `session.status === "active"` の
  場合のみ `session_end_pending_at` を立てていた。`status === "lost"` のセッションが
  `DELETE /v1/sessions/:id` を受けると、マーカーを立てずに `ended` へ遷移する。
  `expired-session-end-reaper` はマーカー必須、`lost-session-process-reaper` は
  `status === "lost"` 限定のため、どちらの回収経路にも掛からずプロセスツリーが残留する。
- **条件6 (旧 `src/discord/commands/end-session.ts:13`)**: 未解消と確認。
  `void callConcordia(...)` で DELETE 結果を待たず、常に "Session end requested." を表示していた。
- **条件2 (`network_access=false` ignore)**: 現状コードで既に対応済み
  (`provider-preset.ts` の `isNetworkAccessDisabled` 検出 + warn ログ)。再調査で解消確認。
- **条件3, 4, 5, 7, 8, 9, 10**: 行番号が現状とずれている / コードだけでは実行時競合の
  有無を判定できない / 元タスクの継続項目で影響範囲が広い、のいずれかのため今回は対象外。
  再調査が必要な場合は改めて別タスクとして起票する。

## 完了条件
- [x] `src/control/end-session-command.ts`: `lost` セッションの DELETE でも
      `session_end_pending_at` を立ててから `ended` へ遷移するよう修正
- [x] `src/discord/commands/end-session.ts`: Concordia 側 DELETE の結果を待ち、
      失敗時は失敗表示に切り替える
- [x] 回帰テスト追加 (`end-session-command.test.ts`: lost セッションのマーカー付与 /
      既存マーカーの非上書き、`end-session.test.ts`: DELETE 成功/失敗の表示分岐)
- [x] Discord の session ID を URL path component としてエンコードし、失敗応答の本文を
      ログへ複製せず、`ok: true` 以外を成功表示しない境界テストを追加。DELETE 待機は
      タイムアウト可能にし、応答不能時に Discord interaction が無期限停止しないようにする
- [x] 作成者確認時点のテストスイート (45 files / 366 tests) 通過、`tsc --noEmit` クリーン
- [x] Revisor autofix の malformed-response / timeout-signal 境界テストを登録
      (実行は Revisor 所有の CI で確認)

## スコープ (編集可ディレクトリ)
- `src/control/`, `src/discord/commands/`
