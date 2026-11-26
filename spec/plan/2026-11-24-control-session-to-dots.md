---
type: plan
title: "Cc v5 — 依頼窓口と管制カード: 人間のアクション・判断をカードで管理し、捌きとリマインドを dots が担う"
service: concordia
domain: control-session
status: draft
related:
  - feature/control-session.md
  - feature/approval-inbox.md
  - feature/agent-instructions-bridge.md
  - feature/chores-forum-window.md
  - feature/human-request-channel.md
updated: 2026-11-24
---

# Cc v5 — 依頼窓口と管制カード

Actio `5075ba3e-56f7-4f53-a732-af3fda910879`。Cc の公開版は `package.json` 3.0.0 → 3.1.0 (マイナー。neco 2026-11-24「3.1.xでたのむ」、4.0.0 は MUSA 系を組み込んだ後)。「Cc v5」は Gen5 ワークフローの中核となる世代名。

## 経緯

- 2026-11-23 neco 指示 (原文):「管制セッションをdotsに移行する。またパートタイマー軽作業の多くをMuseとdotsに割り当てることにした。dotsと相談しながら移行を進める」
- 同日 dots へ相談指令 `inst:dots:20261123T130231Z:cff4ae`。2026-11-24 07:09 JST 回答: 判断だけを段階移譲し、巡回・進捗ボード・inject・停止は Cc に残す案 (付録 A)。
- 2026-11-24 neco 指示 (原文):「管制はどのプロジェクトがというわけでもない。依頼窓口のチャットを設けて、実行内容に従って人間のアクション、人間の判断が必要なものをカードにして管制が管理するようにCcを改修するので、カードの捌きやリマインドを担当して欲しい。というのをdotsに伝えたのでCcを改修する。Discordのインタフェースは残しつつWebUIで完結出来るように対応する。WebUIにはActioのタスクの一覧と現状何のプロジェクトでどういう作業のセッションが動いているかを一覧視できるようにする。」
- 同日 neco 指示 (原文):「これをCcバージョン5とし、Gen5ワークフローの中核にする」

付録 A の段階移譲案 (1 プロジェクトで影運用) は、この指示で「プロジェクト単位ではなく Cc 全体の管制」「dots の担当はカードの捌きとリマインド」に置き換わった。

## 価値とシナリオ

- 価値: 人間が「いま自分がやること・決めること」を 1 か所で見て片付けられる (UX-CC-W2 / W4)。依頼から実行・人間の手当てまでが 1 本の流れで追える (UX-CC-W5)。
- シナリオ V5-S1: 人間が依頼窓口に依頼を書く → Cc が Actio タスクを作り作業セッションを起動 → 作業中に人間のアクション / 判断が要るとカードができる → dots が優先度と催促の時刻を決める → Cc が催促する → 人間がカードから回答・実行 → カードが閉じる → 依頼窓口に結果が返る。
- シナリオ V5-S2: 人間が WebUI の管制画面で、カード・Actio タスク・動いているセッション (プロジェクト・作業内容・分類) を一覧で見る。Discord だけでも同じ操作ができる。

## 業務用語と状態の所有者

| 用語 | 意味 | 状態の正本 |
|---|---|---|
| 依頼 (desk request) | 依頼窓口に人間が書いた 1 件。受付キーで冪等 | 新設 `desk_requests` (Cc DB)。受付元 (web / discord)・依頼者・本文・Actio 参照・起動した spawn ID / session ID・状態 (`accepted` → `launching` → `running` → `finished` / `launch_failed`) |
| 依頼の会話 | 依頼ごとの往復 (人間の追記・セッションからの返信・カードの開閉の知らせ) | 新設 `desk_messages`。セッション本文は既存 `session_messages` が正本で、ここは依頼への紐付けと表示用の写し |
| 管制カード (card) | 人間のアクション (`human_action`) または人間の判断 (`human_judgment`) が要る 1 件 | 新設 `control_cards`。**解決の正本は出所** (下表)。カードが持つのは出所の参照・捌きの状態・催促の予定だけ |
| 捌き (triage) | カードの優先度・担当者・次の催促時刻・催促文・まとめ先 | `control_cards` の triage 列。書くのは dots (指令ブリッジの回答) と人間 (WebUI / Discord) |
| 催促 (reminder) | 予定時刻に Cc が出す知らせ | `control_card_reminders` (送信記録)。送るのは Cc |

