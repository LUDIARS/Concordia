---
id: CC-SPRINT-DIALOGUES
title: スプリントの人間判断と会話
type: feature
domain: sprint-dialogues
status: draft
---

# スプリントの人間判断と会話

価値: UX-CC-W1/W2/W4/W5、シナリオ UX-CC-S2/S3/S5。実装完了だけで人間の確認を失わず、計画・実装・受入・振り返り・次計画で同じ相談場所へ戻れる状態を守る。
2026-09-26 の人間「実装開始」が Tp/At/Cc の設計を承認した。実運用配達やUX評価が済んだという意味ではない。

## 所有者と用語

Actio がスプリント・フェーズ・タスク・権限・決定を所有する。Cc は dialogueKey=actio:teamId:sprintId の投影、配達意図、Discord本人による応答、反映結果、相談の履歴を所有する。Tp が純粋な遷移判断を所有する。Cc は Actio のDBへ書かない。

## 契約

- CC-SD-01: PUT /v1/sprint-dialogues/:key は version=1 の投影を保存する。同版同内容は同じ受付、古い版/同版異内容は409。スプリントごとに一つの会話を再利用する。
- CC-SD-02: 版付きボタンからmodalで理由と対象IDを明示する。Discordの同一guild/thread、bot自身のカード、実際の人間ユーザー、操作権限、現在版を検証する。bot/webhook/自由文は人間の承認を作らない。HTTPには判断イベント作成APIを設けない。ActioがCernere本人とteam leader権限を再検証し、解決できなければ可視の未反映結果を返す。
- CC-SD-03: GET /events は未処理の応答、POST /events/:id/ack は applied/rejected と理由を保存する。同じackは冪等、矛盾したackは409。Ccの受付やAIの返答は反映完了ではない。
- CC-SD-04: forum/thread作成意図を送信前に保存し、決定的markerで照合する。結果不明の再起動で同じ作成要求を再送しない。照合できなければunknownを保ち、管理者が既存面を確認する。カードは同じmessageを更新する。phase/held/closed変更は別の永続outboxから新着投稿を一度配達し、タスク内容だけの版更新では通知を増やさない。保存済み意図・bot本人の履歴照合（webhook除外）・nonceで重複を防ぐ。Discordの明確な4xx拒否（408除外）だけは無作用と確定し、意図を解除して60秒後から再試行する。
- CC-SD-05: 自由文は既存CcのrunClaude会話経路で副作用なし・tools無効の助言を返す。入力IDで重複排除し、受付/生成/保存/配達を分ける。応答生成中の停止は結果不明として示し、自動再実行しない。実装指示はActio/Ccの明示的な実行経路へ案内する。会話からテスト・サービス・push・merge・次計画開始の許可は追加しない。
- CC-SD-06: 所有するDiscord runtimeだけが配送timerと生成を管理し、停止で新規仕事を止める。外部I/Oは期限付き。障害は対象別に保存し、他スプリントの配送を止めない。相談は同時1件、未処理20件、本文4000字、出力16000字。

CC-INV-02/03/04/06/07/08、CC-NODE-02/03/04/06/07/08を適用。APIは接続元が実loopbackであることを検証し、ブラウザOriginとproxy転送ヘッダを拒否する。body-limitはストリーム込み5MiB。IDは200字、taskIdsは5000件、summaryは24000字、fingerprintは64桁hex。人間のDiscord provenanceはCcだけに保存し、Atには契約のイベントとして渡す。

closed=trueはActio正本で現スプリントが終了したことを表し、同じ会話の履歴は保持したまま判断ボタンと新規回答を無効にする。既に受理した回答の反映結果は届ける。

運用前提: Actio所有のexcubitor.catalog.yamlのACTIO_CF_PUBLIC_ORIGINにHTTPS originが必要。未設定や不正なら配達状態へ理由を残す。相談は現行Claude CLIの--tools= / --strict-mcp-config / --disable-slash-commands / --safe-modeを使用し、Windowsは直接停止可能なnative claude.exeを要求する。設定不足を成功へ置換しない。登録テスト用のmockはCLIやDiscordを実起動しない。

## 復旧と検証

forum/threadのunknownは同一markerをactive/archived両方で照合する。未知の既存面を別面へ置換しない。配達statusとlastErrorをActioが表示する。人間の古い操作・二重操作、同版競合、再起動時の作成意図、配達前後の失敗、bot/webhook、結果ack衝突をテストに記述する。今回ローカルテストと実Discord操作は未許可。型チェックとビルドを行い、登録テストはRevisorへ委ねる。
