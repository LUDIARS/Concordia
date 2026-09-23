---
title: Cc頻出指示の集計とスキル整理
type: feature
id: CC-INSTRUCTION-FREQUENCY
status: draft
---

# 2026/9/21–9/22のCc関連指示

JST 9/21 00:00以上、9/23 00:00未満。ローカルClaude projectsとCodex sessions/archived_sessions。
Claude候補7417ファイル中mtimeで絞った870ファイルを走査。userメッセージのuuidで重複除去しCc関連428件。
Codexはmtimeで絞った22ファイルを走査。event_msg.user_messageを時刻+本文で重複除去し207件。
合計635件。Cc関連は [Cc、[自動確認]、Concordia、ブランチ切替を検知のいずれかを含むもの。
人間のConcordiaへの言及も含み、Ccから送信されたイベント数の厳密な集計ではない。
日時は各メッセージtimestamp、mtimeは候補絞り込みだけ。欠損・削除・別端末は対象外。

下表は1メッセージ内で各語彙に一致した件数。カテゴリは重複し、合算不可。
終了手順のパスが初期注入に含まれる場合も数えるため、終了の実行回数ではない。

| 内容 | Claude | Codex | 合計 |
|---|---:|---:|---:|
| 残作業・終了手順 | 264 | 57 | 321 |
| テスト・再起動の許可とclaim | 197 | 70 | 267 |
| 作業段階記録 | 158 | 79 | 237 |
| 方針更新 | 190 | 43 | 233 |
| セッション方針 | 155 | 41 | 196 |
| 実装開始確認 | 138 | 57 | 195 |
| DDD・契約 | 107 | 40 | 147 |
| ブランチ変更・テスト通知 | 90 | 17 | 107 |
| 自動確認 | 80 | 22 | 102 |

分類語彙: session-end/残作業/残件、testing/claim/テスト許可/Excubitor再起動、
Cc policy update、work_phase/session-work-phase/作業段階、Cc Session policy、
開始前に人間に確認/設計が固まったら/開始確認、DDD/workContract/受入条件、
ブランチ切替を検知、自動確認。短いログ引用を恒久的な権限規則へ昇格しない。

## スキルへの対応

- 作業段階/開始確認: 既存session-work-phase。承認済みなら再確認しない契約を維持。
- 自動確認: 既存session-followup。stateだけ読む方式を維持。
- 残件: 既存cc-work-management、終了: session-end（終了指示がある時のみ）。
- branchと起動確認: 既存lictor-task-protocol / cc-test / excubitor-http-control。
- DDD/契約: プロジェクト固有AGENTSとspecを正本とし、別の固定方針を複製しない。
- これらの選択を skills/cc-instruction-routing/SKILL.md に集約。
- 今回の親子usage集計手法を skills/llm-session-cost-audit/SKILL.md に再利用可能な形で保存。

頻出の定型文自体はすでにスキル化が進んでいる。今回は不足する選択手順を追加し、
初期注入の全面変更や通知抑止は行わない。スキル正本を作成した段階であり、稼働中の全セッションへ配布済みとは扱わない。
