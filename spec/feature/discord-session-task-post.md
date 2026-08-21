---
type: feature
title: "Discord セッションのタスク本文投稿と pin"
description: "委託タスクの本文を起動コンテキストの定型文から切り離し、セッション thread へ独立した message として投稿する。段階注入の第 2 段階 (実装タスク) も転記する。タスク未指定の spawn は「何もするな」を明示のタスクとし、最初のタスク本文 message だけを pin する。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - delegation
  - inject
  - session
status: implemented
updated: 2026-08-18
---

# Discord セッションのタスク本文投稿と pin

## 1. 動機 (問題)

委託したタスクの本文が Discord のセッション thread にほとんど出ていなかった。
作業自体は進むので気付きにくいが、Discord からは「何を頼まれたセッションなのか」が読めない。

原因は 3 つある。

1. **定型文に混ぜていた。**
   `POST /v1/sessions` の登録時に、タスク本文・セッション作業ポリシー・Cc ワークフロー
   inject を 1 本の文字列へ連結して `metadata.discord_startup_inject` に焼き、Discord では
   `**起動時 Inject**` という 1 節にまとめて投稿していた。タスク本文が定型文に埋もれ、
   本文というより「補足」に見える。

2. **段階注入の第 2 段階が転記されていなかった。**
   段階注入 (2026-08-21 廃止。 現行は `spec/feature/delegation-implementation-inject.md`) の
   run では、第 1 段階で渡すのは
   調査ブリーフだけで、タスク本文は伏せてある。本文は調査報告を受けた第 2 段階で
   `session.inject` イベントとして届く。ところが Discord bot はこのイベントを
   **Slack 由来のときだけ**転記していたため、委託由来の inject は 1 通も写らなかった。
   結果、段階注入の run では Discord に調査ブリーフしか残らない。

3. **タスク無しの spawn は何も出なかった。**
   タスクを渡さず provider だけ指定して spawn した素のセッションは
   `startupInjectText` が空で、起動コンテキスト message 自体が投稿されない。

## 2. 方針

タスク本文は会話ログではなく「何を頼まれたか」の宣言なので、定型文から切り離して
**独立した message** にし、**最初の 1 通だけ pin** して thread の定位置に置く。

## 3. 設計

### 3.1 メタデータの分離

`POST /v1/sessions` (`src/api/sessions/lifecycle.ts`) で 2 つに分ける。

| キー | 中身 |
| --- | --- |
| `metadata.discord_startup_task` | タスク本文のみ。Cc が spawn したセッション (pending delegation spawn を claim できたもの) にだけ焼く |
| `metadata.discord_startup_inject` | セッション作業ポリシー + Cc ワークフロー inject (定型文) |

Cc spawn でタスク本文が空なら `BLANK_SESSION_TASK` (`"何もするな"`) を焼く
(`src/shared/session-task.ts`)。空のまま登録すると Discord に何も写らず、
「タスクの無いセッション」と「投稿に失敗したセッション」が区別できなくなるため。

Cc spawn でないセッション (利用者が自分の端末で起動したもの) には焼かない。
そのセッションのタスクは利用者が決めるので、Cc が「何もするな」を宣言する筋合いがない。

### 3.2 投稿

`src/discord/session-task-post.ts` が文面と pin 方針を持つ。投稿契機は 2 つ。

- **起動時** — セッション登録を受けた bot が、起動コンテキスト message より**先に**
  タスク本文 message を投稿する (pin する 1 通目を thread の先頭に置くため)。
- **委託 inject** — `session.inject` の source が `delegation:<runId>:<suffix>` のとき転記する。

| suffix | 種別 | 見出し |
| --- | --- | --- |
| `followup` | `followup` | 📋 **タスク (第 2 段階: 実装)** |
| `parent` | `parent` | 📮 **委託元からの追加指示** |
| `followup-memoria` | `supplement` | 📎 **補足** |

委託由来でない source (`slack:<user>` / `discord-enter` 等) は従来どおり扱う
(Slack 由来のみ発言者付きで転記)。

### 3.3 pin 方針

`shouldPinSessionTask()` が決める。pin するのは **最初のタスク本文 1 通だけ**。

| 条件 | pin |
| --- | --- |
| 通常の起動時タスク本文 | ✅ |
| 段階注入の第 2 段階 (`followup`) | ✅ |
| `"何もするな"` | ❌ 作業の宣言ではない |
| 段階注入 run の第 1 段階 (調査ブリーフ) | ❌ 本文がまだ届いていない。pin は第 2 段階に譲る |
| 補足 (`supplement`) / 追加指示 (`parent`) | ❌ 最初のタスク本文ではない |
| 既に pin 済み (`metadata.discord_task_pinned`) | ❌ |

pin は best-effort。webhook client は pin API を持たないので Bot 権限で
channel → message を引き直す (`ManageMessages` が要る)。失敗しても投稿は成立させ、
`discord_task_pinned` は立てない。

### 3.4 冪等性

| キー | 意味 |
| --- | --- |
| `metadata.discord_task_posted` | タスク本文 message を投稿済み |
| `metadata.discord_task_pinned` | 最初のタスク本文を pin 済み。再起動をまたいで 2 通目を pin しない |

送信に失敗したら投稿済みフラグを立てない (次のセッション登録で再試行できる)。

タスク本文を切り出した結果、起動コンテキスト message の中身が空になることがある。
Discord は空 message を拒否するので投稿はしないが、`discord_startup_context_posted` は
立てる — 立てないとセッション登録のたびに再入して失敗ログを吐き続ける。

### 3.5 同時到着時の順序

起動時投稿と委託 inject は別イベントとして並行に届き得るため、同一セッションの
タスク本文投稿は直列化する。各投稿は実行直前に relay state を読み直し、先行投稿が
記録した `discord_task_pinned` を後続投稿の pin 判定へ反映する。これにより、同一
セッションで複数のタスク本文が同時に処理されても、pin 対象は最大 1 通に保たれる。

## 4. 関連

- `spec/feature/delegation-implementation-inject.md` — 実装委託の初回 inject 本文そのもの
  (旧 `delegation-staged-injection.md` は 2026-08-21 に廃止)
- `src/discord/session-startup-context.ts` — 定型文側 (mention・委託元リンク・作業ポリシー)
