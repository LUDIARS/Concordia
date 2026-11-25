---
type: feature
title: "管制カード — 人間のアクション・判断をカードで管理し、捌きとリマインドを dots が担う (Cc v5)"
id: CC-CARDS
service: concordia
domain: control-cards
status: draft
related:
  - plan/2026-11-24-control-session-to-dots.md
  - feature/approval-inbox.md
  - feature/agent-instructions-bridge.md
  - feature/human-request-channel.md
  - feature/control-session.md
updated: 2026-11-25
---

# 管制カード (Cc v5)

## オーバービュー (UX-CC-W5)

`/control` をナビゲーションの先頭に置く。マクロは稼働セッションをプロジェクト単位でまとめ、各ブロックに件数・作業内容・状態内訳・計画の完了ステップ数 / 総ステップ数と割合を示す。ステップ未登録は分母に含めず、計測できたセッション数を併記する。全件未計測は未計測のままとする。依存関係を推測せず、線は稼働セッションの所属を表す。

ブロックを選ぶとミクロ表示で同じプロジェクトのセッションごとの工程・計画・チャットを確認する。受付依頼に対応するセッションは元の依頼 ID を使い、Gen5 の最新報告と判断カードと会話を同じ画面に表示する。Actio のタスク一覧は小さい一行のタイトルで、開くと正式な題名を読める。

### 放置・通信中断からの復帰 (draft)

Actio `actio:03f95a5b-2f41-4953-8364-a367701b84e9`。UX-CC-W5 / UX-CC-S6。タブを放置してから戻った利用者は、再読み込みせず最新の管制情報を読める。ブラウザは欄ごとの前回取得値と接続状態だけを持つ。カード、タスク、セッション、スプリントの正本はそれぞれ従来のサービスが管理する。

**CC-V5-INV-09** 空欄と取得失敗を区別する。定期取得に失敗しても、最後に成功した同じ欄の値を表示して一時的な通信失敗は「再接続中」と示す。タブが可視になったとき、フォーカスが戻ったとき、オンラインに戻ったときに読み直す。古い取得の結果は新しい読み取りに反映しない。WebSocket の再接続後は読み取り API で現在の状態を照合する。操作要求の再送は行わない。

再現手順は、データが表示された `/control` を開いたままタブを隠すか端末をスリープし、その間の通信中断を挟んで復帰する。復帰時の開発者ツールで `/ws` のフレームと `/v1/control/*`、`/v1/taskflow/overview` のステータスを確認する。取得に失敗する間も既存の内容が読め、接続回復後にページを再読み込みせず新しい値に変わることを確認する。

報告された `fetch failed` の発生箇所は未特定。コード上ではブラウザ側の fetch 拒否と、Cc サーバーの Actio 読み取り失敗は別経路。後者はサーバーログに詳細を残し、一覧 API では分類済みのエラー応答を返す。WebSocket は切断イベント後のバックオフを既に持つが、ブラウザの復帰時に接続の鮮度を確認しなかった。管制の定期取得にも復帰イベントからの即時取得がなかった。Web Push の Service Worker に fetch ハンドラは無い。認証失効の関与は実機未確認。

> 所属ドメイン: [`control-cards`](../domains/control-cards.domain.json) (session-coordination の下位)。設計の正本は [Cc v5 計画](../plan/2026-11-24-control-session-to-dots.md)。Actio `5075ba3e-56f7-4f53-a732-af3fda910879`。

2026-11-24 neco 指示 (原文):「人間のアクション、人間の判断が必要なものをカードにして管制が管理するようにCcを改修するので、カードの捌きやリマインドを担当して欲しい。というのをdotsに伝えたのでCcを改修する」「カードやタスク状況、スプリント状況の管理はWebWIでやり、各セッションの細かい指示はDiscordでやる」。

## 価値・シナリオ

- 価値: 人間が「いま自分がやること・決めること」を 1 か所で見て片付けられる (UX-CC-W2 / W4)。
- シナリオ V5-S2: 人間が Web の `/control` でカード・Actio タスク・動いているセッション・スプリント状況を見る。dots が優先度と催促の時刻を決め、Cc が催促する。人間はカードの回答先 (既存の画面) で答え、出所が解決するとカードが閉じる。

## 業務用語と状態の所有者

| 用語 | 状態の正本 |
|---|---|
| カード | `control_cards`。出所の参照・表示内容・捌き・催促の予定を持つ。**解決の正本は出所** |
| 捌き | `control_cards` の priority / assignee / remind_at / reminder_text / card_group と `triaged_by` (`dots:<instruction id>` / `human:<actor>`) |
| 催促 | `control_card_reminders` (送信記録) |
| 人間がやること | カードの `human_action`。質問登録と human-wait が明示値を持ち、空欄は dots が補完する |

