---
type: feature
id: SPEC-SESSION-END-BOUNDED-RECOVERY
title: Explicit session end has a bounded recovery path
status: draft
domain: session-coordination
---

# 終了要求と期限付き回収

2026-10-04 neco の「修正をSolに委託してPR」に対応する設計案。
Actio: `actio:e072a95c-47ca-4782-a6ba-da0564c370c4`。

## 価値と責務

UX-CC-W5 / UX-CC-S6、UX-CC-SC-W2。終了を依頼した利用者が、接続中のラッパを
無期限に残さず、保存済み結果から復旧できる状態を守る。
session-lifecycle は終了状態と metadata の所有者。session-coordination の終了 use case
は同一要求の期限と停止判断を管理し、既存 process adapter が所有世代を照合して停止する。
CC-INV-03/04/07 を適用する。報告の公開可否は表示ポリシーの責務であり、停止指示の許可とは別。

## 契約と不変条件

- 明示終了時の内部 session-end inject は `session_end_report=off` でも実行する。
  報告・独白と内部指示のチャット表示は既存の抑止を維持する。
- `session_end_pending_at` は終了要求の永続時刻。session ID、同時刻、記録済み
  process instance/generation/PID の組が要求同一性。重複終了で時刻を更新しない。
- 切断済みは既存の既定300秒の猶予。接続中は最低1800秒の保存猶予を与え、
  超過後は WS 接続・heartbeat を期限の延長理由にしない。1800秒は既存Lictorの
  graceful-exit最大待ち時間と整合する。明示設定がより長ければそれを尊重する。
- 完了callbackで既存停止処理を利用。callbackが無くてもpending要求をDBから再取得し、
  Cc再起動後に期限回収を継続する。現存する古いended/pending行も同じ条件で評価する。
- プロセス走査をawaitした後、各停止の直前にもstatus、要求時刻、所有世代/PIDを再照合。
  active復帰、pending更新/消去、所有権変更、不明な世代では停止しない。
- 同じ所有プロセスへの並行停止は一つのin-flight停止を共有する。再起動を越えた
  exactly-onceは主張しない。応答不明/失敗時はpendingを残し、次周期にOS生存を照合する。
  停止要求の受理だけで回収完了にはせず、生存PIDはpendingを残す。
- 停止後のmetadata更新前も同一要求を照合し、更新された別要求の印を消さない。

## 結果保全・復旧・限界

通常はAIのsession-end手順とLictor shutdownがログ保存・archiveを担う。期限回収は
その経路が完了しない場合の保険で、原transcript・Ccイベント・metadataを削除しない。
最大猶予を超えて動作中の未保存内容や終了archiveの生成は保証しない。
force-exitを通常経路へ追加しない（Codex app-serverでは即terminateとなるため）。
世代観測不可/停止失敗は回収結果failedと残ったpendingで運用へ露出し、後続周期で再照合する。
復旧は変更を戻せば従来の接続免除へ戻る。DB migrationは不要。

## 検証計画

終了injectの出力設定独立性、期限前後、接続/切断、並行停止、走査中の状態変更、
世代不一致、応答不明の生存照合、失敗後再試行、再起動相当の再構築をテストで記述する。
本依頼には実行許可がなくテスト・起動・停止は未実施。人間承認/実機評価は未実施。
