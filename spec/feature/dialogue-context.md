---
type: feature
title: "対話の前提データ — ユースケース・人の訂正・依頼者メモ"
description: "部署のセッションが何をするかをマニュアル画面のユースケースで定義する。ユースケースはフォーマット (雛形) から作り、事前データを持つ。回答に対して人が行った訂正を蓄積して次回以降の事前データにする。投稿ユーザーの技術者レベルややっていることを Cc 内のローカルデータとして持ち、起動時に渡す。"
service: concordia
domain: dialogue-context
tags:
  - departments
  - use-cases
  - corrections
  - requester-profile
  - manuals
status: implemented
related:
  - feature/departments.md
  - feature/webui-manuals-page.md
  - ux/product.md
updated: 2026-09-30
---

# 対話の前提データ — ユースケース・人の訂正・依頼者メモ

> 2026-09-30 neco 指示:「各部署でやることを全く分ける。今の spawn は『総務』で何でもやる雑用。
> 『技術相談課』は『DDD って何が良いの』みたいな質問を投げて回答を返してくれる」「マニュアルのところで
> 定義でき、また対話に関する事前データ/事後補正を行うようにしたい。いくつかフォーマットを用意したい」
> 「事後補正 = 人の訂正を蓄積」「投稿ユーザーの情報も補足する。Cc 内のローカルデータとして保存。
> 『技術者レベル』『やっていること』などのいわゆるメモリに近い内容」。Actio task `a488ab8f`。

## 0. 価値とシナリオ

- 価値 ID: **UX-CC-W1** (作業対象と担当を取り違えずに依頼・確認できる) と **UX-CC-W4**
  (通知を見れば今必要な判断が分かる — 部署ごとに出力を絞る)。
- 失うと困る利用者の状態: 質問だけしたいのに汎用セッションがコードを触り始める。同じ誤答を何度も
  訂正する。初心者にも熟練者にも同じ粒度で答えが返り、毎回自分の前提を書き直すことになる。
- シナリオ:
  1. 運用担当がマニュアル画面で「一問一答 Q&A」フォーマットから「技術相談」ユースケースを作り、
     事前データ (回答の方針・参照資料) を書く。技術相談課の部署にこのユースケースを割り当てる。
  2. 利用者が技術相談課のフォーラムへ「DDD って何が良いの」と投稿する。セッションは読み取り専用で
     起動し、事前データ・これまでの訂正・投稿者メモ (技術者レベル: 初級、やっていること: Unity の
     ゲーム開発) を踏まえて回答する。
  3. 回答に誤りがあれば、人がスレッドで `/co-correct` を使い正しい内容を登録する。次の質問からは
     その訂正が事前データに並ぶ。

## 1. 用語

| 用語 | 意味 |
|---|---|
| ユースケース | 部署のセッションが何をするかの定義。フォーマット・概要・作業モード・事前データ・依頼者メモを使うか |
| フォーマット | ユースケースの雛形。初期値 (概要・作業モード・事前データ) を持つ。コードに固定した集合 |
| 事前データ | 対話の前にセッションへ渡す前提 (回答方針・参照資料・形式) |
| 訂正 | セッションの回答に対して人が登録した正しい内容。同じ会社・同じユースケースの以後の対話で事前データに並ぶ |
| 依頼者メモ | 投稿ユーザーごとの技術者レベル・やっていること・メモ。Cc 内のローカルデータ |
| 作業モード | `edit` (編集可) / `read-only` (編集・git の書き込みをハーネスで止める) |

## 2. フォーマット

**Requirement ID: `SPEC-DLG-FORMATS`**

| key | 名前 | 作業モード | 依頼者メモを使う | 事前ヒアリング | 用途 |
|---|---|---|---|---|---|
| `chores` | 雑用 | edit | しない | しない | 何でも引き受ける汎用 (総務) |
| `qa` | 一問一答 Q&A | read-only | する | する | 質問に回答を返す (技術相談課) |
| `sparring` | 壁打ち相談 | read-only | する | する | 考えの整理・選択肢の比較に付き合う |
| `research-report` | 調査レポート | read-only | しない | しない | 調べて根拠付きの報告を返す |
| `planning-adjustment` | 企画調整 | edit | する | しない | 非エンジニアと体験の言葉で相談・調整・確認する ([企画調整課](planning-adjustment.md)) |

事前ヒアリング (知りたいこと・技術レベル・役職・目的) の中身は [技術相談](tech-consultation.md) §3。

フォーマットは作成時の初期値だけを与える。作成後の値はユースケース側が正で、フォーマットの
変更が既存ユースケースを書き換えることはない。

## 3. 状態所有者と不変条件

**Requirement ID: `SPEC-DLG-USE-CASES`**

