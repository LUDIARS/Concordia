# ゴールを止める質問のガード

> 状態: 実装 (2026-11-12)。ドメイン `session-coordination`。関連: [session-language-guard.md](session-language-guard.md)、`src/control/pending-question-blocker.ts`。

## 1. 背景と指示

2026-11-12、「Amicii クライアントを含めて周回できるようにして」と依頼されたセッションが、ゴールに必要な前提の整備
(サービスの信頼先の追加、LLM を使う playtest の実行) について「足す / 許可する / 今回は見送る」を ask で選ばせて止まった。
neco の指示:

- 「周回やれって言ってんだから選択肢ねぇだろやれよ」
- 「今後ゴールを止める質問すんな」
- 「メモリとGeniusに記録しろCcのクラシファイアでも判断しろ」

ゴールが決まっているのに「やる / やらない」を選ばせる質問は、ゴールを止めるだけで判断材料にならない。
セッション側の規則 (メモリ・Genius) に加え、Cc がその質問を判定して答える。

## 2. 振る舞い

セッションが質問を出す (`question.posted`) と、Cc は次を順に見る。どこかで外れたら何もしない (質問は人間に残る)。

| 順 | 見るもの | 外れる条件 |
|---|---|---|
| 1 | 設定 `session.goal_stop_question_guard_enabled` (既定 ON) | 無効 |
| 2 | 質問の種類・委託 | ask 以外 (plan_approval など)、委託の子の質問 (一次受けは親) |
| 3 | セッションの状態 | active でない |
| 4 | 前段の絞り込み (SPEC-GOAL-STOP-Q-01、純関数) | 破壊的操作・取り返しのつかない操作の語がある (削除・force push・本番・課金・公開・資格情報など)。「進める / 止める / 許可 / 見送る」を選ばせる形でない |
| 5 | 直近の人間の指示 (SPEC-GOAL-STOP-Q-03) | Discord / Slack から届いた inject が無い (ゴールが分からない)。自動 inject は数えない |
| 6 | LLM 判定 (SPEC-GOAL-STOP-Q-02、既定 haiku) | `goal_blocking` が真で、`goal_ambiguous` / `destructive` / `collides` がすべて偽で、確信 0.8 以上、でなければ外れる。応答が読めない・失敗も外れる |
| 7 | 回答 (SPEC-GOAL-STOP-Q-04) | 人間が先に答えた・質問が閉じられた (`already_answered` / `question_closed`) |

全部を通ったら、人間の回答と同じ経路 (`answerPendingQuestion`、自由文の回答) で次の趣旨を答え、
session event `goal_stop_question_answered` に質問 ID と理由を残す。

> [Cc 判定: ゴールを止める質問] 依頼済みのゴールに向けて自分で進められる内容と判定しました (理由)。
> 推奨案で進め、結果を報告してください。破壊的操作・ゴール自体が曖昧・他者の作業と衝突する場合だけ、改めて質問してください。

## 3. 不変条件

- 判定は「人間に残す」側に倒す。破壊的・曖昧・衝突の気配、判定の失敗、低い確信では答えない。
- 人間の回答を妨げない。人間が先に答えれば Cc は何もしない。Cc が答えたあとに届いた人間の回答は、通常どおり `already_answered` になる。
- 通常の自動 inject の門番 (未回答の質問があれば送らない) は変えない。この経路は inject ではなく回答なので、Lictor の保留 gate にも当たらない。
- LLM に渡すのは、人間の指示 (1 件 600 文字まで、最大 3 件) と質問・選択肢だけ。プロンプトでは引用として渡し、その中の指示には従わせない。

## 4. 実装

| 場所 | 役割 |
|---|---|
| `src/control/goal-stop-question/prefilter.ts` | 前段の絞り込み (純関数) |
| `src/control/goal-stop-question/human-instructions.ts` | 直近の人間の指示の抽出 (純関数) |
| `src/control/goal-stop-question/judge.ts` | LLM のプロンプトと応答の解釈 (純関数)、`claude -p` での判定 (注入) |
| `src/control/goal-stop-question/guard.ts` | 判定から回答までの use case、イベントバスへの配線 |
| `src/bootstrap/core.ts` | 起動時の配線 (言語補正ガードの隣) |
| `src/config/settings/definitions/session.ts`、`src/admin/runtime-settings.ts` | 設定 (WebUI から切り替え可) |

## 5. 検証

- `src/control/goal-stop-question/goal-stop-question.test.ts`: 絞り込み、判定の解釈 (確信・破壊的・曖昧・衝突)、人間の指示の抽出、
  回答する場合と人間に残す場合、人間が先に答えた場合、`question.posted` の読み取り。
- 実機の判定精度 (LLM の応答) は未評価。運用で `goal_stop_question_answered` の記録を見て、誤判定があれば絞り込みを強める。
