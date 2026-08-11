---
type: feature
title: "お伺い (inquiry) — セッションが次の一手を Cc に諮る決定論プロトコル"
description: "セッションが『次に進んでよいか』をカテゴリ付きで Concordia に諮り、Cc が Genius の判断カードを引いて proceed / ask_human / self_judge を返す。Genius 不在時はセッション側の通常判断に委ねる。作業完了時の自動お伺い (category=タスク)、パートタイマーの残業判定 (category=パートタイマー)、上長メンション、催促通知 (idle nudge) の発火条件をここに集約する。"
service: concordia
domain: governance
tags:
  - inquiry
  - genius
  - goal-and-go
  - idle-nudge
  - delegation
  - lifecycle
  - staff
status: planned
related:
  - feature/goal-and-go.md
  - feature/idle-nudge.md
  - feature/task-workflow.md
  - feature/staff-roster.md
  - feature/autonomous-work-continuation.md
  - feature/session-shutdown.md
updated: 2026-08-02
---

# お伺い (inquiry) — セッションが次の一手を人間に諮る

> 2026-08-02 neco 指示 (項目 3-6) の設計正本。 goal-and-go の「時間が来たら催促する」を
> やめ、「セッションが節目で人間に諮り、 その答えで次の一手を決める」に置き換える。
>
> **「お伺い」 は言葉どおり人間に聞くこと。** ただし人間を毎回起こすのは現実的でないので、
> neco の判断代行である Genius を宛先に置き、 代行できる範囲は Genius が答える。
> 代行しきれない問い (権限・スコープ・方針転換) だけが生身の人間に上がる。

## 0. 原則

0. **お伺いは「人間に聞く」ことである。** Cc が判断を下す仕組みではない。
   セッションは人間 (上長) に諮り、 Cc はその取り次ぎ役に過ぎない。
   **Genius は人間 (neco) の判断代行なので、 その問いの宛先に座る** — 本人に
   代わって答えられるなら Genius が答え、 答えられなければ生身の人間へ上げる。
   この順序を逆に読んで「Cc が Genius を使って判断する」と実装しないこと。
1. **Cc は LLM を内包しない。** Cc がやるのは取り次ぎと決定論的な畳み込みだけ。
   判断そのものは Genius (= 人間の代行) が持つ。 task-workflow §0-4 と同じ思想。
2. **Genius が落ちていたら誰も代行しない。** `genius_available: false` を返し、
   セッション側の通常判断に委ねる。 Cc が代わりに推測することはしない。
3. **お伺いは必ずカテゴリとセットで来る。** カテゴリごとに参照する Genius カテゴリ・
   既定の decision・上長メンションの要否が変わる。
4. **生身の人間を待たせるときだけ催促タイマを張る。** 「最後の投稿から N 秒」ではなく
   「お伺いが `ask_human` に着地してから N 秒」で張る (§5)。

## 1. API

### `POST /v1/inquiry`

```jsonc
{
  "session_id": "lictor-<uuid>",
  "category": "タスク",            // §2 の語彙
  "context": "PR #12 を出して作業完了。残タスクは spec/tasks に 2 件。",
  "options": ["次タスクに着手", "session-end"]   // 任意。 セッションが想定している選択肢
}
```

レスポンス:

```jsonc
{
  "inquiry_id": "inq_<ulid>",
  "decision": "proceed",           // proceed | ask_human | self_judge
  "instruction": "残タスク 2 件のうち…を実装してください。",   // セッションに渡す日本語指示
  "genius_available": true,
  "genius_cards": [                // decision の根拠 (proceed / ask_human 時のみ)
    { "id": "card_…", "title": "…", "score": 0.82 }
  ],
  "supervisor": { "platform": "discord", "user_id": "…", "display_name": "neco" }
}
```

- 認証・到達性は既存 `/v1` と同じ loopback 前提。
- `inquiry_id` は監査用。 `session_events` に `kind: "inquiry"` で
  `{ inquiry_id, category, context, decision, genius_available }` を記録する。
- 同一セッションの同一カテゴリで **60 秒以内の再送はキャッシュ応答**を返す
  (自走ループが Genius を叩き続けるのを防ぐ)。

### `GET /v1/inquiry/:id`

監査・WebUI 表示用。 記録した request/response をそのまま返す。

## 2. カテゴリ

カテゴリは自由文字列ではなく固定語彙。 未知のカテゴリは 400。

