---
task: 2026-10-01-cdgd-management-sidecar
project: Concordia
kind: 実装
created: 2026-10-01
memory_links: []
---
# CDGD マネジメント層 (dots サイドカー) の Cc 側

設計正本: `spec/feature/cdgd-management.md` (`CC-MGMT-01〜05`、`CC-MGMT-INV-01〜07`)。
2026-10-01 neco 指示「この設計をレビューして実装」「dots の管理は Cc がやります」。
元設計は Codex セッション lictor-76713395 の会話内設計 (session-logs/2026-10-01-2.md)。

## 目的

dots を CDGD 全体の横断判断者として Cc の横に置く。任務・資格情報・変更列・判断・依頼・処理済み位置を
Cc が持ち、dots は観測・判断・依頼・追跡だけを行う。実作業は Cc が起動したセッションが行う。

## 完了条件

- [ ] 任務の作成・更新・停止・再開・トークン回転を管理面 API で行える。トークンは hash のみ保存し、平文は発行時だけ返す。
- [ ] 変更の受付口 (event_key で冪等) と、任務の対象プロジェクトに絞った変更配信・出所ごとの最終受信がある。
- [ ] dots 向け 6 操作 (文脈・変更・判断・依頼・依頼照会・処理済み) が Bearer トークン必須で動く。MCP stdio サーバも同じ 6 操作だけを出す。
- [ ] 依頼は request_key で冪等、同じ対象の未完了依頼へ合流、上限・人間判断・AI 由来だけの根拠を判定する。
- [ ] 払い出しは spawn ID を保存してから起動し、session metadata で起動確認する。結果不明は照合、期限切れだけ失敗。
- [ ] 成果記録は担当セッション本人、受入・効果確認・承認・却下は人間の管理面だけ。
- [ ] 処理済み位置は判断か依頼の根拠に含めた変更までしか進まない (Cc 自身の記録は除く)。
- [ ] migration 120 `management-sidecar` と凍結台帳・スキーマ指紋の更新。
- [ ] テストを同じ変更で書き、`cc.acceptance.json` と `.augur/tests.jsonl` に登録する。

## 後続 (この PR に含めない)

- Cf → Cc の変更 push (Cf 側 adapter)。AI 返信は origin=ai で送る。
- Di・Pf・Terpsichore の変更 push。
- Web の任務管理画面と Discord の依頼状態通知・人間判断ボタン。
- dots の接続済み PC で MCP を動かす実接続の検証。
