---
task: kd-hq-bot-destination
project: Cc
kind: fix
created: 2026-09-27
memory_links: []
---

necoの既存指示「DiscordサーバはGLab AIを動かすのは本社拠点」「チームはKD」「Discordの投稿先の設定だけ」に基づく配備修正。

GLabの専用bot_token_set=false、一方CcのGLabチャンネル一覧取得は既存本社Botで成功。#2071の明示宛先設定は専用資格情報だけを想定しており403になった。暗号化設定行でcredentialSource=headquartersを明示可能にし、指定guild・有効接続の検証を維持する。未指定時は従来どおり専用資格情報のみで本社fallbackなし。CC-ACTIO-CHAT-01/UX-CC-W1/W4/W5/CC-INV-02。

src/platform/actio-chat-destination.tsと同所test、src/bootstrap/core.tsの既存membership/specRefs/cc.acceptance対応を使用。回帰ケース追加、単体実行は未許可のため行わない。復旧はKDの設定行を除去してExcubitorで再起動。現在KD受付は切替のため停止中、投稿先未変更、ログ保持。Pagus/Mpは変更しない。
