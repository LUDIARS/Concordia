---
type: feature
title: "外部エージェント向け HTTP ポーリング指令ブリッジ"
description: "inbound を受けられない外部エージェント (Muse) が Cc に積まれた指令をポーリングで受け取り、ack と結果を返す。公開は Cloudflare Tunnel + Access のサービストークン単一ヘッダー (Authorization) + 同じ値の鍵 1 本 (x-excubitor-token も可)、登録は loopback のみ。"
service: concordia
domain: agent-instructions
status: implemented
updated: 2026-11-22
tags:
  - muse
  - external-agent
  - cloudflare-tunnel
---

# 外部エージェント向け HTTP ポーリング指令ブリッジ

> 所属ドメイン: [`agent-instructions`](../domains/agent-instructions.domain.json)

2026-11-21 neco 指示「Muse のリンクの実装指示書」(Concordia ⇔ Muse HTTP ポーリング・ブリッジ、Cc 側)。
関連 Actio (Gen5): `bda6872e-de10-4ea6-98dc-a1ac4be92d4d`「Muse へのリレーが動いていない」。

Muse (Meta のパーソナルエージェント) は信頼できないマシン扱いの VM で動き、待ち受けポートも WebSocket の常駐接続も持てない。
そのため push ではなく Muse が外向きに約 5 分間隔でポーリングする。形は [AI プレイテスト感想の投稿](playtest-review-notify.md) (cc-playtest) に揃える:
固定スキーマ、camelCase、新規 202 / 再送 200 `duplicate: true`、ヘッダー `x-excubitor-token` (または `Authorization`) の鍵 1 本。

2026-11-21 neco 決定: 公開経由の認証は CF Access のサービストークン (`CF-Access-Client-Id` / `-Secret` の 2 ヘッダー) をやめ、専用の鍵 1 本にする。
Muse のカスタムコネクタは 1 要求に秘密 1 つまでしか送れないと実測で確定したため (cc-playtest と同じ方式)。

2026-11-22 neco 指示「Authorization で進める」: 公開口は `cc-playtest.ai-run-do.com` に置き、Access は必須のまま、サービストークンを単一ヘッダー
(`read_service_tokens_from_header=Authorization`。Cloudflare はヘッダー名に Authorization しか許さない) で通す。Muse は
`Authorization: {"cf-access-client-id":"…","cf-access-client-secret":"…"}` を 1 つだけ送り、Cc は同じ JSON 文字列を鍵として確かめる。

## 業務用語と状態の所有者

- **指令 (instruction)**: 宛先エージェント 1 つに渡すタスク。所有者は Cc の `agent_instructions` (migration 150)。
- **宛先 (agent)**: 許可リスト `muse` のみ。
- **type**: 許可リスト `notify_only` (通知だけ) / `run_task` (タスク依頼) / `status_query` (状態の問い合わせ) / `playtest` ([マージ後の再試遊](merge-playtest-return.md))。増やすときは指示書の改訂として扱う。
- **状態**: `pending` → `acked` → `done` / `failed`。`done` / `failed` は終端。

```
pending --ack--> acked --result--> done / failed
pending --result--> done / failed      (ack 漏れ救済。acked_at も同時に記録)
acked が 30 分 result なし → pending   (sweeper と、ポーリングの直前に戻す)
```

