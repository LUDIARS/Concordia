---
type: feature
title: "Discord セッションのタスク本文投稿と pin"
description: "委託タスクの本文を起動コンテキストの定型文から切り離し、セッション thread へ独立した message として投稿する。段階注入の第 2 段階 (実装タスク) も転記する。タスク未指定の spawn はタスク本文を投稿しない。最初のタスク本文 message だけを pin する。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - delegation
  - inject
  - session
status: implemented
updated: 2026-10-10
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
| `metadata.discord_startup_task` | タスク本文のみ。Cc が spawn したセッション (pending delegation spawn を claim できたもの) で、タスク本文があるときだけ焼く |
| `metadata.discord_startup_inject` | セッション作業ポリシー + Cc ワークフロー inject (定型文) |

Cc spawn でもタスク本文が空なら焼かない。以前は待機指示
(`BLANK_SESSION_TASK`「追加のタスク指示があるまで待機せよ。質問はするな。判断もするな。」)
を焼いてタスク本文として投稿していたが、指示が来なければセッションは元々待つので効果がなく、
「判断もするな」が後続の実タスクまで縛る恐れがあったため 2026-09-29 に廃止した (neco 指示)。
タスク未指定のセッションは Discord にタスク本文 message が出ない。

Cc spawn でないセッション (利用者が自分の端末で起動したもの) にも焼かない。

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

委託由来でない source のうち、Slack 由来 (`slack:<user>`) は発言者付きで転記する。
それ以外の Cc 由来 inject は §3.6 のとおり `⚙️ Cc inject / <source>` 名義で 1 行通知する。

### 3.3 pin 方針

`shouldPinSessionTask()` が決める。pin するのは **最初のタスク本文 1 通だけ**。

| 条件 | pin |
| --- | --- |
| 通常の起動時タスク本文 | ✅ |
| 段階注入の第 2 段階 (`followup`) | ✅ |
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

部署の出力方針 `inject_transcript` が off の部署 (総務・技術相談課など) では、タスク本文と
起動時 Inject を出さない。ただし Discord から起動した人がいれば、起動コンテキスト message を
「`<@起動者>` このセッションを起動しました」だけにして投稿する (2026-10-10 neco 指示「spawn した
セッションは起動者にメンションとばす」)。メンションでスレッドの通知が届くようにするため。
判定は `src/discord/session-startup-context.ts` の `planStartupPosts()` (純関数)。

### 3.5 同時到着時の順序

起動時投稿と委託 inject は別イベントとして並行に届き得るため、同一セッションの
タスク本文投稿は直列化する。各投稿は実行直前に relay state を読み直し、先行投稿が
記録した `discord_task_pinned` を後続投稿の pin 判定へ反映する。これにより、同一
セッションで複数のタスク本文が同時に処理されても、pin 対象は最大 1 通に保たれる。

### 3.6 Cc 由来 inject の 1 行通知

Cc が自分で入れる inject (作業ポリシー更新 `session-work-policy` 系 / テスト交通整備
`testing-traffic` / 委託の状態通知 `delegation:<run>:status|continue|commit|watchdog` /
`auto:inquiry` / director / reaction workflow など) は PTY に
入るだけで Discord にも transcript にも残らない。すべて eventBus の `session.inject` を
通るので、bot がそこで session thread へ 1 行の要旨を通知する (2026-09-30 neco 指示)。
遠隔からでも Cc がセッションに何を伝えたか追え、停止と確認待ちを見分けて引き継げる
(UX-CC-SC-W2)。

判定と文面は `src/discord/cc-inject-mirror.ts` の `ccInjectMirrorPost()` と `summarizeCcInject()`
(純関数) が持つ。`src/discord/cc-inject-mirror.contract.ts` は 1 行要旨の Augur observe 述語
(C-12)、`src/discord/ontime-runtime.ts` はその述語が使う runtime の再公開。

