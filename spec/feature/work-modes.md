---
type: feature
title: "作業の進め方 (work modes) — 方式の一覧と選び方"
description: "Cc が扱う作業の進め方を 7 方式 (対話・デイリーゴール自走・委託・定期パートタイマー・Director 案件・相談・スプリント) に分け、方式ごとの起点・ゴールの所有者・セッションの形・確認の周期・完了・正本 spec を定義する。スプリントは 2026-10-10 の neco 判断で休止。"
service: concordia
domain: work-modes
tags:
  - work-modes
  - goal-and-go
  - delegation
  - director
  - sprint
status: draft
related:
  - feature/goal-and-go.md
  - feature/daily-goal-run.md
  - feature/delegation.md
  - feature/director.md
  - feature/director-goal-flow.md
  - feature/tech-consultation.md
  - feature/sprint-dialogues.md
  - ux/product.md
updated: 2026-10-10
---

# 作業の進め方 (work modes)

価値: UX-CC-W1/W2/W4、UX-CC-W9。どの仕事がどの進め方で動いているかを取り違えず、
方式ごとのゴール・予算・確認の仕方を混ぜない。

## 背景 (2026-10-10 neco 指示)

> スクラムっぽい動きは今の LUDIARS には合致しない。デイリーでやること (ゴール) 決めて
> 専用セッション自走させ、1 時間おきに確認しながらゴールアンドゴーする仕掛けがいいのかなと思った。
> やり方がいくつか増えたのでドメイン切ってそれぞれのやり方を仕様に定義しよう

進め方は spec ごとに増えてきたが、どれが現役でどれと競合するかを一覧する正本が無かった。
本書がその一覧と選び方の正本である。各方式の中身は方式ごとの spec と domain が持ち、
本書はそれを複製しない。

## 用語

- **方式 (work mode)**: 仕事の起点、ゴールの所有者、セッションの形、確認の周期、完了の決め方の組。
- **ゴールの所有者**: その方式で「何をもって終わりか」を記録している正本。
- **安全予算**: 方式が自走に掛ける上限 (継続回数・時間・run 数など)。

## 方式一覧

| ID | 方式 | 起点 | ゴールの所有者 | セッションの形 | 確認の周期 | 完了 | 正本 spec / domain | 状態 |
|---|---|---|---|---|---|---|---|---|
| WM-1 | 対話 (指示駆動) | 人間の指示 | 人間の指示、明示があればセッション goal (`/co-goal`) | 既存のセッション | 最終回答後 300 秒の Goal & Go | 指示の範囲が終わる | [goal-and-go](goal-and-go.md) / `autonomous-continuation` | 実装済み |
| WM-2 | デイリーゴール自走 | 朝に人間がその日のゴールを確定 | Cc のデイリーゴール (Actio task を参照) | ゴール 1 件につき専用セッション 1 本 | 1 時間ごとの確認 + 確認と確認の間は Goal & Go | ゴール到達 (証跡)、十分にこなした (残りが達成不能か人間判断待ちだけ)、人間の停止 | [daily-goal-run](daily-goal-run.md) / `daily-goal-run` | 実装済み |
| WM-3 | 委託 | 親セッションまたは人間が範囲を渡す | 委託 run (依頼文と契約) | 子セッション (spawn) または call_only | run の状態遷移 | run の完了と成果の照合 | [delegation](delegation.md) / `agent-delegation` ほか `delegation-*` | 実装済み |
| WM-4 | 定期パートタイマー | cron・朝・監視イベント | テンプレートの定型手順 | 短期の委託セッション | なし (1 回で終わる) | 手順の完了報告 | [delegation-parttimer-inject](delegation-parttimer-inject.md) / `parttimer-review-scheduling` | 実装済み |
| WM-5 | Director 案件 | 人間が案件 (case) を起案 | `director_cases` (case/step/decision) | 工程ごとに委託 | step の遷移 | 全 step 完了 | [director](director.md)・[director-goal-flow](director-goal-flow.md) / `director-patrol` | case 正本は実装済み、自動進行は計画 |
| WM-6 | 相談 | 技術相談課への投稿、`/consult` | 相談者の問い | 相談セッション | 相談者の応答 | 相談者が理解した、または終了 | [tech-consultation](tech-consultation.md) / `consultation` | 実装済み |
| WM-7 | スプリント | Actio のスプリント | Actio のスプリント・フェーズ | スプリントごとの相談スレッド | フェーズ遷移 | スプリント終了 | [sprint-dialogues](sprint-dialogues.md) / `sprint-dialogues` | **休止** |