### カードの出所 (既存の正本を変えない)

承認インボックス (approval-inbox.md) の read model を元に、カードの「出所」を固定する。カードは出所の行を参照し、出所が解決したらカードを閉じる (カード側からは解決させない。回答は既存の経路へ渡す)。

| 出所 `source_kind` | 種別 | 正本 | 閉じる条件 |
|---|---|---|---|
| `ask-card` | judgment | `discord_pending_questions` (inquiry_id 無し) | 回答済み、またはセッション終了 |
| `inquiry-ask-human` | judgment | inquiry 監査行 + `discord_pending_questions` | 同上 |
| `confirm-pending` | judgment | `confirm_runs` | pending / confirming を抜けた |
| `director-blocked` | judgment | `director_steps` | blocked を抜けた |
| `design-plan-approval` | judgment | 既存の plan 承認 | 承認・却下 |
| `human-wait` | judgment | session metadata `cc_human_wait` | 解除、またはセッション終了 |
| `human-command` | action | 人間依頼チャンネルの投稿記録 (human-request-channel.md) | OK 済み |
| `management-waiting-human` | judgment | `management_requests` (waiting_human) | 状態が進んだ |
| `session-unresponsive` | action | 進捗ボード `control_progress_board` (unresponsive) | 分類が変わった、またはセッション終了 |

カードの同一性は `(source_kind, source_key)`。同期は巡回 (1 分) で出所を読み、無ければ作り、閉じたら閉じる。出所を読めなかった巡回では閉じない (CC-V5-INV-03)。

## 不変条件

| ID | 内容 |
|---|---|
| CC-V5-INV-01 | 依頼は受付キー (`web:<client_request_id>` / `discord:<guild>:<message>`) で 1 回だけ受け付け、Actio タスクの作成と起動はそれぞれ 1 回だけ。結果不明は照合し、再送しない |
| CC-V5-INV-02 | カードは出所の解決状態を書き換えない。回答・実行は既存の経路 (answer-question / confirm / director / human-request OK) へ渡す |
| CC-V5-INV-03 | カードを閉じるのは出所が解決した (読めて、解決を示した) ときだけ。読めないときは開いたまま |
| CC-V5-INV-04 | dots の捌きは優先度・担当者・催促時刻・催促文・まとめ先だけを変えられる。カードの開閉・回答・セッション操作はできない。回答の中の不明なカード ID・閉じたカードへの捌きは捨てる |
| CC-V5-INV-05 | 催促は Cc が出す。同じカードへの催促は最短 30 分あけ、深夜帯 (既存の quiet-hours) は出さない。メンションは担当者 1 人だけ (構造化フィールド)、本文の mention は無効化 |
| CC-V5-INV-06 | 依頼窓口・カード・一覧の Web 画面は loopback / 既存の Web SSO の範囲内。dots には開けない (dots は指令ブリッジのみ) |
| CC-V5-INV-07 | Discord と WebUI は同じ use case を呼ぶ。片方でしかできない操作を作らない |
| CC-V5-INV-08 | 破棄 (`discarded`) したカードは再び開かず、捌き・催促・既定の一覧に載せず、学習・判断カードの材料へ渡さない (実装メモ 14) |

## 構成

### 1. 依頼窓口 (desk)