Muse 自身の権限・承認ルールは指令で拡張されない (金銭・送信・削除は Muse 側でユーザ承認)。Cc 側で回避策を作らない。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-INST-INV-01 | 全 POST は固定スキーマ。未知の項目・型違い・文字数 / バイト数超過は 400。エラーは `{error:{code,message}}` で message に直し方を書く | `src/agent-instructions/instruction-requests.ts` |
| CC-INST-INV-02 | 宛先と type は許可リストのみ (`muse` / `notify_only`・`run_task`・`status_query`・`playtest`)。外れたら登録時に 400 | `src/agent-instructions/instruction-policy.ts` |
| CC-INST-INV-03 | ack は `pending` を `acked` にして 202、`acked` への再送は 200 `duplicate: true`、終端は 409、無い ID は 404 | `instruction-policy.ts` `decideAck` |
| CC-INST-INV-04 | result は `pending` / `acked` を終端にして 202 `{delivered:true, failed:false}`。同一結果 (status・要約・詳細。詳細はキー順を無視) の再送は 200 `duplicate: true`、違う結果は 409 | `instruction-policy.ts` `decideResult` |
| CC-INST-INV-05 | `acked` のまま 30 分 result が無い指令は `pending` に戻り再配信される。終端は再配信しない。終端は 90 日で削除 | `instruction-service.ts` / `src/sweeper.ts` |
| CC-INST-INV-06 | 公開経由 (公開ホスト宛て、または Cloudflare Tunnel 由来ヘッダー付き) の poll / ack / result は、鍵の候補 (ヘッダー `x-excubitor-token`、無ければ `Authorization`。`x-excubitor-token` があればそれだけで判定し、値は前後の空白以外加工しない) が専用の鍵 (設定 `agent_instructions.intake_token`) と定数時間比較で一致したものだけ通す。欠落・不一致は本文を読む前に 401 (warn ログに理由だけ、値は出さない)。鍵が未設定・復号できないときは公開経由を全部 401 | `src/agent-instructions/instruction-token.ts` / `public-access.ts` |
| CC-INST-INV-07 | 登録 (`POST /v1/instructions`) と状態確認 (`GET /v1/instructions/:id`) は loopback のみ。公開経由は鍵の有無に関係なく 403 (Muse に指令の自己登録をさせない) | `src/api/agent-instructions.ts` |

## 口 (`src/api/agent-instructions.ts`)

公開ホストの SSO と応答キャッシュより前に登録する (`src/app.ts`)。応答は全部 `cache-control: no-store`。本文の上限 64 KiB (超えたら 413)。

| 口 | 呼ぶ側 | 公開経由 | 成功 |
|---|---|---|---|
| `POST /v1/instructions` | 自宅側 (Web monitor・自宅エージェント・curl) | 403 | 201 `{data:{instruction:{id,status:"pending",createdAt}}}` |
| `GET /v1/instructions?agent=muse&status=pending&limit=10` | Muse | 鍵が一致したときのみ | 200 `{data:{instructions:[{id,type,title,body,params,createdAt}]}}` (古い順、0 件は空配列) |
| `POST /v1/instructions/:id/ack` | Muse | 鍵が一致したときのみ | 202 / 再送 200 `{duplicate, data:{instruction:{id,status,ackedAt}}}` |
| `POST /v1/instructions/:id/result` | Muse | 鍵が一致したときのみ | 202 / 再送 200 `{delivered:true, failed:false, duplicate, data:{instruction:{id,status,finishedAt}}}` |
| `GET /v1/instructions/:id` | 自宅側 | 403 | 200 `{data:{instruction:{id,agent,type,title,status,createdAt,ackedAt,finishedAt,resultSummary}}}` |

本文 (strict):

| 口 | 項目 |
|---|---|
| 登録 | `agent` (`muse`)、`type` (許可リスト)、`title` 1〜200 文字、`body` 1〜4000 文字、`params` 省略可 (JSON オブジェクト、8000 バイト以内、省略時 `{}`) |
| ack | `agent` のみ |
| result | `agent`、`status` (`done` / `failed`)、`summary` 1〜400 文字 (保存は 2000 文字で切り詰め)、`detail` 省略可 (JSON オブジェクト、16000 バイト以内) |

query: `agent` 必須、`status` は 4 状態のどれか (省略時 `pending`)、`limit` は 1〜20 の整数 (省略時 10)。範囲外は 400。

指令 ID: `inst:<agent>:<YYYYMMDDTHHMMSSZ>:<6 桁 hex>`。形が違う ID は 404。時刻は秒精度の ISO 8601 UTC。

## 公開 (Cloudflare Tunnel + 専用の鍵)

Cc は `127.0.0.1` bind のまま。Tunnel の ingress を `https://<公開ホスト>/v1/instructions*` → `http://127.0.0.1:<Cc のポート>` に絞り、
`/v1/sessions` 等は公開しない (ルーティング対象外は Tunnel 側で 404)。公開ホストは `cc-playtest.ai-run-do.com` (`^/v1/instructions(/|$)` を
LOCAL トンネル → Excubitor 入口 → Cc へ)。Cloudflare Access は必須のまま、サービストークンを単一ヘッダー (`Authorization`) で通す
(Muse はサービストークンの 2 ヘッダーを送れない)。Cc は同じ `Authorization` の値を鍵として確かめる (Access とアプリ側の鍵の二重確認)。

