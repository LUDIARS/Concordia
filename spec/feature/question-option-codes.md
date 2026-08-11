# 質問カードの選択肢コード

## 目的

質問カード (pending-question) は 3 経路から答えられる — Discord / Slack のボタン、WebUI、
そしてセッションへ届くテキスト返信。前 2 者は選択肢の index を持つが、テキスト返信は本文しか
持たない。どの選択肢を指しているかを一意に表現できるよう、カードの各選択肢に
`[A]` `[B]` … のコードを表示する。

Lictor はこのコードをテキスト返信から解釈して `answer-question` に index つきで記録する
(`Lictor/spec/feature/ask-marker-text-answer.md`)。

## 規則

- コードは選択肢の並び順から決まる: `0 → A`、`25 → Z`。Z を超えたら 1 始まりの番号にする。
  正本は `src/shared/option-code.ts` (WebUI は表示用の同等実装を `web/src/lib/option-code.ts` に持つ)。
- 表示するのはラベルの直前 — `[A] 文言だけ直す`。description の表示位置は変えない。
- 表示面: Discord (embed フィールド名 / ボタン / セレクトメニュー)、Slack (選択肢行 / ボタン)、
  WebUI (単一選択ボタン / 複数選択チェックボックス)。
- **コードは手がかりであって書式の強制ではない。** 提示された選択肢の外を答える返信も正当な
  回答として自由文で記録される。Concordia 側はコードを検証しない。

## 非対象

- 委託子 → 親セッションの質問リレー本文 (`buildDelegationQuestionRelayText`) は
  `answer_index` を直接指示する API 手順なので、番号表記のままにする。