- Web `/desk`: 依頼の投稿欄と、依頼ごとの会話一覧 (状態・Actio タスク・起動したセッション・開いているカード)。
- Discord: 本社 guild のトップレベルに「依頼窓口」テキストチャンネル。投稿 1 件が依頼 1 件、返信はスレッド。
- 受付すると: (1) `desk_requests` に保存 → (2) Actio タスクを作る (既存 `POST /v1/taskflow/tasks` の use case) → (3) 作業セッションを起動 (既存 spawn。部署「AI総合 / 雑用」、cwd は Castra root。依頼本文と Actio 参照を渡す) → (4) session ID を照合して `running`。
- セッションの返信 (session_messages の AI 発言) は依頼の会話へ写す。セッション終了で `finished`。
- 既存の「雑務窓口」は依頼窓口へまとめる (2026-11-24 neco 決定「依頼窓口にまとめる」):
  - Discord: 既存 `chores_channel_id` のテキストチャンネルを「依頼窓口」へ改名して ID・履歴を引き継ぐ。雑務課フォーラム (`chores_forum_channel_id`) は「依頼」フォーラムへ改名し、依頼 1 件 = スレッド 1 本の置き場にする (窓口には受付案内とスレッドへのリンクだけを返す、chores-forum-window.md の作りを引き継ぐ)。
  - 雑務のワンショット (`claude -p` / `codex exec` + OK / Continue) の新規受付をやめる。依頼は常に通常の作業セッションとして起動する (カードの出所になる human-wait・質問カードはセッションにしか無いため)。先頭 `[codex]` は Codex のセッション起動として引き継ぐ。
  - 既存の `chores_runs` は読み取り専用で残し、Web `/chores` は `/desk` へ転送して過去の雑務を「過去の雑務」欄に出す。処理中の雑務 run は従来の経路で完了・OK / Continue まで扱う (途中で切らない)。
- 依頼から起動するセッションは部署「AI総合 / 雑用」、cwd は Castra root。対象プロジェクトはセッション自身が決める (2026-11-24 提案、neco から異論なし)。

### 2. 管制カード

- 巡回が出所を同期する (上表)。依頼から起動したセッションのカードは依頼に紐付けて会話にも出す。
- Web `/control` のカード欄: 種別・要旨・出所のプロジェクト / セッション・経過時間・優先度・担当者・次の催促。各カードから既存の回答 UI へ遷移 (ask カードは Web チャットの回答、confirm は confirm 画面…)。人間も優先度・担当者・催促時刻を変えられる。
- Discord: 既存の各チャンネル (質問カード、人間依頼、CDGD管理) はそのまま。新設「管制カード」チャンネルに、開いたカードの一覧 1 通をピン留めして編集で更新する。催促はそのチャンネルへ。

### 3. dots の捌き (指令ブリッジ)

- 指令ブリッジの type に `card_triage` を追加 (CC-INST-INV-02 の改訂)。
- 開いているカードの集合か内容が変わったら (最短 10 分あけて) Cc が dots 宛てに `card_triage` 指令を 1 件登録する。前の指令が終わっていなければ新しく積まず、終わってから最新の集合で積む。params はカードの最小の要約 (id・種別・要旨 300 字・プロジェクト・経過時間・現在の捌き)。本文・transcript は入れない。
- dots の result `detail.cards[]` = `{card_id, priority: high|normal|low, assignee?, remind_at? (ISO), reminder_text? (400 字), group?}`。Cc は CC-V5-INV-04 の範囲だけを適用し、適用した捌きの出所を `dots:<instruction id>` として残す。
- dots が応答しない (指令が 30 分で pending に戻るのは既存のまま) 間も、カードは既定の捌き (優先度 normal、催促は 24 時間後) で回る。

### 4. 一覧 (WebUI `/control`)

1 画面に 3 欄。

