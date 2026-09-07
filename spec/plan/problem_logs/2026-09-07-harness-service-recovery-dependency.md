# Cc停止がCc復旧の編集・コマンドを止める

- Date: 2026-09-07
- Area: harness / recovery

## Evidence

necoからCcダウン時にハーネスゲートが停止要因になるとの報告。
Castraの.claude/hooks/harness-gate.mjsは到達不能・タイムアウト・異常応答で全件ブロックする。
Ccへの接続をCc復旧作業の前提にしている。以前のタイムアウト延長だけでは不在時に復旧できない。

## Fix Requirements

通常時の中央判定を維持しつつ独立したローカル監督処理を用意する。プロジェクト別適用設定、
キャッシュの有効性、復旧作業の範囲を区別する。オンラインdenyをfail-openにしない。
テスト・サービス操作は未実施。既存Castra hookへの配置はCcのソース変更とは別の反映作業。