方式ではない補助機能: [curiosity-walk](curiosity-walk.md) (決定を求めない問い)、
[chores](chores.md) (雑務の窓口)、[idle-nudge](idle-nudge.md) / stalled-session nudge
(停止の催促)。これらは方式の中で使われるが、ゴールを持たない。

## 方式の選び方

1. その日のうちに終わらせたい成果が決まっていて、人が張り付かずに進めたい → **WM-2 デイリーゴール自走**。
2. 人が会話しながら進める、または指示が 1 回で済む → **WM-1 対話**。
3. 自分のセッションの一部を別のモデル・別の作業場所へ渡す → **WM-3 委託**。
4. 決まった時刻・イベントに決まった手順を回す → **WM-4 定期パートタイマー**。
5. 複数日にまたがり、分解・委託・レビュー・確認の工程を追う案件 → **WM-5 Director 案件**。
6. 分からないことを聞く、判断の材料がほしい → **WM-6 相談**。
7. スプリントは新しく始めない (下記)。

迷ったら WM-1 で始め、その日のゴールが定まった時点で WM-2 へ移す。

## スプリント (WM-7) の休止

2026-10-10 の neco 判断で、スプリント (計画・実装・受入・振り返り・次計画) を
LUDIARS の進め方としては使わない。

- 新しいスプリントの起動、スプリント会話の新規作成を Cc の既定経路から案内しない。
- 既存の実装 (`src/sprint-dialogues/` ほか) と Actio 側の正本は消さない。削除・移行は別の判断とする。
- 仕事の単位を「その日のゴール」(WM-2) と「案件」(WM-5) に寄せる。

## 不変条件

| ID | 内容 | 主な境界 |
|---|---|---|
| CC-WM-INV-01 | 1 セッションは同時に 1 つの方式に属する。方式を移すときは移す前の方式の状態を閉じてから移す | セッション metadata、方式ごとの起動経路 |
| CC-WM-INV-02 | 方式ごとのゴールの所有者を混ぜない。ある方式のゴールを別の方式の正本へ書き写さない (参照は持ってよい) | goal API / daily goal / director case / Actio sprint |
| CC-WM-INV-03 | ある方式の安全予算を、別の方式の予算や確認で緩和しない。緩和してよい条件は方式の spec に明記したものだけ | goal-and-go / daily-goal-run / director の予算 |
| CC-WM-INV-04 | どの方式も回答待ち (CC-INV-08) と、マージ・テスト・サービス操作の許可境界を変えない | 自動 inject、委託の起動、確認の周期 |

CC-INV-01〜08 は全方式に適用する。

## 受け入れ基準

- [ ] 7 方式すべてに、起点・ゴールの所有者・セッションの形・確認の周期・完了・正本 spec / domain が書かれている。
- [ ] WM-2 の正本 spec と domain が宣言されている。
- [ ] スプリントの休止と、消さないものが明記されている。
- [ ] 方式をまたぐ不変条件が ID 付きで書かれている。

方式をセッションに記録する仕組み (CC-WM-INV-01 の機械的な裏付け) は `src/work-modes/work-mode.ts`
(セッション metadata の `work_mode`)。WM-2 の専用セッションが最初の利用者で、別の方式が active な
セッションへは記録しない。ほかの方式の起動経路への適用は、それぞれの方式を変更するときに入れる。