### 人間がやることとプロジェクト内のカード

Actio `actio:b5983f59-aa62-468e-abfa-9fb89ef91782`。V5-S2 (UX-CC-W2 / W4) で同時に複数プロジェクトを扱うとき、ミクロ表示ではプロジェクト名の一致または所属セッション ID の一致で、開いている関連カードを表示する。下段の全体カード欄では全プロジェクトを確認できる。

カードの冒頭に人間が実行・判断する一文を表示する。要旨は「詳細」で開く。一文が未設定なら種別に応じて行動の確認または判断の確認を案内する。

`POST /v1/sessions/:id/human-wait` と `POST /v1/sessions/:id/pending-question` は任意の `human_action` を受け付ける。一文は80文字以内で、表示前に空白を整え、秘密を伏字にしてメンションを無効化する。

**CC-V5-INV-09**　dots は `human_action` が空欄の開いているカードだけを補完する。反映時にも空欄を照合し、明示値を保持する。出所から明示値を読めるようになった場合はそちらを優先する。従来のカードは空欄から始まり、通常の同期と指令で補完できる。

出所 (`source_kind`) と閉じる条件は [計画の表](../plan/2026-11-24-control-session-to-dots.md#カードの出所-既存の正本を変えない) のとおり。読み方は承認インボックスの read model (`src/inbox/read-model.ts`) と human-wait / CDGD の `waiting_human` / 進捗ボードの `unresponsive`。人間依頼 (`human-command`) は AI の発言のマーカーからカードを作り、カードが解決状態の正本になる (人間の「済み」・人間依頼の OK ボタン・セッション終了で閉じる)。

日次カイゼンの提案 (`kaizen-proposal`) はセッションを持たない `human_judgment` カードとする。
提案の出所キーで 1 件にまとめ、dots の捌きと催促に載せる。カードが解決状態を持ち、人間が「済み」で閉じる。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-V5-INV-02 | カードは出所の解決状態を書き換えない。回答・実行は既存の経路へ。カードから閉じられるのは人間依頼と日次カイゼンの提案 (他は 409 `resolve_at_source`) | `card-domain.ts` / `service.ts` |
| CC-V5-INV-03 | 閉じるのは出所を読めて、未解決として現れなかったときだけ。読めなかった出所のカードは開いたまま | `card-sync-policy.ts` / `sources.ts` |
| CC-V5-INV-04 | dots は捌きの 5 列を変更し、CC-V5-INV-09 に従い空欄を補完できる。不明・閉じたカード・重複・範囲外の値は捨てる。最後に積んだ自分の指令の `done` だけを適用する | `card-triage-policy.ts` / `card-triage-dispatch.ts` |
| CC-V5-INV-05 | 催促は Cc が出す。同じカードは最短 30 分あけ、深夜帯 (`src/shared/quiet-hours.ts`) は出さない。メンションは構造化した担当者 1 人だけ、本文の mention は無効化 | `reminder-policy.ts` / `reminder-runner.ts` / `src/discord/desk.ts` |
| CC-V5-INV-06 | API と画面は loopback / 既存の Web SSO の範囲。dots には開けない | `src/api/control-cards.ts` |
| CC-V5-INV-07 | Web と Discord は同じ use case (`ControlCardsService`) を呼ぶ | `service.ts` |
| CC-V5-INV-08 | 破棄 (`discarded`) したカードは再び開かず、捌き・催促・既定の一覧に載せず、学習・判断カードの材料へ渡さない | `card-discard-policy.ts` / `card-sync.ts` / `repository.ts` |

## 破棄 (実装メモ 14)

2026-11-24 neco 指示 (原文)「すでに終了したセッション(現状管制が持つアクティブでないセッション)の判断カードは捨ててよい」「状態にdiscardを用意して学習にも使わないようにする。」。

- カードの状態は `open` / `closed` / `discarded`。破棄は `discarded_at` / `discard_reason` を残す。
- 判断カード (`human_judgment`) は持ち主のセッションが active (`sessions.status = 'active'`) のときだけ開いたまま置く。`session_id` があればそのセッション、無い `confirm-pending` は PR を出した Cc セッション (`confirm_runs` → `pr_records.author_session_id`) で判定する。理由は `session_inactive` (持ち主が active でない) / `session_unresolved` (持ち主を引けない)。
- 破棄しない: セッションに属さない判断 (`management-waiting-human` / `director-blocked` / `github-issue-approval`)、`session_id` の無いその他の判断カード、`human_action` (`human-command` / `session-unresponsive`)。持ち主の判定に要る読み取りが失敗した巡回も破棄しない。
- 破棄は出所を書き換えない (CC-V5-INV-02)。同期で作るときに持ち主が active でなければ最初から `discarded` で作り、出所が開いたままでも開き直さない。依頼窓口のスレッドへ知らせない。
- 学習: Cc には `control_cards` の内容を Genius など学習・判断カードの材料へ渡す経路が無い (2026-11-24 時点)。作るときは `discarded` を除く (CC-V5-INV-08)。

## 構成

- 巡回 (1 分、`session.control_session_enabled` が ON の間): 出所の同期 → dots への `card_triage` 指令 → 催促。
- 既定の捌き: 作成時に優先度 normal・催促は 24 時間後。催促した後も 24 時間後に次の予定。
- dots への指令 ([指令ブリッジ](agent-instructions-bridge.md)) は開いているカードの集合、捌き、表示用の一文の変更を検知し、最短 10 分あけて 1 件だけ積む。前の指令が終わっていなければ積まない。params は一文の空欄を先に取り、各グループを優先度・古い順に並べて最大 20 件、要旨 200 字、8000 バイト以内。回答 `detail.cards[]` は `{card_id, priority, assignee?, remind_at?, reminder_text?, group?, human_action?}`。設定 `control_cards.dots_triage_enabled` は既定 ON。
- 催促の届け先: 依頼窓口のスレッド (依頼から起動したセッションのカード)、無ければ管制チャンネル (メンションなし)。
- API: `GET /v1/control/cards?state=open|closed|all|discarded` (既定 open。`all` は開閉だけで、破棄は `discarded` でだけ読める。応答に `discarded_count`)、`PATCH /v1/control/cards/:id` (捌き 5 列と人間依頼の `done`)、`GET /v1/control/sprints` (スプリントの投影、読み取り専用で Actio へ書かない)。
- Web `/control`: カード (捌きの編集)・Actio タスク (既存 taskflow 一覧)・動いているセッション ([プランと進捗](control-session.md))・スプリント状況の 4 欄。カードの管理面は Discord に作らない。

## 復旧

- migration 161 は既存行を保持し、一文の列を空欄で追加する。Actio 依頼の migration 162 を適用済みの DB でも、台帳にない 161 を次の移行で適用する。両方を含むスキーマの版は 162。
- Actio の部分取得は取得済みの範囲と失敗を表示する。管制カードは再接続中も直前の一覧を表示し、プロジェクトのミクロ表示では関連カードに絞る。破棄済み一覧の自動取得は、その一覧を開いている間だけ行う。
- Revisor #4220 の統合は Actio `actio:007240b4-4497-455c-b371-04dee169bedc` を参照。
- `control_cards` を空にしても次の巡回で開いているものが作り直される (捌きと催促の記録は失う)。
- `control_cards.dots_triage_enabled` を OFF で指令を出さない (既定の捌きで回る)。
- 管制を OFF (`session.control_session_enabled`) でカードの巡回は止まる。カードの表は残る。

## 実装の対応

`src/control-cards/` — `card-domain.ts` (用語)、`card-sync-policy.ts` / `card-discard-policy.ts` / `card-triage-policy.ts` / `reminder-policy.ts` (業務判断)、`card-sync.ts` / `human-command-cards.ts` / `card-triage-dispatch.ts` / `reminder-runner.ts` / `service.ts` (use case)、`repository.ts` / `sources.ts` / `card-owner-sessions.ts` (adapter)、`runtime.ts` (組み立て)。`src/api/control-cards.ts`、結線 `src/bootstrap/v5-desk-cards.ts`。

Web (`/control`):

- `web/src/pages/Control.tsx` — 4 欄の配置。
- `web/src/pages/control/CardsPanel.tsx` — カード欄と捌きの編集 (`CardEditor`、「破棄済み n 件」の切替、経過時間 `elapsed`・催促時刻の入力 `toLocalInput`)。人間依頼だけ「済み」を出す。
- `web/src/pages/control/SessionsPanel.tsx` と `SessionProgress.tsx` — 動いているセッションとプラン・進捗 ([control-session.md §13](control-session.md))。未計測・取得できないを出し分ける。
- `web/src/pages/control/TasksPanel.tsx` — Actio タスク (既存 taskflow 一覧を読むだけ)。
- `web/src/pages/control/SprintsPanel.tsx` — スプリント状況 (投影を読むだけ)。
- `web/src/pages/control/controlApi.ts` — 画面が呼ぶ API (`call`・`ApiError`・`controlApi`・過去の雑務の `choresApi`)。
- `web/src/pages/control/usePolling.ts` — 一定間隔の読み直し。読めなかった回は前の値を残してその欄だけ失敗を出す。

## テスト

`src/control-cards/policies.test.ts` (同期の開閉・読めない出所・dots 回答の範囲外・催促の間隔と深夜帯・破棄の判定)、`use-cases.test.ts`、`src/api/control-cards.test.ts`、`web/src/pages/Control.test.tsx`。
