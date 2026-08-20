---
type: feature
title: "Director 問診セッション — 人間への問いかけを LLM セッションに作らせる"
description: "Director が人間の判断を要する状態を検出したとき、機械文の通知カードで終わらせず、読み取り専用の問診セッションを spawn する。セッションが case/step/task md/run ログを読んで Decision Request を組み立て、既存の Genius 判定 + ask_human 質問カード経路に載せて人間へ問いかける。"
service: concordia
domain: governance
tags:
  - director
  - inquiry
  - delegation
  - question-card
status: draft
related:
  - feature/director.md
  - feature/director-patrol.md
  - feature/inquiry.md
  - feature/plan-gate.md
  - feature/question-option-codes.md
updated: 2026-08-20
---

# Director 問診セッション

> 2026-08-20 neco 指示。「ディレクターがタスクセッションを spawn して人間に問いかけて
> くる仕組みを作りたい」。

## 0. 位置づけと解く問題

director.md §0 の原則どおり **Director エンジンは LLM を呼ばない**。そのため現状、
人間の判断が要る状態は director-patrol.md §1.4 の `question` カード
(「run が失敗した」「予算超過」「target_repo が解決できない」) として出るが、これは
**事象の通知**であって**問い**ではない。文脈も選択肢も無いので、人間は結局自分で
調べ直すことになる。

一方、意味のある問い (`Decision Request`: kind / question / facts / options / impact) を
組み立てる経路は既に director.md §2 にあるが、**担当セッションが動いている case にしか
存在しない**。停滞・失敗して担当が居なくなった case ほど問いが出ない。

本 spec はこの穴を埋める。Director は「問いを作る」ためだけの短命セッションを spawn し、
問い自体の生成は LLM 側に委ねる。Director は起動と取り次ぎだけを持つ (原則は不変)。

```
patrol が停滞/失敗を検出
      │  spawn (読み取り専用)
      ▼
 問診セッション ──► POST /v1/director/cases/:id/decisions (Decision Request)
      │                        │
   session-end               Genius
   (回答は待たない)            │
                    proceed / ask_human / self_judge
                                │ ask_human
                                ▼
                   DirectorAskBridge が 1 枚に束ねる
                                ▼
                Discord / Slack / WebUI の質問カード ([A][B] コード付き)
                                ▼
                          人間の回答
                                ▼
              decision へ反映 → step を blocked→active → handoff_note
                                ▼
                   次 tick で patrol が実装セッションを起動
```

## 1. トリガ

patrol の tick 内で、従来 §1.4 の question カードを出していた事由を **問診セッションの
起動事由へ格上げ**する。

| 事由 | 問診に渡す観点 |
|---|---|
| delegation run の失敗 / spawn 失敗 | 失敗原因、再実行か方式変更か、実装指示の修正要否 |
| case 予算 (run 回数) 超過 | 予算引き上げ・case 分割・打ち切りの採否 |
| target_repo が解決できない | どのリポで実装するか、チーム repos の設定漏れ |
| 参照破損 (run 行が無い) | 該当 step の扱い |
| 停滞: 未完了 case に実行可能 step が無い状態が N tick (既定 4 = 約 2 時間) 継続 | 何が足りていないか、次に人間が決めるべきこと |

停滞は本 spec で新設する事由。それ以外は既存事由の置き換えで、**問診セッションの起動に
失敗したときだけ従来の機械文カードへフォールバック**する (人間への通知は落とさない)。

## 2. 起動

- delegation call: `claude-sonnet-5-ask` (env `CONCORDIA_DIRECTOR_ASK_CALL_NAME` で上書き可)
- options: `{ team: <team_id>, goal_and_go: false }` — 自走させない。1 ターンで終わる仕事。
- `triggered_by`: `director-inquiry:<step_id-or-case_id>:<reason>:<UTC YYYY-MM-DD>` を
  日次の冪等キーにする。対象 step が無い停滞では `case_id` を使う。実行前に同じキーを
  `findRunByTriggeredBy` で照会する (patrol §1.3 と同じ方式)。
- `target_repo`: case の解決済みクローン。解決できない事由での起動はチーム既定 repo、
  それも無ければ repo 無しで起動する (問診は読むだけなので repo が無くても成立する)。
- args `task`: case title / goal / step title / handoff_note / task md path / 直近 run の
  status と失敗理由 / 事由 (§1) を束ねた **問診指示**。

## 3. 問診セッションの契約

読み取りと問いかけだけを持つ。session-contract / 既存 deny 述語で次を禁じる。

- リポジトリのファイル編集・commit・push・PR 作成、テスト実行、サービス制御、merge。
- 追加の delegation 起動。

`POST decisions` と、§3.5 の `PATCH steps` による自 case の `handoff_note` 更新だけは、
問いかけのために許可する API 書き込みである。この許可はリポジトリのファイル編集を
許可するものではない。

やること (指示テンプレートに明記する):

1. case / step / handoff_note / task md / 直近 delegation run のログ / 関連 local PR を読む。
2. **人間でなければ決められない点**を 1〜3 件に絞る。実装の細部や調べれば分かることは
   問いにしない (それは実装セッションの持ち場)。
3. 各点を Decision Request として `POST /v1/director/cases/:caseId/decisions` へ送る。
   `kind` は `design` / `priority` / `scope` / `authority`。`options` は必ず 2 件以上、
   自分の推奨を先頭に置く ([[feedback-decision-card-speed-policy]] と同じ並び)。
4. **回答を待たずに session-end する**。回答は ask-bridge が decision へ反映し、step を
   active へ戻すので、問診セッションが生存している必要は無い。
5. 人間の判断が不要だと分かった場合は decision を出さず、判明した事実を
   `handoff_note` へ書いて終わる (`PATCH steps`)。空振りを問いに変換しない。

`authority` / `scope` は director.md §2 のとおり Genius が不在でも `self_judge` へ
降格しない。

## 4. ガード

- 同一 case に **未回答の問診 decision がある間は新規起動しない**。
- 1 tick あたりの問診起動は 1 件 (実装セッションの起動枠とは別枠で数える)。
- 1 case あたりの問診 run は UTC 日付で 3 件まで。同日開始の問診 run を永続記録から
  数え、超えたら従来の機械文カードだけを出す。
- 同一 case × 同一事由は、日付を含む `triggered_by` の照会で日単位に重複抑止する。
  プロセス内状態だけに依存しない。
- 無回答の催促は既存 `discord_pending_questions` の催促に乗せる。本 spec で別の
  タイマーを足さない。

## 5. 非対象

- Cc 側での問い文の生成・補完 (原則どおり行わない)。
- merge / テスト開始 / サービス制御 / push の自動化 (人間・Revisor・Excubitor のまま)。
- plan / decompose 工程の自動起動 (定例と人間の持ち場。patrol §1.2 と同じ)。

## 6. 受け入れ基準

- [ ] patrol の各エスカレーション事由で問診セッションが 1 件だけ起動する (冪等キー検証)。
- [ ] 停滞 (実行可能 step 無しが N tick 継続) で問診セッションが起動する。
- [ ] 問診セッションが送った Decision Request が Genius 経路を通り、`ask_human` の分だけ
      1 枚の質問カードとして Discord / WebUI に出る。
- [ ] 回答すると decision に反映され、step が active へ戻り handoff_note に回答が載る。
- [ ] 起動失敗時は従来の機械文 question カードが出る (通知が消えない)。
- [ ] 問診セッションから編集・commit・テスト・サービス制御が拒否される。
- [ ] workflow toggle `director` を OFF にすると問診も止まる。
