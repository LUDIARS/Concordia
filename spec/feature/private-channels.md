# プライベートチャンネル — 指定した人だけが見られる Discord チャンネル

> 2026-09-30 neco 指示「プライベートチャンネルの生成ロジック作って」(Actio `e83728cc`、#2187) と、
> 同日のプライベート相談 ([技術相談](tech-consultation.md) §4) を、2026-10-01 neco 判断「プライベート相談に統合」で
> 1 本の実装にまとめた。設計は director case `dir_2a273424` plan v1 (承認済み)。

- 価値: [UX-CC-W4](../ux/product.md) (通知を見れば今必要な判断が分かる) と「守る制約と優先順位」5 (情報範囲を守る)。
  相談としての価値は UX-CC-W6。
- 利用者に起きる変化: AI セッション・人間 (API) が指定した人だけが見られる Discord チャンネルを作り、秘匿性のある報告や
  個人宛ての成果物を公開チャンネルに流さずに済む。

## 1. 置き場所と作り方 (共通)

**Requirement ID: `SPEC-PRIVCH-CHANNEL`**

- 本社 guild の「プライベート」カテゴリ (無ければ作る。`discord_config.private_category_id`) に置く。プライベート相談の
  チャンネルも同じカテゴリに置く。旧名「プライベート相談」のカテゴリ (`private_consult_category_id`) が保存済みなら
  それを引き継ぎ、名前を「プライベート」に揃える。
- 閉じたチャンネルは **作成要求の時点で** overwrite を含める (作ってから閉じる隙間を作らない)。`@everyone` は不可視、
  閲覧者と Bot だけ可視。カテゴリの権限同期には頼らない。
- 作成・閲覧者の付け外し・書き込み停止は `src/discord/private-channel-discord.ts` だけが持ち、相談 (`consult-*`) も
  報告用 (`private-channel-provisioner.ts`) もそれを使う。

不変条件:

| ID | 条件 |
|---|---|
| CC-PRIVCH-INV-01 | 閉じたチャンネルは作成時に閉じている。閲覧者と Bot 以外は見られない |
| CC-PRIVCH-INV-02 | 同じ冪等キーの報告用チャンネルは 1 つしか作らない。チャンネル id を記録済みのレコードは作り直さない |
| CC-PRIVCH-INV-03 | `POST /v1/chat` で明示された `discord_channel_id` は、セッションの面か ready の報告用チャンネルのときだけ採用する |

## 2. 報告用チャンネルの作成 API

**Requirement ID: `SPEC-PRIVCH-API`**

`POST /v1/discord/private-channels` (loopback の管理 API):

```json
{ "name": "report-for-neco", "viewer_user_ids": ["123456789012345678"], "text": "最初の投稿", "key": "idempotency-key", "session_id": "..." }
```

- `name` (必須): Discord のチャンネル名規則へ正規化する (小文字化、空白 → `-`、英数字・`-`・`_`・非 ASCII 以外を除去、
  連続 `-` の圧縮、前後の `-` 除去、100 文字まで)。空になれば 400 `invalid_name`。
- `viewer_user_ids` (任意): Discord ユーザー id (`/^\d{17,20}$/`) の配列。不正なら 400 `invalid_viewer_user_ids`。重複は除く。
  省略時は管理者 (設定の mention user) 1 名。閲覧者 0 名なら 400 `no_viewers`。
- `text` (任意、2,000 文字まで): 作成直後の最初の投稿。
- `key` (任意): 冪等キー。同じ key の記録があればそれを返す (200)。
- `session_id` (任意): 依頼元 (記録のみ)。
- 新規は `pending` で記録し、`discord.private_channel.requested` で Bot に作らせて 202 `{ id, status }` を返す。

`GET /v1/discord/private-channels/:id` → `{ id, status: pending|ready|failed, channel_id, url, error }`
(`url` は ready のときだけ `https://discord.com/channels/<guild>/<channel>`)。

## 3. Bot の作成

**Requirement ID: `SPEC-PRIVCH-PROVISION`**

- 本社 runtime だけが扱う。イベント受信時と起動時に `pending` を処理する。処理は 1 本の列で直列に行う。
- チャンネル id を記録済み (前回の途中で止まった) なら作り直さず、閲覧者の overwrite を置き直して続きをする。
- 初回投稿を送ってから `ready` にする。作成・投稿に失敗したら `failed` と理由を残す (自動では再試行しない)。

## 4. 以後の投稿

**Requirement ID: `SPEC-PRIVCH-EGRESS`**

新しい投稿 API は作らない。`POST /v1/chat` に `discord_channel_id` を付けて送る (`channel` は `system` 等)。egress は、
それが ready の報告用チャンネルなら、セッションの有無・状態に関係なくそのチャンネルの webhook へ送る。
それ以外の明示 id の扱い (セッションの面と一致する時だけ採用) は変えない。

## 5. 保存 (`private_channels`, migration 119)

| 列 | 意味 |
|---|---|
| id | `prc_` + UUID |
| request_key | 冪等キー (UNIQUE、NULL 可) |
| name | 正規化済みのチャンネル名 |
| viewer_user_ids | JSON 配列 |
| initial_text / initial_message_id | 初回投稿と送信済みの message id |
| guild_id / channel_id | 作成後に記録 |
| status / error | `pending` / `ready` / `failed` と失敗理由 |
| created_by_session_id | 依頼元セッション |
| created_at / updated_at | epoch-ms |

相談は `private_consultations` のまま (承認・招待・終了時の書き込み停止という別の状態を持つ)。チャンネルの作り方だけを共有する。

## 5.1 書き込み停止と速度制限の記録

2026-10-06、相談者以外の閲覧者がいるプライベート相談チャンネルで、書き込み停止 (閲覧者ごとの権限の書き換え) が 30 秒以上
返らなかった。discord.js は Discord の速度制限 (429) で黙って待つので、呼び出し側からは原因が見えなかった。

- 書き込み停止 (`lockPrivateChannel`) は閲覧者 1 人ずつ上限 10 秒 (`LOCK_MEMBER_TIMEOUT_MS`) で行い、成功・失敗と所要時間を
  記録する。1 人が止まっても残りは続け、最後に失敗した人数を例外で返す。
- 物理 Client ごとに REST の速度制限イベントを購読し、経路・待ち時間・全体制限かを warn で記録する
  (`src/discord/rest-rate-limit-log.ts`、`gateway-pool.ts` から 1 回だけつなぐ)。

## 6. 対象外

報告用チャンネルの削除・閲覧者の変更 API、`failed` の再試行 API、子会社 guild への作成。