| カテゴリ | 送信元 | 用途 | Genius 参照カテゴリ | 上長メンション |
|---|---|---|---|---|
| `タスク` | Lictor (作業完了検知時に自動) | 残作業があるか / 次に着手してよいか | `タスク判断` | `ask_human` のときだけ |
| `パートタイマー` | task-workflow 子セッション (完了時) | 残業して次タスクへ行くか、 session-end するか | `タスク判断`, `稼働判断` | 常に (完了報告として) |
| `設計` | セッション任意 | 設計方針を決めてよいか | `設計判断` | `ask_human` のときだけ |
| `権限` | セッション任意 | スコープ外操作をしてよいか | `権限判断` | 常に (人間承認が要るため) |

`設計` / `権限` は将来拡張のために語彙だけ確保する。 今回の実装スコープは
`タスク` と `パートタイマー` の 2 つ。

## 3. 取り次ぎの手順 (決定論)

Cc は「代行に聞けるか」「代行が答えられたか」だけを機械的に判定する。
**Cc 自身は問いに答えない。**

```
1. 代行 (Genius) が起きているか: GET <GENIUS_URL>/healthz  (timeout 2s, 失敗は即 false)
     ↓ 落ちている = 代行が不在
   → { decision: "self_judge", genius_available: false,
       instruction: "判断代行 (Genius) が不在です。 このセッションの通常判断で進めてください。" }
     ↓ 起きている = 代行に聞ける
2. 代行に問う: POST <GENIUS_URL>/api/clone/query
     { text: <context + カテゴリ + セッション現況>, categories: [<§2 の参照カテゴリ>], k: 8 }
3. 返った判断カード (= 本人の過去の判断) を決定論で畳む:
     - 上位カード (score >= PROCEED_SCORE_MIN) に「本人に聞くべき」旨の
       card.domain / tag が含まれる → ask_human (代行の手に余る = 生身の人間へ)
     - 上位カードが揃って自走可を示す → proceed (本人ならこう答える、と代行が示した)
     - 有効カードが 0 件 (score が全て閾値未満) → self_judge
       (代行に前例が無い。 Cc が推測で埋めない)
4. decision が ask_human なら §4 の上長メンション + §5 の催促タイマ arm。
   ここで初めて生身の人間が呼ばれる。
```

`decision` の意味を取り違えないこと:

| 値 | 意味 |
|---|---|
| `proceed` | 判断代行が「本人ならこう答える」を示した。 進めてよい |
| `ask_human` | 代行では答えられない。 **生身の人間 (上長) に上げる** |
| `self_judge` | 代行が不在 / 前例が無い。 セッションの通常判断に委ねる |

- `GENIUS_URL` は **Excubitor catalog の `provides.GENIUS_URL` から解決する**
  (port-source-rule。 `4230` を Cc 側にハードコードしない)。 catalog から取れない
  場合は Genius 不在扱い = `self_judge`。
- `PROCEED_SCORE_MIN` は config (`CONCORDIA_INQUIRY_SCORE_MIN`, 既定 0.6)。
- Genius が 5xx / タイムアウトを返した場合も `genius_available: false` に倒す。
  **Cc 側で LLM フォールバックはしない** (原則 2)。

## 4. 上長 (supervisor)

上長は**お伺いの最終的な宛先**である。 Genius はその上長 (neco) の判断を代行する
立場なので、 代行が答えられた時点で上長を煩わせない。 `ask_human` に落ちたとき、
つまり代行の手に余ったときだけ、 本人にメンションが飛ぶ。

- **上長は staff_members の 1 人**を指す (`feature/staff-roster.md`)。 役職は問わないが、
  実運用では管理職以上を想定する。
- 解決順:
  1. delegation run に設定された上長 (`delegation_runs.supervisor_platform` /
     `.supervisor_user_id` — 本 spec で追加する列)
  2. delegation template の既定上長
  3. config 既定 (`CONCORDIA_DEFAULT_SUPERVISOR="discord:<uid>"`)
- **この Cc 環境では全員 neco を上長とする** ので、 実際には 3 の既定で足りる。
  それでも 1/2 を用意するのは、 パートタイマーごとに別の上長を割り当てられる
  ようにという指示 (2026-08-02 neco) のため。
- メンションは既存 forum セッションスレッドに 1 通。 内容は
  「<@上長> <カテゴリ> のお伺いです。 <context 要約> / 想定選択肢: …」。
- `ask_human` のお伺いは、既存の `discord_pending_questions` に 1 件の質問カードも作る。
  カード metadata に `inquiry_id` を持たせ、既存 `answer-question` 経路での回答を
  お伺いの解決として扱う。単なるメンション投稿を解決済みの根拠にしない。

## 5. 催促通知 (idle nudge) の発火条件を差し替える

現行 (`feature/idle-nudge.md`) は **最終回答 / summary から N 秒** で arm している。
これをやめ、 **`decision === "ask_human"` に着地した瞬間**に arm する。