| 状態 | 所有者 | 書き込み口 |
|---|---|---|
| `use_cases` | dialogue-context | `/v1/use-cases` |
| `use_case_corrections` | dialogue-context | `/v1/use-cases/:id/corrections`、`/v1/sessions/:id/corrections` (Discord `/co-correct`) |
| `requester_profiles` | dialogue-context | `/v1/requester-profiles` |
| `departments.use_case_id` | 部署 (governance) | `/v1/departments` |

| ID | 条件 |
|---|---|
| CC-DLG-INV-01 | 訂正と依頼者メモは会社 (本社 / 子会社) ごとに分け、別会社のセッションへ渡さない |
| CC-DLG-INV-02 | 起動時に渡す訂正は有効なものだけ、新しい順に上限件数・上限文字数で切る (セッション入力を膨らませない) |
| CC-DLG-INV-03 | read-only のユースケースを持つ部署のセッションは、ファイル編集と git の書き込みをハーネスで拒否する |
| CC-DLG-INV-04 | 依頼者メモはローカル DB だけに置き、ログ・連合スナップショット・通知へ複製しない。起動時のセッション入力にだけ渡す |
| CC-DLG-INV-05 | 訂正の登録は会話の出どころ (セッション / スレッド) と登録者を記録する |
| CC-DLG-INV-06 | 使用中 (部署が参照中) のユースケースは削除せず廃止にする |

## 4. データモデル

```sql
CREATE TABLE use_cases (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, format TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', work_mode TEXT NOT NULL CHECK(work_mode IN ('edit','read-only')),
  pre_data TEXT NOT NULL DEFAULT '', use_requester_profile INTEGER NOT NULL DEFAULT 0,
  intake_enabled INTEGER NOT NULL DEFAULT 0,  -- migration 116 (tech-consultation.md §3)
  archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE use_case_corrections (
  id TEXT PRIMARY KEY, use_case_id TEXT NOT NULL, subsidiary_id TEXT, department_id TEXT,
  session_id TEXT, source TEXT NOT NULL CHECK(source IN ('discord','webui','api')),
  question TEXT NOT NULL DEFAULT '', correction TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE requester_profiles (
  id TEXT PRIMARY KEY, subsidiary_id TEXT, platform TEXT NOT NULL, platform_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '', skill_level TEXT NOT NULL DEFAULT '',
  role_title TEXT NOT NULL DEFAULT '',  -- migration 116 (役職。事前ヒアリングの既定値)
  activities TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- 会社 × platform × user で一意
```

## 5. 起動時に渡すもの

**Requirement ID: `SPEC-DLG-STARTUP`**

部署にユースケースがあるとき、起動の初回指示に次を並べる (admin spawn の全経路):

```
## 部署: <部署名> / ユースケース: <ユースケース名> (<フォーマット名>)
<概要>
### 事前データ
<pre_data>
### これまでの訂正 (人が直した内容。矛盾したらこちらに従う)
- 問: … / 訂正: …
### 依頼者について (use_requester_profile かつ依頼者が分かる場合)
- 技術者レベル: … / やっていること: … / メモ: …
### 今回の相談 (事前ヒアリングを使うユースケースで 4 項目が揃ったとき)
- 知りたいこと: … / 技術レベル: … / 役職: … / 目的: … (空なら「知ること自体が目的」と明示)
```

訂正は新しい順に最大 30 件・合計 6,000 文字。依頼者メモが空なら節ごと省く。

## 6. 訂正の登録

**Requirement ID: `SPEC-DLG-CORRECTIONS`**

- Discord (本社 guild): 部署セッションのスレッドで `/co-correct correction:<正しい内容> question:<任意>`。
  起動権限を持つ人だけが登録できる (以後の回答を左右するため)。子会社 guild に出すコマンドは
  subsidiary-scope の許可リストで絞っているため、子会社の訂正は WebUI から登録する。
  セッションの部署のユースケースへ、会社・部署・セッションを添えて登録する。ユースケースを
  持たない部署・未配属のスレッドでは「このスレッドには訂正先のユースケースがありません」と返す。
- WebUI: マニュアル画面のユースケースから、訂正の追加・編集・無効化・削除。

## 7. 依頼者メモ

**Requirement ID: `SPEC-DLG-PROFILES`**

- WebUI の「依頼者メモ」ページで会社ごとに一覧・編集する。部署フォーラムからの起動で未登録の
  投稿者は、空のメモ行を作っておく (誰がいるか分かるように)。表示名は投稿時点の Discord 表示名。
- 技術レベルと役職は事前ヒアリングの答えで更新し、次の相談の既定値にする (tech-consultation.md §3)。
- API: `GET/PUT /v1/requester-profiles` (loopback のみ)。

## 8. 検証

- 純関数: フォーマットの初期値、起動時ブロックの組み立て (上限・会社分離・空節の省略)、
  read-only 判定。
- repository / API: ユースケースの CRUD と廃止、訂正の登録・無効化、依頼者メモの upsert。
- 起動経路: ユースケース付き部署の起動で初回指示にブロックが入る。依頼者メモが入る。