アプリ側の判定:

- 公開経由か: Host が `CONCORDIA_INSTRUCTIONS_PUBLIC_HOST` に一致するか、`cf-ray` / `cf-connecting-ip` / `cf-access-jwt-assertion`
  のどれかがあれば公開経由 (web-sso の `isPublicRequest` と同じ判定)。公開ホストが未設定・形式不正でもトンネル由来ヘッダーで捕まえる。
- 鍵 (CC-INST-INV-06): `x-excubitor-token` (無ければ `Authorization`) を設定 `agent_instructions.intake_token` と比べる。`Bearer ` などの接頭辞は剥がさない。両辺を SHA-256 にしてから
  `timingSafeEqual` で比べるので、長さの違いも比較時間から漏れない。CF Access の JWT は求めない (あっても鍵の代わりにならない)。
- 鍵は要求ごとに設定から読む。設定画面で差し替えると再起動なしで古い鍵が無効になる。
- Tunnel を迂回して loopback に直接来た要求は local だが、Cc は loopback bind なのでそれはこの PC 上のプロセスに限られる。

| 設定 | 置き場所 | 内容 |
|---|---|---|
| `runtime.instructions_public_host` | env `CONCORDIA_INSTRUCTIONS_PUBLIC_HOST` | 公開ホスト名 (ホスト名だけ)。起動時に読む |
| `agent_instructions.intake_token` | 設定 > 実行環境 (schema_meta、secret-box で暗号化、API は値を返さない) | 公開経由の鍵。CF Access のサービストークンの JSON 1 行 (`{"cf-access-client-id":"…","cf-access-client-secret":"…"}`、空白なし。`^\S{32,}$` を満たす)。AI プレイテスト受け口の鍵 (`playtest_notify.intake_token`) とは別 |

### 人間がやる手順 (Cloudflare・鍵)

1. Access のサービストークンを発行し、値を JSON 1 行 `{"cf-access-client-id":"…","cf-access-client-secret":"…"}` (空白なし) にする。
   同じ文字列を Cc の設定 > 実行環境「指令ブリッジの公開経由の鍵」に保存し、Muse のコネクタに `Authorization` として渡す。値はチャット・ログ・リポジトリに書かない。
2. 公開ルート: `cc-playtest.ai-run-do.com` の `^/v1/instructions(/|$)` → LOCAL トンネル → Excubitor 入口 → Cc。ほかのパスは公開しない。
3. Access: このアプリは Bypass にせず、そのサービストークンを許可するポリシーと `read_service_tokens_from_header=Authorization` を設定する。
4. Cc の env に `CONCORDIA_INSTRUCTIONS_PUBLIC_HOST=cc-playtest.ai-run-do.com` を入れ、Excubitor 経由で反映・再起動する。
5. 外から確かめる: 鍵なし 401 (Access で止まれば 403)、鍵ありの poll 200、`POST /v1/instructions` は 403。
6. ローテーション: サービストークンを入れ替えたら、Cc の鍵・Muse のコネクタ・Ingenium の設定を同時に直す (どれか 1 つでも古いと 401)。

## 復旧

- 結果が分からない ack / result は同じ内容で再送してよい (冪等)。登録は冪等キーを持たないので、`GET` で積まれていないか確かめてから送り直す。
- Muse が ack 後に止まっても 30 分で `pending` に戻り、次のポーリングで再配信される。

## 検証

- `src/api/agent-instructions.test.ts`: 指示書 §6-2〜7 を Hono の要求で再現 (実 DB。公開経由はトンネル由来ヘッダーと鍵の有無で再現)。
- `src/agent-instructions/*.test.ts`: 判定・要求の形・use case・鍵の判定・入口判定・結線。`tests/sweeper.test.ts`: sweeper からの掃除。
- 未実施: 公開ホスト経由の実機確認 (§6-6〜8)。公開ルート・Access のサービストークン設定・鍵の生成と稼働中 Cc への反映は人間の許可が要る (上の手順)。
