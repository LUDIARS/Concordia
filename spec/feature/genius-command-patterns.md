# Genius command-pattern の push 注入

## 背景 / 課題

Memoria のタスク整理、Revisor local PR の提出、マージ処理などの定型作業は、Terra / Sonnet
等の弱いモデルに委託すると手順がばらつく (自前の代替手順を組み立てる・手順を飛ばす)。
既存の対策である skill (genius-judgment / revisor-cc-workflow 等) は **pull 型** で、
モデルが自分で invoke しない限り効かず、弱いモデルほど呼ばない。

2026-08-12 neco 指示: Genius にコマンドパターンを用意し、セッションの依頼内容に一致する
ものは **コマンド内容まで含めて** 処理内容がばらつかないように注入する。

## 方式 (push 型)

1. Genius の統制語彙 `card_categories` に `command-pattern` カテゴリを追加する
   (`POST /api/clone/categories` — 2026-08-12 登録済み)。カードは通常の判断カードと同じ
   形で、`situation` = どの定型作業か、`judgment` = そのまま実行できるコマンド列と
   前提・確認手順、を書く。
2. Concordia の delegation invoke 時 (`delegation/service.ts`)、substitute 済みの
   委託プロンプト全文を `POST /api/clone/query` に categories=["command-pattern"] で照会する
   (`delegation/command-patterns.ts`)。
3. score ≥ `cfg.inquiryScoreMin` (既定 0.6、お伺いの採用基準と同じ) のカードを上位 2 件まで
   採用し、「## コマンドパターン (Genius)」ブロックとして協調コンテキスト
   (`buildDelegationContext`) の作業マニュアル直後に差し込む。
4. 注入文言は「該当作業ではこの手順のコマンドをそのまま使う。状況と矛盾するなら実行せず
   報告して指示を仰ぐ」と明示する (カードは命令だが、矛盾時は fail-loud)。

## fail-soft 原則

Genius 不在 (healthz 不通 / 2 秒予算超過)・カテゴリ未登録 (400)・一致なし・低スコアは
すべて **注入なしで委託を続行** する。委託の成立を Genius の稼働に依存させない。

## 上限

- 照会 k=4、採用は上位 2 件。
- クエリに使う task 文面は先頭 2000 文字。
- 注入ブロック全体は 6000 文字まで (超過分のカードは落とす)。

## 運用

- カードは手動追加 (`POST /api/clone/cards`, category: command-pattern) か ingest の蒸留で
  蓄積する。コマンドを変えたら supersede で置き換える。
- 効果測定は既存の feedback API (great/good/poor/not-in-case) を流用できる。

## 非スコープ

- 非 delegation セッション (人間が対話で開いたセッション) への注入は今回含まない。
  必要になったら session claim (task set) を trigger に同じブロックを inject する拡張で対応する。
