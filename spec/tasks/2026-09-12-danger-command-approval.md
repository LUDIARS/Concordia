---
task: danger-command-approval
project: Concordia
kind: 実装
created: 2026-09-12
memory_links: []
---
# 危険なpushのWARNING承認特例
## 目的
Revisor workflowで履歴修正等のpushが止まった場合、人間が対象と影響を確認した一回のみCcガードの例外を認可できるようにする。
## 完了条件
WARNINGにリポジトリ・branch・送信先・全refの新旧SHAを表示する。明示承認のみ許可し、拒否・期限切れ・非対話環境・binding変更は拒否する。AIが回答できるHTTP APIを承認経路にしない。既存Gitフックは維持する。
## スコープ (編集可ディレクトリ)
src/api/session-push-check*、src/control/push-warning*、tools/session-git-hook.mjs、tools/push-warning.ps1、spec/feature、spec/domains、spec/tasks。
