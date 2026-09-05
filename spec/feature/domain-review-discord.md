---
type: feature
title: "Discord でのドメインレビュー — ドメイン情報の投稿と返信の取り込み"
description: "project_codes.domain_review が ON のプロジェクトについて、Anatomia のコアドメイン (business-domain-view) とプログラムドメイン層 (program-domain-view) を Discord へ embed で投稿し、返信をレビュー回答として取り込む。plan 起点の投稿には plan の questions[] を載せ、返信は .anatomia/plan/<hash>.json の突合資料へ追記する。"
service: concordia
domain: domain-review
tags:
  - discord
  - anatomia
  - ddd
  - project-codes
status: planned
related:
  - feature/project-code-registry.md
  - feature/discord-ui.md
  - feature/revisor-local-pr-submission.md
  - feature/inquiry.md
updated: 2026-09-05
---

# Discord でのドメインレビュー

> 正本の設計書は上位計画 `2026-09-05-anatomia-domain-plan-tool.md` §7-§8。
> 本書はその Concordia 側 C-3〜C-6 の実装契約。 C-7 以降 (RWF のスキル割り当て、
> スキル一覧 API、組み込み inject のスキル化) は本書の範囲外。

## 0. 目的

人間の主な役割は**ドメインレビュー**である (設計書 §7)。 そのために Anatomia の
画面を開かせるのではなく、 **Cc がドメイン情報を Discord へ持ってくる**。

## 1. 適用範囲 (C-3)

- `project_codes.domain_review INTEGER NOT NULL DEFAULT 0` が適用可否の正本。
- **列を追加した回だけ** seed する (migration 91)。 migration は、後日の新規登録既定値の
  変更で過去の backfill が変わらないよう、その時点の判定を `src/db/schema.ts` 内に凍結する。
  新規登録の既定値は `src/db/domain-review-seed.ts` が同じ方針を担う:
  - repo_origin の owner が `LUDIARS` / `MELPOT` → 1
  - ただし メタ / インフラ枠 (`Ars` / `Castra` / `LUDIARS` / `infra` / `AIFormat` /
    `All-In-OneTest`) は 0
  - repo_origin が無い登録、 外部 org → 0
- 既に人が切り替えた値を後から上書きしない。 seed は 1 度きり。
- 新規登録 (`POST /v1/project-codes`) も同じ規則で初期値を入れる。
- 変更は `PATCH /v1/project-codes/:code { "domain_review": true|false }`。
  WebUI のプロジェクトコード画面 (`web/src/pages/ProjectCodes.tsx`) にトグル、
  Discord `/projects` の一覧に 📑 を出す。

## 2. 投稿 (C-4)

### 2.1 契機

| 契機 | 入口 |
|---|---|
| `anatomia plan` が作られた | `POST /v1/domain-review { "trigger": "plan", "code": …, "session_id": …, "plan_task_hash": … }` (Castra の supply hook から) |
| Revisor local PR を提出した | `submitLocalPrForSession` が提出成功時に内部呼び出し |
| 明示要求 | Discord `/domain-review <code>` → `POST /v1/domain-review { "trigger": "manual" }` |

### 2.2 投稿先

Cc の Discord レイアウトに**プロジェクト専用チャンネルは無い**。 プロジェクトの面は
「そのプロジェクトを触っているセッションのスレッド」なので、 次の順で決める:

1. 明示指定のチャンネル (`/domain-review` を打った場所)
2. 契機となったセッションのスレッド (status が active のときだけ)
3. houkoku (報告) チャンネル

### 2.3 内容

- コアドメインのリスト (名前 / 説明 1 行 / UX 直結 / 未実装・逸脱)、親子、関係辺
- 層ごとのプログラムドメイン、層違反依存、コアドメイン未所属、層未分類
- plan 起点のときは plan の `questions[]` と `unresolved[]`

### 2.4 投稿しない場合

**エラー投稿でチャンネルを埋めない。** 理由はログにだけ残す。

| 理由 | 扱い |
|---|---|
| `project_not_registered` / `domain_review_disabled` | 投稿しない |
| `anatomia_unreachable` | 投稿しない |
| `not_prepared` | 自動契機は投稿しない。 **明示要求のときだけ** `GET /api/projects/:id/domains` の生データで代替し、prepare を促す但し書きを付ける |
| `no_domain_data` | 投稿しない |
| `post_failed` | 投稿しない (投稿口が未登録の場合を含む) |