| 欄 | 内容 | 読み口 |
|---|---|---|
| カード | 上記 | 新設 `GET /v1/control/cards` |
| Actio タスク | プロジェクト・題・状態・担当セッション・PR | 既存の taskflow 一覧 (`api.taskflow*`)。Cc の全プロジェクトを横断 |
| 動いているセッション | プロジェクト・branch・現在のタスク・分類 (作業中 / 結果待ち / 人間待ち / 停止 / 応答なし)・最終活動 | 既存 `GET /v1/control/board` (進捗ボード) |

### 5. 管制セッション (Cc 内の常駐 Claude) の扱い

- v5 では管制の判断の担い手を dots (捌き・リマインド) と Cc の機械的な巡回に分け、Cc 内の常駐 Claude 管制セッションは起動しない (`session.control_session_enabled` の意味を「巡回とボード・カード」に限定し、本体の起動を外す)。
- 停止セッションへの既定の追加指示 (巡回の自動送信) は今のまま残す。応答なしに上がったものはカード (`session-unresponsive`) になり、人間か dots の捌きに乗る。
- 管制チャンネルの状況確認 (側セッション) と一括指示は今のまま残す。

## 実装の置き場所 (DDD)

| 層 | ファイル |
|---|---|
| ドメイン (純関数) | `src/control-cards/card-sync-policy.ts` (出所の行 → カードの作成・閉鎖の判定)、`card-triage-policy.ts` (dots 回答の検証と適用範囲)、`reminder-policy.ts` (催促の要否・間隔・quiet-hours)、`src/desk/desk-request-policy.ts` (受付・状態遷移) |
| use case | `src/control-cards/card-sync.ts` (巡回から呼ぶ)、`card-triage-dispatch.ts` (指令の登録と回答の適用)、`reminder-runner.ts`、`src/desk/desk-intake.ts` (受付 → Actio → spawn → 照合) |
| adapter | `src/db/control-cards-repo.ts`、`src/db/desk-repo.ts` (migration 新設)、`src/api/control-cards.ts`、`src/api/desk.ts`、`src/discord/desk-channel.ts`、`src/discord/control-cards-channel.ts` |
| Web | `web/src/pages/Desk.tsx`、`web/src/pages/Control.tsx` (+ `control/` 配下に欄ごとの部品) |
| spec | `spec/feature/request-desk.md`、`spec/feature/control-cards.md`、`spec/domains/control-cards.domain.json` (新設ドメイン、所属は session-coordination の下位)、`control-session.md` §1 の改訂、`agent-instructions-bridge.md` の type 追加 |

テストは各 policy の単体、use case (受付の冪等・結果不明の照合・カード同期の開閉・読めない巡回で閉じない・dots 回答の範囲外を捨てる・催促の間隔)、API、Web 画面の表示。`cc.acceptance.json` に対応付ける。

## 実装メモ (2026-11-24 既存コードの調査結果、上の記述より優先)

