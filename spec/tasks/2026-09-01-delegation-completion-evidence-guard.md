---
title: "Delegation completed 報告の成果コミット検証"
status: implemented
---

# Delegation completed 報告の成果コミット検証

## 目的

委託先が実装成果を作らずに `completed` を自己申告しても、delegation run を完了として記録しない。

## 完了条件

- [x] worktree の Git 管理、記録済み feature branch、一件以上の main/develop 以降コミットを completed 前に検証する。
- [x] 証跡がない completed は failed と理由を記録し、409 `completed_without_evidence` を返す。
- [x] partial と failed の既存処理は変更しない。
- [x] API 回帰テストを追加する。
