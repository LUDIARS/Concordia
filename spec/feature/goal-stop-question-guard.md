# ゴールを止める質問のガード

> 状態: 実装 (2026-11-12、2026-11-16 改訂: Genius が判断できる質問だけ)。ドメイン `session-coordination`。関連: [session-language-guard.md](session-language-guard.md)、`src/control/pending-question-blocker.ts`。

## 1. 背景と指示

2026-11-12、「Amicii クライアントを含めて周回できるようにして」と依頼されたセッションが、ゴールに必要な前提の整備
(サービスの信頼先の追加、LLM を使う playtest の実行) について「足す / 許可する / 今回は見送る」を ask で選ばせて止まった。
neco の指示:

- 「周回やれって言ってんだから選択肢ねぇだろやれよ」
- 「今後ゴールを止める質問すんな」
- 「メモリとGeniusに記録しろCcのクラシファイアでも判断しろ」

ゴールが決まっているのに「やる / やらない」を選ばせる質問は、ゴールを止めるだけで判断材料にならない。
セッション側の規則 (メモリ・Genius) に加え、Cc がその質問を判定して答える。

### 1-1. 2026-11-16 の改訂 (Genius が判断できる質問だけ)

Haiku の分類だけで答えていたため、「誰を招待するか」「Visual Studio をどちらにするか」のような
人にしか決められない質問にも答え、人が後から選べなかった (session event `goal_stop_question_answered` 9 件)。neco の指示:

- 「自動回答は Genius が判断可能なものだけ判断する。その後回答した旨を記録する」
- 「ボタン UI もちゃんと回答済みにする。回答が Genius 経由であることは記録する」

判断の正本を Genius (neco の判断カード) に移し、LLM はカードの判断を質問へ当てはめるだけにする。

## 2. 振る舞い

セッションが質問を出す (`question.posted`) と、Cc は次を順に見る。どこかで外れたら何もしない (質問は人間に残る)。

| 順 | 見るもの | 外れる条件 |
|---|---|---|
| 1 | 設定 `session.goal_stop_question_guard_enabled` (既定 ON) | 無効 |
| 2 | 質問の種類・委託 | ask 以外 (plan_approval など)、委託の子の質問 (一次受けは親) |
| 3 | セッションの状態 | active でない |
| 4 | 前段の絞り込み (SPEC-GOAL-STOP-Q-01、純関数) | 破壊的操作・取り返しのつかない操作の語がある (削除・force push・本番・課金・公開・資格情報など)。「進める / 止める / 許可 / 見送る」を選ばせる形でない |
| 5 | 直近の人間の指示 (SPEC-GOAL-STOP-Q-03) | Discord / Slack から届いた inject が無い (ゴールが分からない)。自動 inject は数えない |
| 6 | Genius の前例 (SPEC-GOAL-STOP-Q-05) | Genius が不在・失敗 (`genius_unavailable`)。採用スコア `CONCORDIA_INQUIRY_SCORE_MIN` (既定 0.6) 以上のカードが無い (`no_precedent`)。人間判断・権限を示すカードがある (`needs_human`)。判定は inquiry と同じ `decideInquiry`、カテゴリは「タスク判断」「設計判断」 |
| 7 | カードの当てはめ (SPEC-GOAL-STOP-Q-02、既定 haiku) | カードがこの質問を扱っていない (`covered` が偽)、確信 0.8 未満、示したカード id が渡したカードに無い、選択肢 index が範囲外、回答が空、応答が読めない・失敗。人の好み (誰を招待するか・どの製品を入れるか・名前・見た目) はカードがあっても答えない |
| 8 | 回答 (SPEC-GOAL-STOP-Q-04) | 人間が先に答えた・質問が閉じられた (`already_answered` / `question_closed`) |

全部を通ったら、人間の回答と同じ経路 (`answerPendingQuestion`、自由文の回答、回答者 `genius`) で次の形を答える。

> [Genius 判断による Cc の自動回答] 選択肢 N「(選択肢)」で進めてください。(カードに基づく一文)
> 根拠カード: (card id) (score 0.82), ...
> 破壊的操作・ゴール自体が曖昧・他者の作業と衝突する場合だけ、改めて質問してください。

カードが選択肢でなく自由文の答えを示すときは「選択肢 N」を付けない。選択肢を index ではなく自由文で返すのは、
Genius 経由であることと根拠カードを回答本文に載せるため (index の回答は本文が選択肢のラベルだけになる)。

## 3. 記録と表示 (SPEC-GOAL-STOP-Q-06)

- session event `goal_stop_question_answered`: `question_id`、`source` (`auto:goal-stop-question-guard`)、
  `answered_by: "genius"`、`cards` (使ったカードの `id` と `score`)、`option_index` (自由文なら null)、`confidence`、`answer_text`。