1. **依頼窓口は Actio タスクを自分で作らない**。起動したセッションが既存の起動方針どおり対象プロジェクトに Actio タスクを作り `POST /v1/sessions/:id/task-links` で紐付ける (taskflow の所有を崩さない)。依頼の表示はそのセッションの task-links を読む。§1 の (2) はこれに置き換える。
2. **`desk_messages` は作らない**。セッション本体の会話は既存のセッション用 Discord チャンネル / Web チャット (`/sessions/:id`) が正本。依頼窓口の会話 (Discord スレッド・Web の依頼詳細) には、受付・起動 (セッションへのリンク)・カードの開閉・終了の知らせだけを出す。
3. **起動は CDGD 管理の起動と同じ作り** (`src/management/runtime.ts` の `launch` と `src/management/dispatcher.ts`): spawn ID を `desk_requests` に保存 → `recordPendingDelegationSpawn({cwd: workspaceRoot, spawnId, callName: "desk", departmentId, startupInjectText})` → `spawnSession` → `sessions.metadata.concordia_spawn_id` で照合して `running`。例外は `launch_unknown`、5 分で現れなければ `launch_failed`。同じ依頼を別 ID で起動し直さない。部署は設定 `desk.department_id` (空なら部署なし)。コスト上限中は `accepted` のまま待つ。
4. **migration は 156** (`src/db/v5-desk-cards-migration.ts`、`schema.ts` の末尾に追加)。表は `desk_requests` (id, request_key UNIQUE, origin web|discord, requester, provider claude|codex, body, state accepted|launching|launch_unknown|running|finished|launch_failed, spawn_id UNIQUE, session_id, launch_deadline_at, error, discord_thread_id, created_at, updated_at, revision)、`control_cards` (id, source_kind, source_key, card_kind human_action|human_judgment, summary, session_id, project, link, state open|closed, raised_at, closed_at, close_reason, priority high|normal|low, assignee, remind_at, reminder_text, card_group, triaged_by, triaged_at, created_at, updated_at, UNIQUE(source_kind, source_key))、`control_card_reminders` (id, card_id, sent_at, channel, text)。時刻は epoch ms。
5. **カードの出所の読み方**: `src/inbox/read-model.ts` の `inboxItems(db)` (ask-card / design-plan-approval / inquiry-ask-human / director-blocked / confirm-pending / github-issue-approval、raisedAt は ms) をそのまま使う。加えて human-wait (`sessions.metadata.cc_human_wait`、`src/control/human-wait.ts` の `readHumanWait`、active のセッションのみ)、management の `management_requests.state='waiting_human'`、進捗ボード `control_progress_board.status='unresponsive'` (時刻は秒)。
6. **人間依頼 (human-command) は DB に記録が無い** (Discord への投稿だけ)。カードは `session.message` (author `assistant`) の本文を `parseHumanCommandRequests` (`src/discord/human-command-marker.ts`) で読んで作り、`source_key=<session_message_id>:<index>`。このカードだけはカードが正本で、人間が Web / Discord で「済み」にしたとき、または Discord の人間依頼の OK ボタン、またはセッション終了で閉じる。
7. **dots の捌き**: `src/agent-instructions/instruction-policy.ts` の `INSTRUCTION_TYPES` に `card_triage` を追加。登録は `agentInstructions.routes.service.register(...)` (params は 8000 バイト上限なので、カードは優先度・古い順に最大 20 件、要旨 200 字まで詰める)。結果の受け取りは `createInstructionEventRelay` が受け手 1 つ (`attach`) しか持たないので、`subscribe(listener) → unsubscribe` を足して `finished` を受ける (既存の「muse-指令」チャンネルの attach は変えない)。
8. **Cc 内の管制セッション本体を止める**: `createControlSupervisor` に `isBodyEnabled()` を足し、新設定 `session.control_session_body_enabled` (既定 false) が false の間は singleton の起動と停止要約の送信をせず、保持者がいれば終了案内を送って保持者だけ消す (ボード・巡回の追加指示・片付け・毎時まとめ・管制チャンネルは今のまま動かす)。
9. **雑務の受付停止**: `src/discord/chores.ts` の窓口・フォーラムからの新規受付をやめ (既存 run の配達・OK / Continue は残す)、窓口チャンネルは `src/discord/desk.ts` が引き継いで「依頼窓口」へ改名する。依頼ごとのスレッドは窓口の投稿から `message.startThread` で作る (雑務課フォーラムは過去の雑務の表示用に残す)。Web `POST /v1/chores` は 410 `chores_retired_use_desk` を返し、`/chores` 画面は `/desk` へ案内する。
10. **設定の追加** (`src/config/settings/definitions/`): `desk.enabled` (boolean、既定 true)、`desk.department_id` (string、既定空)、`control_cards.dots_triage_enabled` (boolean、既定 true)、`session.control_session_body_enabled` (boolean、既定 false)。
11. **版**: `package.json` の version を `3.1.0` に (Revisor のマイナー Release)。
12. **面の分担** (2026-11-24 neco 指示 (原文)「軽い依頼も重い依頼も全て一つの窓口でやれるようにする。カードやタスク状況、スプリント状況の管理はWebWIでやり、各セッションの細かい指示はDiscordでやる」):
    - 依頼は軽重を問わず依頼窓口 1 つで受ける (雑務のワンショットを別口で残さない。軽い依頼も通常のセッションとして起動し、セッションが短く済ませる)。
    - **管理は WebUI**: `/control` にカード・Actio タスク・動いているセッションに加えて **スプリント状況** の欄を置く。スプリントの正本は Actio で、Cc は `src/sprint-dialogues/` の投影 (dialogueKey=`actio:<teamId>:<sprintId>`、フェーズ・closed・タスク) を持つので、それを読み取り専用で出す (Cc から Actio へ書かない)。カードの捌きの変更 (優先度・担当者・催促・済み) も Web で行う。
    - **各セッションへの細かい指示は Discord** の既存のセッション用チャンネル / スレッド。Web の依頼詳細・カードからはそのチャンネルへのリンクを出す。Discord の依頼窓口は受付と案内だけで、カードの管理面は Discord に新設しない (「管制カード」チャンネルの新設をやめ、催促だけを依頼窓口スレッドまたは管制チャンネルへ出す)。§2 の Discord の記述はこれに置き換える。