API は上記いずれでも `200 { "posted": false, "reason": … }` を返す。
「発火はしたが投稿対象ではなかった」を呼び出し側がエラーとして扱わないため。

### 2.5 Discord の上限とメンション

- embed の上限 (title 256 / description 4096 / field value 1024 / field 25 / 合計 6000 /
  embed 10) は `src/discord/embed-limits.ts` の `fitEmbeds` が必ず満たす。
  切り詰めたら **件数か文字数で省略を明示**する。
- ドメイン名・説明・plan の問いは Anatomia と LLM 由来の**信頼できない入力**として扱う。
  `@everyone` / `@here` / `<@id>` は zero-width space で無害化し、 送信側でも
  `allowedMentions: { parse: [] }` を付ける (二重防御)。

## 3. 画像 (C-5)

- 層図を Cc 側で自己完結 HTML (`layer-diagram.ts`) として描き、 headless Edge の
  `--headless=new --screenshot` で PNG 化して添付する。
- **任意。** Edge が無い / 起動しない / タイムアウトのときはリストだけ投稿して続行する。
- 出力は OS の temp 配下 = `buildAttachmentRoots` の許可ルート内。 添付の読み込みは
  egress と同じ `src/discord/attachment-files.ts` を通す (許可ルート検査の口を増やさない)。
- Anatomia の web UI ではなく Cc が描くのは、 未 prepare でも絵が出せること、
  同じ投稿のリストと図が必ず一致することによる。

## 4. 返信の取り込み (C-6)

- 投稿の `message_id` を `domain_review_posts` に残し、 その message への返信を
  `POST /v1/domain-review/replies` で回答として取り込む。 取り込んだ返信は
  セッションへ inject しない (レビュー回答であって作業指示ではない)。
- plan / 台帳を書き換える回答は社員名簿の `session_spawn` capability (管理職以上) を
  必須とし、未配線・権限不足は fail-closed で拒否する。
- 回答は `domain_review_answers` に必ず残す。 plan 起点の投稿への返信は
  `.anatomia/plan/<hash>.json` の `reviewAnswers[]` にも追記する
  (plan 本体のフィールドは書き換えない)。
- Discord reply の安定した source ID で再配送を冪等に扱う。同じ投稿への回答は直列化し、
  plan は一時ファイルから原子的に置き換えて、同時返信による lost update や途中書込みを防ぐ。
- `.anatomia` / `plan` / 対象 JSON が symlink / junction の場合は読み書きしない。
  リポジトリ外のファイルを plan として読み出したり上書きしたりしないため。
- **ドメイン説明の修正・紐付け指示は Anatomia へ配線しない。** Anatomia の authoring は
  Gate A (`POST /api/projects/:id/domain-organization/gate-a`) だけが入口で、
  `DomainProposal[]` 一式 + `expectedHead` + snapshot id を要求する承認ゲートである。
  自由文の指摘を受ける口が無く、 Cc は LLM を内包しないので機械的に翻訳もできない。
  受け口ができるまでは Cc の台帳に残すところまでとし、 偽の配線を作らない。

### 4.1 plan ファイルへの追記 {#SPEC-DOMAIN-REVIEW-PLAN-FILE}

突合資料 `.anatomia/plan/<hash>.json` の読み書きは `src/domain-review/plan-file.ts` に閉じる。
plan の所有者は Anatomia で、 Cc が触るのは次の 2 つだけ:
投稿に載せる `questions[]` / `unresolved[]` を**読む**ことと、 返信を `reviewAnswers[]` へ
**追記する**こと。 plan 本体のフィールドは書き換えない。

| 契約 | 内容 |
|---|---|
| ファイル名 | task hash は 16 桁 hex のみ。 Discord 由来の文字列がそのままパスの一部になる経路なので、 緩めると任意ファイルの読み書きになる |
| 対象の限定 | `<repo>` / `<repo>/.anatomia` / `<repo>/.anatomia/plan` と対象 JSON のいずれかが symlink / junction、 またはディレクトリ / 通常ファイルでなければ読み書きしない |
| plan の特定 | `plan_task_hash` 指定があればそれ、 無ければその checkout の最終更新 plan (Anatomia の `verify --plan` と同じ規則) |
| 追記の原子性 | 同一 plan への read-modify-write は直列化し、 一時ファイルへ書いてから rename で置き換える (同時返信の lost update と途中書き込みを防ぐ) |
| 冪等性 | 同じ `source` の回答が既にあれば何もせず成功として扱う |
| 失敗の扱い | plan が無い / 壊れている / 書けないときは投げずに失敗を返すだけ。 回答自体は `domain_review_answers` に残っており、 「突合資料に残せなかった」以上の意味を持たせない |
| 読み込み上限 | plan は突合資料であって成果物ではないので、 5 MiB を超えるファイルは読まない |

