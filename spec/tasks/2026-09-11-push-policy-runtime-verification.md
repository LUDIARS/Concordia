---
task: push-policy-runtime-verification
project: Concordia
kind: 検証
created: 2026-09-11
memory_links:
  - spec/feature/shared-startup-context.md
  - spec/plan/problem_logs/2026-09-11-push-workflow-misclassification.md
---
# push判定修正の本体反映と実環境確認

## 目的
Rv未登録repoのpush誤拒否とGitHub App要求の報告を、実際の操作に沿って解消する。

## 完了条件
- 審査・マージ後、承認された本体反映手順で共通workflow判定とGitフック修正を反映する。
- 初期Injectと実フックが同じ登録状態を参照することを確認する。
- 報告対象repoと操作を特定し、GitHub Appエラーの発生元を確認する。通常のGit認証失敗とCcの誤案内を区別する。
- Rv未登録確定のGitHub repo、Rv登録済みrepo、照会失敗で期待する判定を確認し、既存フックとbranch保護を保持する。

## スコープ（編集可ディレクトリ）
Concordiaの`src/control/`、`src/api/`、`src/pr/`、`tools/`と対応仕様・テスト。

## 制約
起動・再起動はclaim後にExcubitor経由で本体フォルダのみ。実pushは対象repoのworkflowと許可範囲を確認する。審査待ちを理由にフックを迂回しない。
