---
type: feature
title: "フェーズ境界コンパクション + コンテキスト残量の可視化"
description: "co-compaction (session-compaction.md、実装済み) の発火点を taskflow の確定イベント (プラン承認・タスク completed・残作業整理) に接続し、再投入文脈を契約・プラン・タスク正本から機械組み立てする。Discord ログを索引付き完全ログとして活かす。加えて /co-context コマンドと RWF アクションでコンテキスト残量をオンデマンド報告する。"
service: concordia
domain: session-coordination
tags:
  - compaction
  - taskflow
  - discord
  - rwf
  - lifecycle
status: planned
related:
  - feature/session-compaction.md
  - feature/session-contract.md
  - feature/plan-gate.md
  - feature/deterministic-teardown.md
updated: 2026-08-13
---

# フェーズ境界コンパクション + コンテキスト残量の可視化

> 2026-08-13 neco 指示。 「タスクがひと段落して次のフェーズへ進むとき」
> 「残作業を確認して片づけるとき」にコンパクションしてコンテキストを再配置する。
> セッションは作り直さない (長期タスク待ち・Discord ログの追いやすさのため)。
> **「不明点は Discord のログをたどればよい」方向で実装を調整する。**

## 0. 位置づけ

session-compaction.md (implemented) の拡張。 `runCompaction` / `estimateContextTokens` /
質問カード基盤は流用し、 (1) 発火点の taskflow 接続、 (2) 再投入文脈の機械組み立て、
(3) 残量可視化の出口 2 つ、 を追加する。 既存 spec は変更しない。

## 1. 発火点 — ヒューリスティックから確定イベントへ

現行の自動コンパクション (session-compaction §5) は「区切りシグナル + soft 閾値」の推測
ベース。 これを taskflow の確定イベントへ直結する:

| trigger source | タイミング | 再投入する文脈 |
|---|---|---|
| `taskflow:plan-approved` | プラン承認 → 実装開始 (設問・設計の対話ログは以後不要) | 契約 + 承認プラン (受け入れ条件) + 最初のタスク |
| `taskflow:next-task` | completed → residual が next-task (in-session 継続時) | 契約 + 次タスク md + 前タスク結果 (PR 番号のみ) |
| `taskflow:residual-sweep` | 残作業確認・片づけフェーズに入るとき | 契約 + 残作業一覧 + 受け入れ条件の充足状況 |

- 実行は既存 `runCompaction` に trigger source を渡すだけ。 クールダウン・作業中ガードは
  現行のまま。
- **境界閾値**: フェーズ境界では `context_pct >= CONCORDIA_PHASE_COMPACT_PCT` (既定 0.35)
  なら compact、 未満なら /clear せず**再配置 inject のみ** (機械組み立て文脈を流すだけ)。
  毎回 clear しない。
- 再キュー既定 (deterministic-teardown §3.2) のセッションはそもそも畳まれるので、 本機能が
  主に効くのは in-session 継続・長期タスク待ち・対話セッションである。

## 2. 再投入文脈の機械組み立て

現行 handoff はセッションの作文が主体。 契約・プラン・taskflow state という構造化正本が
揃ったので、 再投入を三層にする:

1. **機械組み立て層 (決定論)**: Cc が正本から組む — セッション契約 → 現行プラン
   (受け入れ条件含む) → 現在/次タスク → 直近 PR 状態。 LLM の書き漏らしで契約やスコープが
   失われない。
2. **handoff 層 (セッション作文)**: 現行どおりセッション自身に書かせるが、 対象を
   「未解決の論点・注意点・ニュアンス」に限定する (短くてよい)。
3. **参照層 (索引)**: 「不明点はこのチャンネルを遡れ」に加え、 **メッセージリンクの索引**を
   機械で付ける — 契約カード / プラン最新版 / 設問カードの回答 / 直近 handoff への
   jump link。 リンクは Cc が投稿時に記録した message id から組む (探索しない)。

**実装調整の原則**: durable にしたい判断は必ずカードとして Discord に出す。 Cc 内部だけで
完結する判断 (契約更新・プラン承認・teardown 強制) を作らない — ログが正本代わりに遡れる
ことが本方向性の前提のため。

## 3. コンテキスト残量の可視化

推定器 (`estimateContextTokens`) は実装済み。 出口を 2 つ足す:

- **`/co-context`** (slash command): 実行時にその場で推定を叩き直し (10 分 tick の
  キャッシュ値ではなく)、 報告する — 占有トークン / window / **残量 (トークンと %)** /
  前回コンパクション時刻 / 自動発火閾値までの余裕。 末尾に `[いまコンパクションする]`
  ボタン (`/co-compaction` 相当へ直結)。
- **RWF アクション `context`**: RWF エンジンの語彙 (`WORKFLOW_ACTION_HELP`) に追加。
  セッションカード等へのリアクション (絵文字: 🧠) で同じ報告をスレッドへ投稿する。
  rwf-panel の候補には語彙追加だけで自動掲載される。

## 4. 受け入れ基準

- [ ] plan 承認・next-task・residual-sweep の各イベントで境界評価が走り、 閾値以上なら
      compact + 再投入、 未満なら再配置 inject のみが行われる。
- [ ] 再投入文脈の先頭に契約とプラン (受け入れ条件) が機械組み立てで含まれ、 セッション
      作文の欠落に影響されない。
- [ ] 再投入文脈に契約カード・プラン・設問回答への message link 索引が含まれる。
- [ ] `/co-context` がその場の推定で残量を返し、 ボタンからコンパクションを起動できる。
- [ ] RWF `context` リアクションで同内容がスレッドに投稿される。