- 秒数ルールは据え置き: `CONCORDIA_IDLE_NUDGE_SEC` (既定 120)。
- disarm 条件は現行のまま (user_activity / ユーザ発話 / 人間 inject / セッション終了)。
- 加えて、 同一セッションで **新しいお伺いが `proceed` / `self_judge` に着地した**
  ときも disarm する (人間待ちが解消したため)。
- 通知先は従来の「メッセージを送った人全員」に加えて **§4 の上長**を含める。
- `transcript.frame` を根拠にした arm (`shouldArmIdleNudgeFromFrame`) は撤去する。
  clear 側の判定は残す。

これにより「AI が喋り終わっただけで催促が飛ぶ」誤発火が無くなり、
催促は「Cc が人間の判断を要ると判定したとき」に限定される。

## 6. 作業完了時の自動お伺い (category=`タスク`)

Lictor がセッションの作業完了を検知したら、 セッションに代わって
`POST /v1/inquiry { category: "タスク" }` を送る。

- **完了の検知**: 既存の completion ブラックボックス (`taskflow/completion`) の
  判定を再利用する。 Lictor 側に新しい意味判断を持たせない。
- `context` には Lictor が持っている材料を機械的に詰める:
  active repo 群、 branch、 未 commit 差分の有無、 直近の PR、 現在タスク。
- 応答の `instruction` は既存の inject 経路 (`session.inject`,
  `source: "auto:inquiry"`) でセッションに流す。 goal-and-go の
  `auto:goal-and-go` と同じ扱いで、 requester inject では無いので idle は clear しない。

## 7. パートタイマーの残業判定 (category=`パートタイマー`)

task-workflow で起動した子セッション (= パートタイマー) は、 **作業完了しても
自動終了しない**。 完了時に以下を行う:

```
実装完了 → POST /v1/delegation/runs/:id/status {completed}   (既存)
        → POST /v1/inquiry { category: "パートタイマー", context: <完了報告> }
        → 上長 (§4) へ完了報告メンション (常に)
        → 応答を見て セッション自身が 残業 / session-end を決める
             proceed     → 次タスクに着手 (残業)
             ask_human   → 上長の返答を待つ (§5 の催促タイマが張られる)
             self_judge  → 残タスクの有無を自分で確認し、 無ければ session-end
```

- **決めるのはセッション自身**。 Cc は材料 (`instruction` + 残タスク一覧) を返すだけ。
- `session-end` を選んだ場合は `feature/session-shutdown.md` の shutdown 手順に乗る。
- 既存の `finishAutonomousTaskflow` (`src/taskflow/session-end.ts`) は
  「自動で session-end inject を撃つ」実装なので、 **お伺い送信に置き換える**。
  自動終了はここで廃止される。

## 8. goal-and-go との関係

- goal-and-go の「idle 経過で自走継続を促す」経路は **お伺いの `タスク` カテゴリに
  統合する**。 `startGoalAndGo` が `createIdleNudge` で張っていたタイマは撤去し、
  継続判断はお伺いの応答 (`proceed` の `instruction`) で行う。
- `continuation_count` / `maxContinuations` / `maxRuntimeSec` の上限は**残す**
  (暴走の最終防波堤)。 上限に達したら `stopped_reason` を立て、 以後のお伺いは
  `ask_human` に固定する。
- `taskflow.continue_requested` 経由の継続は現行どおり動く。

## 9. 設定

| 変数 | 既定 | 意味 |
|---|---|---|
| `CONCORDIA_IDLE_NUDGE_SEC` | 120 | `ask_human` 着地から催促までの秒数 (§5) |
| `CONCORDIA_INQUIRY_SCORE_MIN` | 0.6 | Genius カードを採用する最低スコア |
| `CONCORDIA_INQUIRY_CACHE_SEC` | 60 | 同一 (session, category) の再送キャッシュ |
| `CONCORDIA_DEFAULT_SUPERVISOR` | — | `discord:<uid>` 形式の既定上長 |

## 10. 受け入れ条件

1. Genius 停止中に `POST /v1/inquiry` を叩くと `genius_available: false` /
   `decision: "self_judge"` が返り、 Cc は Genius へのリトライで待たされない (2s 以内)。
2. Genius 稼働中は判断カードが引かれ、 `genius_cards` が根拠として返る。
3. `ask_human` 着地から 120 秒 人間の応答が無いと、 上長を含むメンション付き催促が 1 通飛ぶ。
   最終回答を返しただけでは催促は飛ばない。
4. パートタイマーが作業完了しても自動で終了せず、 上長への完了報告と
   お伺いが飛び、 その応答で残業 / session-end が決まる。
5. `session_events` に `kind: "inquiry"` が残り、 `GET /v1/inquiry/:id` で追跡できる。