| 条件 | 転記 |
| --- | --- |
| 本文が空 (trim 後) / `ENTER_KEY_TEXT` | ❌ 制御 inject |
| source が `discord` / `discord-enter` / `discord:` 始まり | ❌ 元発言・操作が Discord に見えている |
| source が `slack:<user>` | ❌ ここでは扱わない (§3.2 の Slack 転記) |
| source が委託タスク本文 (`taskKindForInjectSource` が非 null) | ❌ §3.2 のタスク本文投稿 |
| source が `auto:stall-nudge` | ❌ 自動確認は本文を出さず事実だけ通知する (2026-08-25 neco 指示) |
| source が正規 `auto:session-end` | ❌ 内部終了処理は実行し、利用者への転記だけ抑止 (2026-10-03) |
| 部署の出力方針 `inject_transcript` が off (総務など) で、エラーの知らせでない | ❌ 内容は Cc の WebUI のセッション画面で見る (2026-10-10 neco 指示) |
| それ以外 | ✅ |

- username は `⚙️ Cc inject / <source>` (source 空なら `unknown`)、80 文字で切る。
- 本文は全文ではなく `summarizeCcInject(text)` の 1 行 (下の規則) だけを出す。
- エラーの知らせ (`isErrorCcInject`): source が `error-autofix` / `budget-exhausted` / `auto:delegation-watchdog`、
  または 1 行要旨に「失敗・エラー・拒否・衝突」か英語の error / fail(ed/ure) / rejected / conflict を含むもの
  (Revisor の審査失敗など)。`inject_transcript` が off の部署でもこれは出す (departments.md §9.4)。
- 送信は `isActiveDiscordSession` 確認後の webhook 送信で best-effort。失敗は warn ログのみ。

変更理由: 当初 (Revisor #2181) は本文を最大 1900 文字で全文転記していたが、policy update や
project rules は長く、通知として多すぎた (2026-09-30 neco 指示)。何が起きたかだけ分かれば足りる
ので 1 行に絞る。全文は PTY に届いている。

canonical 経路の抑止 (`src/discord/egress.ts` の `isCcInjectEcho`): `session.inject` は message
projection でも session message になる。出所 (人の操作) を持たない Cc 由来 inject は `author_type:
system` + `metadata.inject_is_cc: true` で投影されるため、egress ではこれをスレッドへ出さない。
f372bf4c で投影が `user` から `system` に変わり、`user` 向けの抑止をすり抜けて `[自動確認]` /
`[Cc policy update]` の全文が転記されるデグレが起きた (2026-10-05 neco 指示で修正)。人の絵文字操作
などから展開した注入 (`metadata.injection` あり) は従来どおり転記する。

#### 1 行化の規則 (`summarizeCcInject`)

1. 本文を行分割し、trim して空行を除く。
2. 先頭行が `[タグ] 残り` (`^\[([^\]]+)\]\s*(.*)$`) なら `タグ: 要旨`。要旨は
   - 残りが空でなければ残り。
   - 空なら後続行の `key: value` (`^[A-Za-z][\w.-]*\s*:`) の key を出現順・重複除去で最大 5 個
     ` / ` 連結 (6 個以上は末尾に ` ほか`)。key 行が無ければ次の行。
   - 要旨が無ければタグだけ。
3. それ以外は先頭行そのもの。
4. 連続空白を 1 つに潰し、150 文字を超えたら 149 文字 + `…`。

| inject | 通知 |
| --- | --- |
| 作業ポリシー更新 (`startupPolicyDelta`) | `Cc policy update: repo / branch / workPolicy` |
| project rules | `Cc project rules: Cc (E:/Document/Ars/Concordia)` |
| ブランチ切替 (`branch-watch`) | `⚠️ ブランチ切替を検知しました (main → feat/x)。` |
| goal-and-go | `Concordia goal-and-go 1/3: 人間から新しい入力がないため、…` |
| 自動確認 (session-followup) | `自動確認: Cc の作業状態に応じた確認です。` |

## 4. 関連

- `spec/feature/delegation-implementation-inject.md` — 実装委託の初回 inject 本文そのもの
  (旧 `delegation-staged-injection.md` は 2026-08-21 に廃止)
- `src/discord/session-startup-context.ts` — 定型文側 (mention・委託元リンク・作業ポリシー)

内部終了injectの表示判断は [session-end-inject-visibility.md](session-end-inject-visibility.md) を参照。
本文一致で手入力・引用を消さず、既存plan承認/permissionの通知を変更しない。