Anatomia の応答も plan も**信頼できない外部入力**として扱い、 形が合わないものは
黙って落とす。 読み出し経路の途中で投げると 「ドメイン情報が出ない」 ではなく
「返信の取り込みが失敗する」 になってしまうため。

## 5. 既知の制約

- 投稿口 (guild ハンドル) は Discord Bot が ready 後に backend へ登録する。
  **chat を worker プロセスで動かす構成 (`CONCORDIA_CHAT_MODE=worker`) では
  backend 側に投稿口が無く、 `post_failed` で見送られる。**
- plan の特定は `plan_task_hash` 未指定なら「その checkout の直近 plan」。
  Anatomia の `verify --plan` と同じ規則。
- HTTP 発火口は任意の `repo_path` を受け付けない。`session_id` が Cc 台帳にあり、その
  `repo_origin` が選択した project-code 登録と一致するときだけ、その session checkout を
  plan I/O に使う。local PR の内部発火も同じ登録を `repo_origin` で確定してから checkout
  path を渡す。Anatomia project の解決は常に registry の本体 path を優先する。

## 6. 受け入れ条件

1. `domain_review = 0` のプロジェクトでは、 3 契機のいずれでも投稿されない。
2. Anatomia が停止していても local PR 提出は成功し、 投稿だけが見送られる。
3. ドメインが 200 件あっても、 embed は Discord の上限を 1 つも超えない
   (超える入力で `fitEmbeds` の出力が上限内に収まることをテストで固定)。
4. ドメイン説明に `@everyone` が含まれていても、 投稿本文で発火しない。
5. plan 起点の投稿へ返信すると `.anatomia/plan/<hash>.json` に `reviewAnswers[]` が増える。
6. `/domain-review <code>` は未 prepare でも簡易表示で投稿し、 prepare を促す。

## 7. 実装の配置

取得 → 変換 → 描画 → 送信 を分けておかないと、 Anatomia の応答形が変わるたびに
Discord 送信経路まで壊れる。 責務の割り当ては次のとおり。

| ファイル | 責務 |
|---|---|
| `src/db/domain-review-repo.ts` | `domain_review_posts` / `domain_review_answers` の読み書き |
| `src/db/domain-review-seed.ts` | 新規登録時の `domain_review` 既定値判定 (§1)。migration 91 は同時点の方針を自身に凍結 |
| `src/domain-review/anatomia-client.ts` | Anatomia loopback API の取得と project 解決 |
| `src/domain-review/report.ts` | Anatomia の応答 → 投稿用レポートへの形変換 (§2.3) |
| `src/domain-review/types.ts` | 投稿レポートの共有データ形 |
| `src/domain-review/plan-file.ts` | `.anatomia/plan/<hash>.json` の読み書き (§4.1) |
| `src/domain-review/layer-diagram.ts` | 層図の自己完結 HTML 生成 (§3) |
| `src/domain-review/graph-image.ts` | headless Edge による層図の PNG 化 (§3、 任意) |
| `src/domain-review/service.ts` | 3 契機の受け口・投稿可否の判断・返信の取り込み |
| `src/api/domain-review.ts` | `POST /v1/domain-review` と `POST /v1/domain-review/replies` |
| `src/discord/domain-review-embeds.ts` | レポート → Discord embed |
| `src/discord/embed-limits.ts` | embed 上限への適合とメンション無害化 (§2.5) |
| `src/discord/domain-review-post.ts` | Bot 側の投稿口 (`DomainReviewPostPort`) |
| `src/discord/commands/domain-review.ts` | `/domain-review <code>` |
| `web/src/pages/ProjectCodes.tsx` | プロジェクトコード画面の `domain_review` トグル (§1) |

Anatomia の**プログラムドメイン層**では `src/domain-review/*` を `domain-logic` として宣言する
(`.anatomia/layers.json`)。 この層は `src/db/*` (infrastructure) と `src/config/*` へ内向きに
依存するだけで、 `src/api` / `src/discord` (presentation) からは呼ばれる側に置く。
