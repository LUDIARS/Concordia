---
type: feature
title: "アンビエント リスナー — 人間の会話を傍聴して自然参加する"
description: "opt-in した Discord/Slack チャンネルの人間同士の会話を傍聴し、決定的ゲートで絞った上で中央 Haiku 1 呼び出しにより参加判定と発話案を得て、persona 名義で会話に自然参加する。blackbox-chat-engine の第 2 系統 (中央 Haiku) に載る。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - slack
  - persona
  - llm
  - relay
  - rule-engine
status: planned
related:
  - feature/blackbox-chat-engine.md
  - feature/boyaki-channel.md
  - feature/participants.md
  - feature/cost-observability.md
updated: 2026-08-12
---

# アンビエント リスナー — 人間の会話を傍聴して自然参加する

> **移管 (2026-08-12 neco 決定)**: 実装先は **Histrio** に変更された
> (`Histrio/spec/tasks/2026-08-12-ambient-listener.md`。Concordia で予定していた
> ambient listener task は撤回)。buffer/gate/judge は Histrio が持ち、
> 参加判定は Histrio のロールモデルエンジン (`Histrio/spec/feature/role-model-engine.md`)
> を通る。Concordia 側は allowlist channel の人間発言をイベントフィードで配信し
> (Histrio 向けイベントフィード)、投稿・タスク注入の受け口を提供するのみ。
> 本 spec の要件・受け入れ基準は Histrio 実装に対して引き続き有効。

## 0. 位置づけと原則

既存 ingress は channel-id ルーティング型で、「聞く」対象は session channel / 窓口 /
Test Forum に限られる。本機能は**人間主体のチャンネル**を傍聴し、会話の空気を読んで
参加する層を追加する。

- **傍聴は channel 単位の明示 opt-in (allowlist) が絶対条件**。allowlist 外は
  バッファにも入れない。DM は対象外。
- 「雰囲気を察する」は意味判断なので LLM が要る。Cc 本体は決定的ゲートまでを担い、
  判断と描画は [blackbox-chat-engine.md](blackbox-chat-engine.md) の第 2 系統
  (Concordia 自身の声 = 中央 Haiku) に載せる。設定不備の無言フォールバック禁止も同 spec に従う。
- ぼやき channel とは住み分ける: ぼやき (AI の独り言) への反応は既存の確率返信のまま。
  ambient は人間主体チャンネル専用。

## 1. パイプライン

```
MessageCreate (allowlist channel のみ)
  → ambient/buffer.ts   channel 別リングバッファ (直近 30 発言・TTL 30 分)
  → ambient/gate.ts     決定的ゲート (LLM 不使用):
                          - channel 別 cooldown (既定 15 分)
                          - 最低活性: 直近 5 分に人間 3 発言以上
                          - quiet-hours 減衰 / isChatMuted / isCostBlocked で全停止
                          - 前回の ambient 投稿後、人間の対象発言が無ければ全停止
                          - bot 発言・ミラー転記・コマンド・subtype 付きは除外
  → ambient/judge.ts    中央 Haiku 1 回で参加判定と発話案を同時に返す
                          出力: { join, reason, draft, tone, route_to_session? }
                          join=false は投稿せずログのみ (描画専用の 2 回目呼び出しはしない)
  → ambient/poster.ts   persona の webhook identity で投稿。
                          返信深度は MAX_REPLY_DEPTH=2 を流用
```

- `route_to_session`: 会話が特定セッションの作業に言及していると judge が判断した場合、
  投稿せず既存 dispatcher のタスク注入 (chat-reply) に回し、そのセッションの LLM に喋らせる。
- chat-worker モードでも動くよう eventBus 購読で実装し、chat モジュールに同居させる
  ([module-manifest.md](module-manifest.md))。
- 連続参加の判定は buffer が持つ channel ごとの `lastAmbientPostAt` と、以後に受信した
  対象人間発言で行う。対象人間発言を受信した時点でのみ再参加可能に戻す。

## 2. データと操作面

- `ambient_channels(platform, channel_id, persona_id, cooldown_sec, enabled, created_at)`。
  `UNIQUE(platform, channel_id)`。
- Discord `/co-ambient on|off`、WebUI settings から allowlist を操作する。
- allowlist 追加時は、直近の会話が中央 Haiku の判定用入力として configured provider に送られる
  ことを管理者へ明示する。DM を含め、同意・権限を確認できない channel は追加しない。
- 発言者の識別は participants レジストリを流用する。
- ring buffer はプロセス内メモリだけに置き、再起動時に破棄する。judge の結果ログには
  channel 識別子・時刻・gate/join 結果だけを残し、会話本文・生成 draft・reason を
  DB、アプリケーションログへ保存しない。one-shot cost 記録が必要な場合も、required `prompt`
  には本文を含まない固定の redacted 値だけを送り、識別子・モデル・token/cost metadata のみを残す。

## 3. コストと安全

- gate 通過は理論上 channel あたり最大 4 回/時。Haiku 1 呼び出し/回。
  日次予算 kill switch (cost-observability) の配下に置く。
- mention sanitizer を通し、user mention / `@channel` / `@here` を生成しない。
- 深夜帯は既存 quiet-hours で 1/10。
- 参加発話は連続しない: 同一 channel で自分の直前発話に人間の応答が付くまで再参加しない。

## 4. 受け入れ基準

- [ ] allowlist 外の channel は読まない (バッファにも入らない)。DM は常に対象外。
- [ ] cooldown 内・活性不足・mute/コスト停止中は Haiku を呼ばない。
- [ ] join=false はログのみで無言。join=true は persona 名義で 1 発話のみ投稿する。
- [ ] route_to_session の場合は中央 Haiku の発話を投稿せず、該当セッションへのタスク注入に回る。
- [ ] 同一 channel で人間の応答が付くまで連続参加しない。
