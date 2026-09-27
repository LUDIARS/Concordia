---
task: kd-chat-destination
project: Cc
kind: fix
created: 2026-09-27
memory_links: []
---

neco:「DiscordサーバはGLab AIを動かすのは本社拠点」「チームはKD」「じゃあDiscordの投稿先の設定だけよろしく」。所属移管の保留は維持する。

CC-ACTIO-CHAT-01、UX-CC-W1/W4/W5、CC-INV-02/03/06。暗号化設定に明示したチーム・Discordサーバ・接続の組だけを使用する。ユーザ要求による任意資格情報選択や本社への暗黙fallbackは不可。AI実行とチーム所有権は変更しない。

受入ケースを追加。単体テストは未許可のため実行しない。型とAnatomiaの静的確認後にRevisorへ提出する。復旧は当該設定行の除去とExcubitor経由の再起動。既存KD受付は設定切替時まで維持する。