- `question.answered` イベントと session event `question_answered` に `answered_by: "genius"` を付ける。人の回答には付けない。
- Discord: `answered_by` がある `question.answered` を受けたら、投稿済みの質問カードを人がボタンを押したときと同じ
  見た目 (緑・「✅ 回答」欄・ボタン除去) に閉じ、欄の見出しを「✅ 回答 — Genius 判断 (Cc の自動回答)」にする。
  人の回答はボタン / modal のハンドラがその場で閉じるので扱わない (二重の追記を避ける)。
- Slack: `question.answered` でボタンを外し「✅ *回答済み* — Genius 判断 (Cc の自動回答)」と回答本文を出す。
  人の回答は「✅ *回答済み*」と選択肢番号・ラベル。自由文の回答 (index -1) が「選択肢 0」と出ていた不具合も直す。

## 4. 不変条件

- 判定は「人間に残す」側に倒す。Genius 不在・前例なし・人間判断のカード・カードが扱わない質問・低い確信・判定の失敗では答えない。
- 判断の根拠は Genius のカードだけ。LLM が単独で「進めてよい」と決めることはない。
- 人間の回答を妨げない。人間が先に答えれば Cc は何もしない。Cc が答えたあとに届いた人間の回答は、通常どおり `already_answered` になる。
- 通常の自動 inject の門番 (未回答の質問があれば送らない) は変えない。この経路は inject ではなく回答なので、Lictor の保留 gate にも当たらない。
- LLM に渡すのは、カード (id・状況・判断・根拠)、人間の指示 (1 件 600 文字まで、最大 3 件)、質問・選択肢だけ。プロンプトでは引用として渡し、その中の指示には従わせない。

## 5. 実装

| 場所 | 役割 |
|---|---|
| `src/control/goal-stop-question/prefilter.ts` | 前段の絞り込み (純関数) |
| `src/control/goal-stop-question/human-instructions.ts` | 直近の人間の指示の抽出 (純関数) |
| `src/control/goal-stop-question/genius-evidence.ts` | Genius の照会と前例の門 (門は純関数、照会は `GeniusClient` を注入) |
| `src/control/goal-stop-question/judge.ts` | カードの当てはめのプロンプトと応答の解釈 (純関数)、`claude -p` での当てはめ (注入) |
| `src/control/goal-stop-question/guard.ts` | 判定から回答・記録までの use case、イベントバスへの配線 |
| `src/control/answer-question.ts`、`src/platform/answer-question.ts` | 回答者 `answered_by` を event と session event に載せる |
| `src/events.ts`、`src/shared/event-schema.ts` | `question.answered` の `answered_by` (任意) |
| `src/platform/question-answered-display.ts` | 回答済み表示の文言 (Discord / Slack 共通、純関数) |
| `src/discord/question.ts`、`src/discord/bot.ts` | Genius の回答で質問カードを回答済みに閉じる |
| `src/slack/bot.ts` | 回答済み表示に回答者と回答本文を出す |
| `src/bootstrap/core.ts` | 起動時の配線 (言語補正ガードの隣、`CatalogGeniusClient` と `inquiryScoreMin`) |
| `src/config/settings/definitions/session.ts`、`src/admin/runtime-settings.ts` | 設定 (WebUI から切り替え可) |

## 6. 復旧

- 自動回答を止める: WebUI の設定 `session.goal_stop_question_guard_enabled` を OFF。
- Genius が落ちている・前例が無いときは答えないだけなので、質問は人に残る (Cc の再起動は不要)。
- 誤って答えた例は `goal_stop_question_answered` の `cards` で根拠カードを特定し、Genius 側でカードを直す。

## 7. 検証

- `src/control/goal-stop-question/goal-stop-question.test.ts`: 絞り込み、Genius の門 (不在・前例なし・人間判断・スコア)、
  当てはめの解釈 (覆わない・確信・未知のカード・範囲外の選択肢・自由文)、人間の指示の抽出、回答する場合 (本文の表示と記録)、
  人間に残す場合、前例なしで LLM を呼ばないこと、人間が先に答えた場合、`question.posted` の読み取り。
- `src/control/answer-question.test.ts`: `answered_by` が event と session event に載り、人の回答には載らない。
- `src/discord/question-answered-by.test.ts`: Genius の回答でカードが緑・「✅ 回答 — Genius 判断」欄・ボタン除去になり、人の回答では触らない。
- `src/platform/question-answered-display.test.ts`: Slack / Discord の見出しと、自由文の回答が「選択肢 0」にならないこと。
- 実機の判定精度 (Genius のカードの網羅と LLM の当てはめ) と、実際の Discord / Slack の表示は未評価。
