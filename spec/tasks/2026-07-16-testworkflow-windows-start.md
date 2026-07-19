---
task: testworkflow-windows-start
project: Concordia
kind: 実装
status: delegated
created: 2026-07-16T00:00:00.000Z
delegation_run_id: 8eca4967-d226-4cab-9098-94edf8edd0cb
memoria_task_id: 523
actio_task_id: null
memory_links:
  - E:/Document/Ars/.wt-Concordia-rwf-confirm-incidents/spec/plan/problem_logs/2026-07-16-testworkflow-start-spawn-einval.md
---
# TestWorkflowのWindowsビルド起動と409詳細表示を修正する

## 目的

Testフォーラムの「テスト開始」がWindowsの `npm.cmd` 起動で `spawn EINVAL` にならないようにし、失敗時はHTTPステータスだけでなくCc APIの具体的な原因をDiscordへ返す。

## 完了条件

- Windowsでは構造化引数を保ったまま `ComSpec` 経由でnpmを実行し、非Windowsでは従来どおり直接argv実行する。
- `npm ci` と `npm run build` の双方に同じ単一責任のランチャーを使用する。
- Windows / 非Windowsのコマンド構築またはprocess runnerを自動テストする。
- confirm APIが返す `message` を非2xx時もDiscordの「テスト開始に失敗」へ表示する。
- ビルド失敗時にconfirm runが再試行可能で、Testフォーラム状態と台帳が矛盾しない。
- `npm run lint`、関連vitest、`npm run build`が成功する。
- 変更を1 PRとして作成する。

## スコープ

- `src/release/build.ts`
- 必要ならWindows用process launcherの小さな専用モジュール
- `src/discord/commands/_util.ts` とTestフォーラム開始処理
- 関連テストと仕様更新

## 制約

- worktreeからサービスを起動・再起動しない。
- shell文字列へ未信頼入力を連結しない。
- TestWorkflow以外のコマンドのエラー契約を不用意に変更しない。
