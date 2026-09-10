---
name: cc-harness-recovery
description: コンパクションの引継ぎ、MCP認証切れ、ハーネスの適用状態をCcの保存記録から確認する。結果不明の操作を再送しない復旧に使う。
---

# ハーネスの確認・引継ぎ

自分のLictor sidecarから現在のsession IDを取得し、Ccのcatalogでendpointを解決する。他sessionのIDを推測しない。

1. `GET /v1/harness/reliability/:sessionId/status` で観測時刻・対象tool・状態を読む。設定済みと実行済み、投稿受付と配送済みを区別する。
2. 圧縮後は `GET .../:sessionId/checkpoint` を読み、目標、repo/branch、未回答事項、契約、次の一手を現状態と照合する。保存がない場合は復旧済みとしない。
3. 区切りで `POST .../:sessionId/notes` に `decisions`、`next_action`、`unresolved`、`artifacts` の短い文字列を保存する。秘密を入れない。PreCompactがこの保存済み情報を使うため、圧縮直前に同じモデルへ長い要約を依頼しない。
4. MCPの401/明示的な失効なら対象接続の再認証を案内する。403、rate limit、通信失敗とは分ける。能動probeで障害を増やさず、再認証後の通常tool成功を観測する。

結果不明の `/clear` は再送しない。Ccが正常でもclient側hookが未対応・未信頼なら監視できない。観測のない項目は不明のまま報告する。
