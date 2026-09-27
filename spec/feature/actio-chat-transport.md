---
id: CC-ACTIO-CHAT-01
type: feature
service: concordia
domain: chat-platforms
title: Actioの通常チャンネル配送
---

価値: UX-CC-W1/W4/W5。シナリオ: UX-CC-S1/S3/S5。失うと困る状態は「人間の判断が必要なバックログ内容とスプリント進捗を、指定したチームの会話面から追えること」。necoのCc経由/独立Bot連携要求と2026-09-27「実装開始添付可」「OKそれで実装はじめて」に基づく。

状態所有者: Actioが受付・タスク・スプリント・送信箱・会話ログを所有する。Diが任意参加判断と発言案を所有する。Ccは認証済みActioからの配送要求を、Cc所有のDiscord/Slack資格情報で中継する。Ccに第二のスプリント状態機械を作らない。

Discord投稿先と所有組織は分離できる。管理者が暗号化runtime-configの `actioChatDestinations` に `{teamId, subsidiaryId, workspaceId}` の配列を設定する。明示環境変数 `CONCORDIA_ACTIO_CHAT_DESTINATIONS` は設定全体に優先する。登録されたチーム・guildの組み合わせだけが指定接続を使い、未登録チームは従来の所有組織から解決する。指定先が無効・別platform・別guild・deskなら拒否し、本社Botへフォールバックしない。HTTP要求は接続IDを選べない。AI推論は従来どおり本社Ccで行い、team.subsidiary_idやproject登録は変更しない。

この設定の純粋な検証は `src/platform/actio-chat-destination.ts` と同所の `.test.ts`（chat-platforms所属）が所有する。受入: 重複チーム・不正JSON/型・別guildを拒否、未指定は従来動作、入力本文/秘密をエラーに含めない。復旧は当該チームの設定行を除去しExcubitorでCc再起動。旧接続が有効な間は宛先を変更せず、Actioで停止・未処理配送の確認をして切り替える。

配備設定: `ACTIO_CHAT_SHARED_SECRET` の明示環境変数を優先し、未注入時はExcubitorの暗号化runtime-config内の `actioChatSharedSecret` を読む。空の明示環境変数は無効化を意味し、暗号化設定へフォールバックしない。不正なJSON/値型は固定文言で失敗し、秘密を出力しない。設定はCcの起動時に確定し、変更反映はExcubitor経由の再起動。既存 `actioTaskBindings` は保持する。設定解決とテストはchat-platformsの `src/platform/actio-chat-config.ts` / `src/platform/actio-chat-config.test.ts`。受入条件は優先順位・無効化・未設定・不正入力・値非露出。

不変条件: CC-INV-02（認証・対象組織・許可API）、CC-INV-03（結果不明時にCcでPOSTを再試行しない）、CC-INV-06（外部応答を配送済みの根拠にする）。APIはBearer共有秘密必須、未設定は503、宛先URLを受け取らず固定Discord/Slack APIのみ。本社/deskは本社Bot、子会社チームは当該子会社の有効な同種プラットフォームの暗号化資格情報を解決する。他組織の資格情報へフォールバックしない。

境界: HTTP入力 `src/api/actio-chat.ts`、許可APIポリシー `src/platform/actio-chat-policy.ts`、外部I/O `src/platform/actio-chat-proxy.ts`、既存bootstrapで資格情報を注入。src/testは同一chat-platforms境界。公開面はActioの接続設定と配送状態UIで、Ccに重複UIを作らない。

受入: 無認証・外部URL・許可外API・別guildは拒否。Discord/Slackの受信/投稿/通常チャンネル作成/保管要求を中継。タイムアウト・rate limitは失敗を返し、Actioのunknown照合へ戻す。Ccは本文や秘密をログに保存しない。内容確認は既存のconversationOnly LLM runnerで行い、実行権限を与えない。

復旧: 共有秘密未設定時は設定して再接続。外部結果不明はActioの操作IDマーカーと投稿履歴で照合。過去のフォーラムは削除・移動しない。テスト・再起動・実投稿は未許可のため未実行。

所属調査: 既存chat-platforms/http-interface/runtime-orchestration membershipとspecRefsを照合。AnatomiaのCLI moduleを直接呼び出し、where(project=concordia,file=src/api/register-core.ts)はhttp-interface等の既存所属を返した。新規src/platform/actio-chat-*と同所のtestは宣言済みchat-platforms所属。型確認は本体・テストソースとも実施、テスト本体は未実行。