13. **セッションのプランと進捗** (2026-11-24 neco 指示 (原文)「WebUIの状況には今出てない「プラン」と「進捗」を出す」):
    - `/control` の「動いているセッション」欄と `/desk` の依頼詳細に、各セッションの「プラン」と「進捗」を出す。読み取り専用で、既存の正本を読むだけ。
    - プラン: `session_task_records` (`src/db/session-task-records-repo.ts`。Claude Code の TodoWrite (task_update)・デスクトップアプリ / agy のプラン (desktop_plan) の両方がここへ写る) のステップ一覧と状態 (pending / in_progress / completed)。あれば `metadata.desktop_plan` の状態 1 行。加えて作業段階 work_phase (design / confirmation / implementation / adjustment と design_summary、`src/work/session-work-phase.ts`)。
    - 進捗: ステップの完了数 / 総数、自動確認の進捗率 (metadata `cc_followup_progress` の指紋に残る値、`src/control/followup-progress.ts` / `followup-progress-rate.ts`。未計測は「未計測」と出し 0% にしない)、紐付いた Actio タスクの状態 (`GET /v1/sessions/:id/task-links` と同じ読み口)。
    - 読み口は新設の `GET /v1/control/sessions` (ボードの行 + 上の値をまとめて返す、loopback / Web SSO の範囲)。1 秒以内で返す (ステップは全セッション分を 1 回の照会で引く。Actio は既存の読み口をセッションごとに並行で引き、短い期限と短期のキャッシュを付け、読めなければその欄だけ「取得できません」)。
    - テスト: プラン・進捗の組み立て (純関数) と API、画面の表示 (未計測・取得失敗の出し分け)。
