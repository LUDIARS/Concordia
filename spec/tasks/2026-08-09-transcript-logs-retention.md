---
task: transcript-logs-retention
project: Concordia
kind: 設計相談
created: 2026-08-09
memory_links:
  - project-concordia-event-loop-stall
---

# concordia.db の肥大 — 保持期間を決めて刈る

## 目的

2026-08-09 時点の実測:

| 対象 | 規模 |
|---|---|
| `concordia.db` | **1,191 MB** |
| `transcript_logs` | **1,505,055 行** |
| `liveness_history` | 1,093,318 行 |
| `rules_log` | 452,788 行 |
| `service_instance_logs` | 130,359 行 |
| `session_stats` | 117,243 行 |

read-only で開いた別プロセスから `COUNT(*)` を全表に回したところ 10 分経っても
返らなかった (本番への負荷を避けるため中断)。

Cc は `node:sqlite` の同期 API を使うため、テーブル規模がそのまま
イベントループの停止時間に効く ([[2026-08-09-transcript-frame-event-loop-stall]])。
非同期化を入れても、母数が増え続ける限り再発する。刈り込み方針が要る。

現状、これらのテーブルに保持期間の定義が無い。

## 完了条件

- `transcript_logs` / `liveness_history` / `rules_log` / `service_instance_logs` /
  `session_stats` それぞれについて保持期間を**決めて spec に明記**する。
  過去 transcript をどこまで遡って参照したいかは運用判断なので、**neco の決定が必要**。
  セッション側で勝手に決めない。
- 決定した保持期間で削除する定期処理を実装する。削除自体も同期 I/O なので、
  イベントループを長時間止めない粒度 (分割削除) にすること。
- ディスク実サイズの回収には `VACUUM` が要るが、**長時間の排他ロック**を伴う。
  実施タイミングは運用と合意した上で、手順を spec に残す。
- 実施前後で DB サイズと stall 発生率を実測して記録する。

## スコープ (編集可ディレクトリ)

- `src/db/`
- `spec/data/`
- `spec/feature/`
