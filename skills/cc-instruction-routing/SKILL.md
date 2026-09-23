---
name: cc-instruction-routing
description: Ccの方針更新・ブランチ通知・自動確認が重なった時、現在の作業と照合して必要な既存手順だけを選ぶ。
---

# 繰り返し届くCc指示を扱う

通知のworkflow/state、policy revision、対象repo/branchを最新の人間の指示と照合する。
同じrevisionの再配信では既読の同じ資料を読み直さず、変わった対象・状態・規則だけ確認する。
新しいrevisionを内容未確認のまま既読扱いにしない。開始承認は人間の実際の発言を参照する。

| 今回必要なこと | 読む正本 |
|---|---|
| 設計・開始承認・実装段階の照合 | ../session-work-phase/SKILL.md |
| 自動確認のstateへの応答 | ../session-followup/SKILL.md の該当state |
| 残作業・進捗の確認 | ../cc-work-management/SKILL.md |
| 復旧・引継ぎ・結果不明の照合 | ../cc-harness-recovery/SKILL.md |
| branch変更の登録 | E:/Document/Ars/.claude/skills/lictor-task-protocol/SKILL.md |
| 人間が許可したテスト・起動操作 | 利用可能な cc-test と excubitor-http-control |
| 人間が明示した終了操作 | E:/Document/Ars/.claude/commands/session-end.md |

通知に資料名があるだけで全部の手順を実行しない。現在必要な資料だけ読む。
開始承認済みの同一範囲は再質問しない。自動確認や必須tests設定を、テスト・再起動・
終了・push・mergeの許可として扱わない。結果不明の操作を再送する前に正本で照合する。
新規の作業段階・task DBを作らず、リンク先が定める所有者に記録する。

頻度の根拠は [9/21–22集計](../../spec/feature/cc-instruction-frequency.md)。
数値を見るためだけに原ログ全文を再読しない。

Windowsで許可済みの検証コマンドを起動する際は、子プロセスに windowsHide: true、
PowerShellのStart-Processなら -WindowStyle Hidden を明示する。非表示にできない実行経路を
無自覚に繰り返さない。検証用に対話端末ウィンドウを開かない（2026-09-23 neco指示）。