14. **カードの破棄 (discard)** (2026-11-24 neco 指示 (原文)「カードが多すぎる…すでに終了したセッション(現状管制が持つアクティブでないセッション)の判断カードは捨ててよい」「これはGeniusのingestでも問題になってたな。そっちのケースでも捨てる。状態にdiscardを用意して学習にも使わないようにする。」):
    - 実測 (反映後の本番): 開いているカード 889 件 = confirm-pending 888 (すべて session_id なし、最古は 2026-09 の confirm_runs) + human-wait 1。
    - `control_cards.state` に `discarded` を足す (CHECK を変えるので表の作り直し、migration 158)。列 `discarded_at` / `discard_reason`。
    - 判断カード (`card_kind = human_judgment`) は、持ち主のセッションが active (`sessions.status = 'active'`。管制が進捗ボードに載せるのと同じ集合) のときだけ open のまま置く。持ち主が active でなければ `discarded`。
      - `session_id` のあるカードはそのセッションで判定 (無い・active でない → `session_inactive`)。
      - `session_id` の無い `confirm-pending` は、PR (`confirm_runs.repo_origin` + `pr_number`) を出した Cc セッションを既存の PR 記録 (`pr_records.author_session_id`) から引いて判定。引けない → `session_unresolved`、active でない → `session_inactive`。
      - セッションに属さない判断 (`management-waiting-human` / `director-blocked` / `github-issue-approval`) は破棄しない (セッションと無関係な人間の判断)。上記以外で `session_id` の無い判断カードも判定できないので残す。
      - `human_action` (`human-command` / `session-unresponsive`) はこの規則の対象外。
    - 破棄は出所を書き換えない (`confirm_runs` 等はそのまま、CC-V5-INV-02)。破棄したカードは出所がまだ開いていても再び open にしない。同期で作るときに持ち主が active でなければ最初から `discarded` で作る (同じ出所を毎巡回作り直さないため)。持ち主の判定に要る読み取りが失敗した巡回では破棄しない。
    - 破棄したカードは dots の捌き (`card_triage` の params) に入れず、催促もしない (どちらも開いているカードだけを見る)。依頼窓口のスレッドへの開閉の知らせも出さない (一度に数百件の破棄が流れないように)。既定の一覧 `GET /v1/control/cards` (`state=open|closed|all`) と画面からは外し、`?state=discarded` でだけ読める。一覧の応答に `discarded_count` を添え、画面に「破棄済み n 件」の切替を出す。依頼詳細のカード要旨 (セッション別) にも出さない。
    - 学習に使わない (CC-V5-INV-08): 2026-11-24 時点で Cc には `control_cards` の内容を Genius など学習・判断カードの材料へ渡す経路は無い。今後渡す口を作るときは `discarded` を除く。
    - テスト: 終了したセッションの判断カードが discarded になる、active なら open、session の無い confirm-pending の判定 (引けない / active でない / active)、セッションに属さない判断は残る、human_action は対象外、破棄は再 open しない、triage と催促に入らない、一覧の既定から外れる。

## 復旧

- 依頼窓口: 設定 `desk.enabled` (既定 ON) を OFF で新規受付を止める。受付済みの依頼・セッションは影響を受けない。
- カード: 出所の正本を変えないので、`control_cards` を空にしても次の巡回で開いているものが作り直される (捌きと催促の記録は失う)。
- dots の捌き: 設定 `control_cards.dots_triage_enabled` を OFF で指令を出さない (既定の捌きで回る)。

## 決定済み

1. 雑務窓口は依頼窓口へまとめる (neco 2026-11-24)。
2. 依頼から起動するセッションは AI総合 / 雑用、Castra root (提案どおり)。

## 付録 A: dots の回答 (2026-11-24 07:09 JST、inst:dots:20261123T130231Z:cff4ae)

- Q1: 推論はクラウド。本社の接続 PC から指令口を受領・返信 (現状手動、5 分間隔の自動は未設定)。管理口は到達と 401 の確認のみ。
- Q2: 判断は既存の CDGD 管理口で、Cc を実行者に。巡回・進捗ボード・適格性判定・inject は Cc に残す。管理者 API は開けない。一括指示・毎時まとめは当面 Cc。
- Q3: 軽作業のうち 1〜8 (朝礼・Memoria 関連未完了・ディレクター整理・課題スカウト・依存点検・週次レビュー・AIノートの下書き・ダッシュボード) は dots が要約・判断・提案、書き込みは既存側。9〜13 (Genius・Vultus・Steam persona・Gmail watch・メール取り込み) は Cc / 本社に残す。
- Q4: 段階移譲 (影運用 → 承認付き限定実行 → 所有者承認で該当判断だけ停止)。

パートタイマー軽作業の移し替えは v5 のカードとは別 PR で扱う (Muse の割当ては未決)。
